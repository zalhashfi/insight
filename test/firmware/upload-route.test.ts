import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  UPLOAD_PERMISSION,
  createFirmwareUploadHandler,
  createFirmwareUploadRoute,
  type FirmwareUploadRouteDeps,
} from "../../worker/src/domains/firmware/upload-route";
import {
  FIRMWARE_CONTENT_TYPE,
  FirmwareUploadService,
  InMemoryFirmwareRepo,
  InMemoryImageStore,
  MAX_FIRMWARE_BYTES,
} from "../../worker/src/domains/firmware/upload";
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

/**
 * Spec tests for the A18 firmware-upload ROUTE (FR-OTA-01, NFR-SEC-03).
 *
 * `upload.ts` is pinned by its own suite; this one covers the *wire* that was
 * missing: the multipart route, its admin+ authorization, and the size gate's
 * `413` surfacing through HTTP.
 *
 *   1. **Upload stored** — a multipart upload returns `201` with the row, and
 *      the exact bytes land at the deterministic key.
 *   2. **>8 MiB → 413** — the size gate refuses and stores nothing.
 *   3. **Member → 403** — uploading is `project:update` (admin or owner).
 *   4. **No session → 401** — the shared admin gate fails closed.
 *   5. **Raw-body shape** — the version header + raw body also work.
 */

const PROJECT = "prj_alpha";
const VERSION = "1.2.0";

const SESSION_OWNER = "sess_owner_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION_ADMIN = "sess_admin_cccccccccccccccccccccccccccc";
const SESSION_MEMBER = "sess_member_bbbbbbbbbbbbbbbbbbbbbbbbbbb";

const SESSIONS: Record<string, CredentialLookupResult> = {
  [SESSION_OWNER]: { kind: "user", userId: "usr_owner", projectId: PROJECT, role: "owner" },
  [SESSION_ADMIN]: { kind: "user", userId: "usr_admin", projectId: PROJECT, role: "admin" },
  [SESSION_MEMBER]: { kind: "user", userId: "usr_member", projectId: PROJECT, role: "member" },
};

const CREDENTIALS = {
  deviceTokens: async () => null,
  sessions: async (session: string) => SESSIONS[session] ?? null,
} as const;

const ROLE_BY_USER: Record<string, Role> = {
  usr_owner: "owner",
  usr_admin: "admin",
  usr_member: "member",
};

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
    if (role === undefined) return null;
    return { projectId, userId, role, createdAt: 0, updatedAt: 0 };
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
  app: Hono;
  store: InMemoryImageStore;
  repo: InMemoryFirmwareRepo;
}

function harness(): Harness {
  const store = new InMemoryImageStore();
  const repo = new InMemoryFirmwareRepo();
  const deps: FirmwareUploadRouteDeps = {
    uploads: new FirmwareUploadService({ store, repo, now: () => 1_700_000_000_000, genId: () => "fw_1" }),
    membership: new MembershipService(new FakeProjectRepo()),
  };
  const admin = new Hono();
  admin.use("/:proj/firmware", resolveAdminProject(CREDENTIALS));
  admin.route("/", createFirmwareUploadRoute({ ...deps }));
  const app = new Hono();
  app.route("/v1/admin/projects", admin);
  return { app, store, repo };
}

function bearer(session: string): Record<string, string> {
  return { authorization: `Bearer ${session}` };
}

function image(bytes: number, seed = 1): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(bytes);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < bytes; i += 1) view[i] = (i * 31 + seed * 7) & 0xff;
  return view;
}

// ---------------------------------------------------------------------------
// 1. A multipart upload is stored at the deterministic key
// ---------------------------------------------------------------------------

describe("POST /v1/admin/projects/:proj/firmware", () => {
  it("stores a multipart upload as 201 with the row and exact bytes", async () => {
    const h = harness();
    const bytes = image(1024);
    const form = new FormData();
    form.set("version", VERSION);
    form.set("file", new Blob([bytes], { type: FIRMWARE_CONTENT_TYPE }), "fw.bin");

    const res = await h.app.request(`/v1/admin/projects/${PROJECT}/firmware`, {
      method: "POST",
      headers: bearer(SESSION_ADMIN),
      body: form,
    });
    expect(res.status).toBe(201);
    const body: { firmware: { version: string; size: number; r2Key: string }; key: string } =
      await res.json();
    expect(body.firmware.version).toBe(VERSION);
    expect(body.firmware.size).toBe(bytes.byteLength);
    expect(body.key).toBe(`firmware/${PROJECT}/${VERSION}.bin`);
    expect(h.store.get(body.key)?.body).toEqual(bytes);
  });

  // -------------------------------------------------------------------------
  // 2. The size gate surfaces as 413 and stores nothing
  // -------------------------------------------------------------------------

  it("refuses a body over 8 MiB with 413 and stores nothing", async () => {
    const h = harness();
    const tooBig = image(MAX_FIRMWARE_BYTES + 1);
    const form = new FormData();
    form.set("version", VERSION);
    form.set("file", new Blob([tooBig]), "big.bin");

    const res = await h.app.request(`/v1/admin/projects/${PROJECT}/firmware`, {
      method: "POST",
      headers: bearer(SESSION_OWNER),
      body: form,
    });
    expect(res.status).toBe(413);
    const body: { error: string } = await res.json();
    expect(body.error).toBe("payload_too_large");
    // Nothing stored: no object, no row.
    expect(h.store.keys()).toEqual([]);
    expect(h.repo.all()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 3 & 4. Authorization
  // -------------------------------------------------------------------------

  it("a member is refused 403 and nothing is stored", async () => {
    const h = harness();
    const form = new FormData();
    form.set("version", VERSION);
    form.set("file", new Blob([image(16)]), "fw.bin");

    const res = await h.app.request(`/v1/admin/projects/${PROJECT}/firmware`, {
      method: "POST",
      headers: bearer(SESSION_MEMBER),
      body: form,
    });
    expect(res.status).toBe(403);
    const body: { error: string } = await res.json();
    expect(body.error).toBe("insufficient_scope");
    expect(h.store.keys()).toEqual([]);
  });

  it("no session is 401 from the shared gate (mounted, not 404)", async () => {
    const h = harness();
    const res = await h.app.request(`/v1/admin/projects/${PROJECT}/firmware`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(404);
  });

  // -------------------------------------------------------------------------
  // 5. The raw-body shape (version header + body) also works
  // -------------------------------------------------------------------------

  it("accepts a raw body with the version in the header", async () => {
    const h = harness();
    const bytes = image(256, 3);
    const res = await h.app.request(`/v1/admin/projects/${PROJECT}/firmware`, {
      method: "POST",
      headers: { ...bearer(SESSION_ADMIN), "x-insight-firmware": VERSION },
      // A raw-body upload: hand the octets as an ArrayBuffer (a BodyInit).
      body: bytes.slice().buffer,
    });
    expect(res.status).toBe(201);
    const body: { key: string } = await res.json();
    expect(h.store.get(body.key)?.body).toEqual(bytes);
  });
});

describe("createFirmwareUploadHandler — the bare handler", () => {
  it("is a function over the same deps the router mounts", () => {
    const store = new InMemoryImageStore();
    const repo = new InMemoryFirmwareRepo();
    const deps: FirmwareUploadRouteDeps = {
      uploads: new FirmwareUploadService({ store, repo }),
      membership: new MembershipService(new FakeProjectRepo()),
    };
    expect(typeof createFirmwareUploadHandler(deps)).toBe("function");
    expect(UPLOAD_PERMISSION).toBe("project:update");
  });
});
