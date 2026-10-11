/**
 * Spec tests for R-W1 — the admin device-import route (A34 / FR-DEV-06) and its
 * byte-size cap.
 *
 * Two layers are exercised, matching the acceptance criteria:
 *
 *   1. **The route in `createApp`** — an import request flows through the
 *      COMPOSED app to the real {@link DeviceImportService} and creates devices
 *      in the injected repo. The route is admin-gated: no session → `401`, a
 *      `member` session → `403`, an admin/owner → `200`. A `:proj` claim that
 *      contradicts the session is `403` (the shared gate).
 *   2. **The byte-size cap** — a payload over `maxBytes` is refused `413`
 *      BEFORE it is lexed, so a huge upload is never walked. This is asserted
 *      both through the service (the parse is never entered) and through the
 *      composed route (the wire status is `413`).
 *
 * The membership/credential fixtures mirror `manual-run.test.ts`, so the admin
 * gate is exercised exactly as production mounts it.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { createApp, type App, type AppDeps } from "../../worker/src/app";
import { createDeviceImportRoute, IMPORT_PERMISSION } from "../../worker/src/domains/devices/import-route";
import {
  DEFAULT_IMPORT_LIMITS,
  DeviceImportError,
  DeviceImportService,
  isDeviceImportError,
} from "../../worker/src/domains/devices/import";
import { byteLength } from "../../worker/src/shared/validation";
import {
  DeviceMetadataService,
  InMemoryDeviceRepo,
  InMemoryMembershipLookup,
  type DeviceRepo,
} from "../../worker/src/domains/devices/metadata";
import {
  MembershipService,
  type ProjectMember,
  type ProjectRepo,
  type Role,
} from "../../worker/src/domains/projects/membership";
import {
  resolveAdminProject,
  type CredentialLookupResult,
} from "../../worker/src/platform/middleware/resolve-project";

// ---------------------------------------------------------------------------
// Fixtures — one project, three roles, a real import service over a real repo
// ---------------------------------------------------------------------------

const PROJECT = "prj_alpha";
const FOREIGN_PROJECT = "prj_beta";

const SESSION_OWNER = "sess_owner_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION_ADMIN = "sess_admin_cccccccccccccccccccccccccccc";
const SESSION_MEMBER = "sess_member_bbbbbbbbbbbbbbbbbbbbbbbbbbb";

const ROLE_BY_USER: Record<string, Role> = {
  usr_owner: "owner",
  usr_admin: "admin",
  usr_member: "member",
};

/** Session token → the user principal it authenticates. */
const SESSIONS: Record<string, CredentialLookupResult> = {
  [SESSION_OWNER]: { kind: "user", userId: "usr_owner", projectId: PROJECT, role: "owner" },
  [SESSION_ADMIN]: { kind: "user", userId: "usr_admin", projectId: PROJECT, role: "admin" },
  [SESSION_MEMBER]: { kind: "user", userId: "usr_member", projectId: PROJECT, role: "member" },
};

/** The credential seam the shared admin gate consults (sessions only). */
const CREDENTIALS = {
  deviceTokens: async () => null,
  sessions: async (session: string) => SESSIONS[session] ?? null,
} as const;

/** Minimal in-memory project repo: only `getProject`/`getMember` matter here. */
class FakeProjectRepo implements ProjectRepo {
  async createProject(): Promise<never> {
    throw new Error("not used");
  }
  async getProject(projectId: string) {
    return projectId === PROJECT
      ? { id: projectId, name: projectId, slug: projectId, ownerId: "usr_owner", createdAt: 0, updatedAt: 0 }
      : null;
  }
  async getMember(projectId: string, userId: string): Promise<ProjectMember | null> {
    if (projectId !== PROJECT) return null;
    const role = ROLE_BY_USER[userId];
    return role === undefined ? null : { projectId, userId, role, createdAt: 0, updatedAt: 0 };
  }
  async listMembers(): Promise<ProjectMember[]> {
    return [];
  }
  async addMember(): Promise<never> {
    throw new Error("not used");
  }
  async removeMember(): Promise<boolean> {
    throw new Error("not used");
  }
}

interface Harness {
  readonly app: App;
  readonly repo: DeviceRepo;
  readonly imports: DeviceImportService;
  readonly membership: MembershipService;
}

/**
 * Compose the whole app with the A34 route wired exactly as a deploy wires it:
 * the `m3.deviceImport` group supplies the real import service and the shared
 * admin gate. Everything else is the bare M1 minimum, so a failure here is
 * about the import wiring and nothing else.
 */
function harness(limits?: { maxBytes?: number; maxRows?: number }): Harness {
  const repo: DeviceRepo = new InMemoryDeviceRepo();
  let seq = 0;
  const devices = new DeviceMetadataService(repo, {
    membership: new InMemoryMembershipLookup().grant(PROJECT, "usr_admin", "admin"),
    now: () => 1_700_000_000_000,
    genId: () => `d_${++seq}`,
  });
  const imports = new DeviceImportService(
    devices,
    limits !== undefined ? { limits } : {},
  );
  const membership = new MembershipService(new FakeProjectRepo());

  const app = createApp({
    deviceTokens: async () => null,
    sessions: CREDENTIALS.sessions,
    ingest: {
      verifyToken: async () => null,
      sink: { record: async () => undefined },
      devices: { register: () => undefined, has: () => false },
    },
    query: {
      credentials: async () => null,
      projects: { state: async () => [] },
      shards: { ring: async () => [] },
    },
    m3: {
      deviceImport: { deps: { imports, membership }, credentials: CREDENTIALS },
    },
  } as AppDeps);

  return { app, repo, imports, membership };
}

/** POST a body to the import path with a session bearer. */
function importRequest(
  app: App,
  body: string,
  options: { session?: string; query?: string; contentType?: string; contentLength?: string } = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(`/v1/admin/projects/${PROJECT}/devices/import${options.query ?? ""}`, {
      method: "POST",
      headers: {
        "content-type": options.contentType ?? "text/csv",
        ...(options.contentLength !== undefined ? { "content-length": options.contentLength } : {}),
        ...(options.session !== undefined ? { Authorization: `Bearer ${options.session}` } : {}),
      },
      body,
    }),
  );
}

const CSV = "name,model\nPump A,PX-1\nPump B,PX-2\n";

// ---------------------------------------------------------------------------
// 1. The route is MOUNTED and admin-gated
// ---------------------------------------------------------------------------

describe("POST /v1/admin/projects/:proj/devices/import — mounted + gated", () => {
  it("is mounted (not a 404): an anonymous POST is refused 401 by the gate", async () => {
    const { app } = harness();
    const res = await importRequest(app, CSV);
    expect(res.status).toBe(401);
    // The gate's own body — proving the route exists and the gate ran.
    expect(((await res.json()) as { error: string }).error).toBe("missing_credential");
  });

  it("an unknown session is 401 (fail closed)", async () => {
    const res = await importRequest(harness().app, CSV, { session: "sess_nope" });
    expect(res.status).toBe(401);
  });

  it("a member session authenticates but is refused 403 (needs project:update)", async () => {
    const { app, repo } = harness();
    const res = await importRequest(app, CSV, { session: SESSION_MEMBER });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
    // Nothing was written: the gate precedes the body read.
    expect(await repo.listByProject(PROJECT)).toEqual([]);
  });

  it("an admin session imports and the response reports the created devices", async () => {
    const { app } = harness();
    const res = await importRequest(app, CSV, { session: SESSION_ADMIN });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: { name: string }[]; failed: unknown[] };
    expect(body.created).toHaveLength(2);
    expect(body.failed).toEqual([]);
    expect(body.created.map((d) => d.name)).toEqual(["Pump A", "Pump B"]);
  });

  it("owner session also imports (project:update tier)", async () => {
    const res = await importRequest(harness().app, CSV, { session: SESSION_OWNER });
    expect(res.status).toBe(200);
  });

  it("a :proj claim that contradicts the session is 403 (shared gate)", async () => {
    const { app } = harness();
    const res = await app.request(`/v1/admin/projects/${FOREIGN_PROJECT}/devices/import`, {
      method: "POST",
      headers: { "content-type": "text/csv", Authorization: `Bearer ${SESSION_ADMIN}` },
      body: CSV,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("project_mismatch");
  });

  it("a device token is a wrong-kind credential for this admin surface (401)", async () => {
    // A token that resolves to a device principal must never authenticate here.
    const { app } = harness();
    const res = await app.request(`/v1/admin/projects/${PROJECT}/devices/import`, {
      method: "POST",
      headers: { "content-type": "text/csv", Authorization: "Bearer pt_device_token" },
      body: CSV,
    });
    // The sessions resolver returns null for it → invalid_credential (401).
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 2. An import request CREATES DEVICES through the composed app
// ---------------------------------------------------------------------------

describe("device import through the composed app creates devices", () => {
  it("creates each CSV row in the injected repo (indistinguishable from a create)", async () => {
    const { app, repo } = harness();
    const res = await importRequest(app, CSV, { session: SESSION_ADMIN });
    expect(res.status).toBe(200);

    const stored = await repo.listByProject(PROJECT);
    expect(stored.map((d) => d.name)).toEqual(["Pump A", "Pump B"]);
    // Every stored row is a COMPLETE record — the "no partial device" rule.
    for (const d of stored) {
      expect(d.id).toBeTruthy();
      expect(d.key).toBeTruthy();
      expect(d.projectId).toBe(PROJECT);
      expect(d.status).toBe("active");
    }
  });

  it("honours an explicit ?format=json and imports the array", async () => {
    const { app, repo } = harness();
    const body = JSON.stringify([{ name: "Sensor 1" }, { name: "Sensor 2" }]);
    const res = await importRequest(app, body, {
      session: SESSION_ADMIN,
      query: "?format=json",
      contentType: "application/json",
    });
    expect(res.status).toBe(200);
    expect((await repo.listByProject(PROJECT)).map((d) => d.name)).toEqual([
      "Sensor 1",
      "Sensor 2",
    ]);
  });

  it("reports per-row failures without aborting the good rows (200)", async () => {
    const { app, repo } = harness();
    const body = "name,status\nGood,active\nBad,archived\n";
    const res = await importRequest(app, body, { session: SESSION_ADMIN });
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { created: { name: string }[]; failed: { code: string }[] };
    expect(parsed.created.map((d) => d.name)).toEqual(["Good"]);
    expect(parsed.failed).toHaveLength(1);
    expect(parsed.failed[0].code).toBe("unknown_status");
    expect((await repo.listByProject(PROJECT)).map((d) => d.name)).toEqual(["Good"]);
  });

  it("an unusable explicit ?format= is 400, not a silent CSV fallback", async () => {
    const res = await importRequest(harness().app, CSV, {
      session: SESSION_ADMIN,
      query: "?format=xml",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_format");
  });
});

// ---------------------------------------------------------------------------
// 3. The byte-size cap — checked BEFORE parsing, 413 on oversize
// ---------------------------------------------------------------------------

describe("import byte-size cap", () => {
  it("refuses a body over maxBytes with 413 through the composed route", async () => {
    const { app, repo } = harness({ maxBytes: 64 });
    const huge = `name\n${"x".repeat(200)}\n`;
    const res = await importRequest(app, huge, { session: SESSION_ADMIN });

    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("payload_too_large");
    // Nothing was written — the body was never even lexed.
    expect(await repo.listByProject(PROJECT)).toEqual([]);
  });

  it("the size gate runs BEFORE lexing (a body that would otherwise parse)", async () => {
    // A deliberately tiny cap with a WELL-FORMED CSV that exceeds it: if the
    // gate were after parsing, this would succeed; it must be 413.
    const { app } = harness({ maxBytes: 12 });
    const res = await importRequest(app, "name\nAlpha\nBeta\n", { session: SESSION_ADMIN });
    expect(res.status).toBe(413);
  });

  it("refuses an oversized declared Content-Length BEFORE buffering the body (413)", async () => {
    // A small body but a declared length over the limit: the route refuses on
    // the header alone, so a client cannot make the runtime buffer an oversized
    // body under a cap that only runs after buffering. A well-formed small CSV is
    // sent so that, absent the pre-check, the import would SUCCEED.
    const { app, repo } = harness({ maxBytes: 64 });
    const res = await importRequest(app, CSV, {
      session: SESSION_ADMIN,
      contentLength: String(1024 * 1024),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("payload_too_large");
    expect(await repo.listByProject(PROJECT)).toEqual([]);
  });

  it("accepts a declared Content-Length within the limit (the pre-check is not over-eager)", async () => {
    const { app } = harness();
    const res = await importRequest(app, CSV, {
      session: SESSION_ADMIN,
      contentLength: String(CSV.length),
    });
    expect(res.status).toBe(200);
  });

  it("the service throws payload_too_large (413) and never enters the parser", async () => {
    const repo = new InMemoryDeviceRepo();
    const devices = new DeviceMetadataService(repo, {
      membership: new InMemoryMembershipLookup(),
      genId: () => "d_1",
    });
    const importer = new DeviceImportService(devices, { limits: { maxBytes: 8 } });

    try {
      await importer.importDevices({ projectId: PROJECT, data: "name\n".repeat(50), format: "csv" });
      throw new Error("expected a throw");
    } catch (err) {
      expect(isDeviceImportError(err)).toBe(true);
      expect((err as DeviceImportError).code).toBe("payload_too_large");
      expect((err as DeviceImportError).status).toBe(413);
    }
    expect(await repo.listByProject(PROJECT)).toEqual([]);
  });

  it("a body at exactly maxBytes is accepted (boundary is inclusive)", async () => {
    const repo = new InMemoryDeviceRepo();
    const devices = new DeviceMetadataService(repo, {
      membership: new InMemoryMembershipLookup(),
      genId: () => "d_1",
    });
    const data = "name\nAlpha\n"; // 12 bytes
    const importer = new DeviceImportService(devices, { limits: { maxBytes: byteLength(data) } });
    const result = await importer.importDevices({ projectId: PROJECT, data, format: "csv" });
    expect(result.created).toHaveLength(1);
  });

  it("the default cap is documented as 8 MiB", () => {
    expect(DEFAULT_IMPORT_LIMITS.maxBytes).toBe(8 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// 4. The isolated route (harness mounts the gate itself, like manual-run)
// ---------------------------------------------------------------------------

describe("createDeviceImportRoute — mounted behind its own gate", () => {
  function isolated() {
    const repo = new InMemoryDeviceRepo();
    const devices = new DeviceMetadataService(repo, {
      membership: new InMemoryMembershipLookup(),
      genId: () => "d_1",
    });
    const imports = new DeviceImportService(devices);
    const membership = new MembershipService(new FakeProjectRepo());

    const admin = new Hono();
    admin.use("/:proj/devices/import", resolveAdminProject(CREDENTIALS));
    admin.route(
      "/",
      createDeviceImportRoute({ imports, membership, credentials: CREDENTIALS }),
    );
    const app = new Hono();
    app.route("/v1/admin/projects", admin);
    return { app, repo };
  }

  it("an admin import lands a device (route + gate self-contained)", async () => {
    const { app, repo } = isolated();
    const res = await app.request(`/v1/admin/projects/${PROJECT}/devices/import`, {
      method: "POST",
      headers: { "content-type": "text/csv", Authorization: `Bearer ${SESSION_ADMIN}` },
      body: "name\nSolo\n",
    });
    expect(res.status).toBe(200);
    expect((await repo.listByProject(PROJECT)).map((d) => d.name)).toEqual(["Solo"]);
  });

  it("exposes the permission it enforces as a stable constant", () => {
    expect(IMPORT_PERMISSION).toBe("project:update");
  });
});

// ---------------------------------------------------------------------------
// 5. assertDeps — a malformed group fails loudly at composition
// ---------------------------------------------------------------------------

describe("createApp assertDeps — the deviceImport group", () => {
  const base = {
    deviceTokens: async () => null,
    sessions: async () => null,
    ingest: {
      verifyToken: async () => null,
      sink: { record: async () => undefined },
      devices: { register: () => undefined, has: () => false },
    },
    query: {
      credentials: async () => null,
      projects: { state: async () => [] },
      shards: { ring: async () => [] },
    },
  } as unknown as AppDeps;

  it("throws when the import service is not callable", () => {
    expect(() =>
      createApp({
        ...base,
        m3: {
          deviceImport: {
            deps: { imports: {} as never, membership: {} as never },
            credentials: CREDENTIALS,
          },
        },
      } as AppDeps),
    ).toThrow(TypeError);
  });

  it("throws when the credential seam is missing", () => {
    expect(() =>
      createApp({
        ...base,
        m3: {
          deviceImport: {
            deps: { imports: new DeviceImportService({} as never), membership: {} as never },
            credentials: {} as never,
          },
        },
      } as AppDeps),
    ).toThrow(TypeError);
  });
});
