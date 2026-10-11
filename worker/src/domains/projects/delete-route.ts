/**
 * projects/delete-route — the owner-only project-delete HTTP surface (A23).
 *
 * `domains/projects/delete.ts` owns the *operation*: tombstone-first, resumable,
 * orphan-free. But nothing mounted it — the delete existed as a service with no
 * route and no authorization, so a project could not be deleted through the
 * API at all, and (worse, had a route been added naively) any authenticated
 * caller could have reached it. This module is the missing wire: the route plus
 * the **owner-only** gate that belongs in front of it.
 *
 * ```
 *   DELETE /v1/admin/projects/:proj
 *     → 200 { deleted: DeleteResult }          the project was removed
 *     → 403 { error: "insufficient_scope" }    authenticated, but not the owner
 *     → 404 { error: "project_not_found" }     no such project (already gone)
 * ```
 *
 * ## Authorization: `project:delete`, which is owner-only
 *
 * The route assumes the caller was authenticated upstream by the shared
 * {@link resolveAdminProject} gate (a *user session*, never a device token) and
 * that `:proj` was matched against the session. It then enforces the
 * **capability** the gate deliberately leaves to the handler: the membership
 * table maps `project:delete` to the `owner` role, so an `admin` or `member` is
 * refused `403` through the same permission table every other mutating route
 * uses. Deleting a tenant is the most destructive action in the product; the
 * gate and the permission table are the two locks on that door.
 *
 * ## Idempotent and orphan-free by construction
 *
 * The handler drives {@link ProjectDeleteService.deleteProjectIfPresent}, the
 * idempotent entry: a project already fully deleted (or never existing) is a
 * zeroed result rather than an error, so a retry/redelivery is safe. A project
 * caught mid-delete is *resumed* — every phase of the delete is idempotent
 * (see `delete.ts`), which is exactly what makes "rerun leaves no orphan" hold.
 * Because the operation is resumable, a crash between HTTP receipt and the
 * final phase is repaired by the next call or by a {@link
 * ProjectDeleteService.sweep} pass, not left as residue.
 *
 * ## Nothing here owns storage or a clock
 *
 * The delete service and the membership service are injected, so this module is
 * pure policy over seams and can be pinned without a Worker runtime, a D1
 * binding or a Durable Object.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import {
  isMembershipError,
  type MembershipService,
} from "./membership";
import { isProjectDeleteError, type DeleteResult, type ProjectDeleteService } from "./delete";
import {
  resolveAdminProject,
  type CredentialLookup,
  type Principal,
} from "../../platform/middleware/resolve-project";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The permission deleting a project requires. `project:delete` maps to the
 * `owner` role in the membership table, so this is an owner-only action.
 */
export const DELETE_PERMISSION = "project:delete" as const;

/** Hono context key the upstream admin gate uses to pin the principal. */
export const PRINCIPAL_CONTEXT_KEY = "principal";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** Everything the delete route needs, injectable end-to-end for tests. */
export interface ProjectDeleteRouteDeps {
  /** The delete operation (tombstone-first, resumable). */
  readonly deletes: ProjectDeleteService;
  /** Membership service used for the owner-only (`403`) gate. */
  readonly membership: MembershipService;
}

/** Body of a successful `DELETE /v1/admin/projects/:proj`. */
export interface ProjectDeleteBody {
  readonly deleted: DeleteResult;
}

/** The `{ error, message }` body every rejection carries. */
export interface ProjectDeleteRouteErrorBody {
  readonly error: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** The handler shape, named so a consumer can hold a reference. */
export type ProjectDeleteHandler = (c: Context) => Promise<Response>;

/**
 * Build the `DELETE /:proj` handler.
 *
 * Steps, in order (fail closed):
 *   1. read the pinned principal (missing/wrong kind → `401`);
 *   2. authorize `project:delete` — owner only (member/admin → `403`);
 *   3. delete via the idempotent entry, so a rerun is safe and a resumed
 *      half-delete converges to "gone" with no orphan.
 */
export function createProjectDeleteHandler(
  deps: ProjectDeleteRouteDeps,
): ProjectDeleteHandler {
  return async function projectDeleteHandler(c: Context): Promise<Response> {
    // 1. The principal is pinned upstream by resolveAdminProject. Read it
    //    defensively: a missing principal means the route was mounted without
    //    its gate (a composition mistake), and failing closed is the only safe
    //    answer. A device principal never belongs on this admin surface.
    const principal = c.get(PRINCIPAL_CONTEXT_KEY) as Principal | undefined;
    if (principal === undefined || principal === null || principal.kind !== "user") {
      const body: ProjectDeleteRouteErrorBody = {
        error: "unauthorized",
        message: "a user session is required",
      };
      return c.json(body, 401);
    }

    // 2. Authorization FIRST: the owner gate goes through the shared permission
    //    table, so an admin/member is refused `403` before any destructive work.
    try {
      await deps.membership.assertPermission(
        principal.projectId,
        principal.userId,
        DELETE_PERMISSION,
      );
    } catch (err) {
      if (isMembershipError(err)) {
        if (err.code === "project_not_found") {
          const body: ProjectDeleteRouteErrorBody = {
            error: "project_not_found",
            message: `no project ${principal.projectId}`,
          };
          return c.json(body, 404);
        }
        const body: ProjectDeleteRouteErrorBody = {
          error: "insufficient_scope",
          message: `deleting a project requires the "${DELETE_PERMISSION}" capability (owner only)`,
        };
        return c.json(body, 403);
      }
      throw err;
    }

    // 3. The idempotent entry: an already-gone project is a zeroed result, not
    //    an error; a half-deleted one is resumed to completion. Either way no
    //    orphan remains behind.
    let deleted: DeleteResult;
    try {
      deleted = await deps.deletes.deleteProjectIfPresent(principal.projectId);
    } catch (err) {
      if (isProjectDeleteError(err)) {
        const body: ProjectDeleteRouteErrorBody = {
          error: err.code === "project_not_found" ? "project_not_found" : "invalid_input",
          message: err.message,
        };
        return c.json(body, err.status as 400 | 404);
      }
      throw err;
    }

    const body: ProjectDeleteBody = { deleted };
    return c.json(body, 200);
  };
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

/** Options for {@link createProjectDeleteRoute}. */
export interface ProjectDeleteRouteOptions extends ProjectDeleteRouteDeps {
  /**
   * The credential seam the built-in admin gate uses to resolve a session and
   * pin the principal. Optional: when omitted (the default in tests, where the
   * harness mounts the gate itself) the returned app exposes the handler with
   * no gate. Production supplies it so the route is fail-closed on its own.
   */
  readonly credentials?: CredentialLookup;
}

/**
 * Build a ready-to-mount Hono app exposing `DELETE /:proj`.
 *
 * Mount with `app.route("/v1/admin/projects", createProjectDeleteRoute({...}))`.
 * When {@link ProjectDeleteRouteOptions.credentials} is supplied the shared
 * {@link resolveAdminProject} gate is mounted on the sub-tree first, so a
 * missing/unknown/wrong-kind credential is a fail-closed `401` and a `:proj`
 * claim that contradicts the session is `403` — before the handler runs. When
 * it is omitted the app assumes an upstream gate (the harness supplies one).
 */
export function createProjectDeleteRoute(options: ProjectDeleteRouteOptions): Hono {
  const app = new Hono();
  if (options.credentials !== undefined) {
    app.use(
      "/:proj",
      resolveAdminProject({
        deviceTokens: options.credentials.deviceTokens,
        sessions: options.credentials.sessions,
      }),
    );
  }
  app.delete("/:proj", createProjectDeleteHandler(options));
  return app;
}

export default createProjectDeleteRoute;
