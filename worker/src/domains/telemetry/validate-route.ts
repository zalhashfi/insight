/**
 * Telemetry POST validation route.
 *
 * This route is a thin ADAPTER only. It performs NO validation of its own:
 * every rule (size gate, count gate, key/value gates, JSON parsing) lives in
 * `worker/src/shared/validation.ts` and is reached through `validateTelemetry`.
 * That module is the single source of truth so the route and any other caller
 * can never drift apart.
 *
 * Pipeline (all rules delegated):
 *   1. read the raw request body as text
 *   2. hand it to `validateTelemetry`
 *   3. map the discriminated result onto an HTTP response:
 *        ok   -> 204 No Content
 *        fail -> JSON `{ error, message }` with the result's own status
 *
 * Persistence is intentionally NOT implemented here (that is A08); a
 * successful validation simply acknowledges the request.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import {
  DEFAULT_LIMITS,
  validateTelemetry,
  type TelemetryLimits,
  type ValidTelemetry,
  type ValidationErr,
  type ValidationResult,
} from "../../shared/validation";

/**
 * Error body returned for every rejected payload. `error` carries the shared
 * module's `ValidationErrorCode` verbatim; `message` is its human message.
 */
export interface TelemetryErrorBody {
  error: ValidationErr["code"];
  message: string;
}

/**
 * Named result contract of {@link readTelemetry}. Re-exported so consumers
 * import a stable name instead of deriving it from the function.
 */
export type TelemetryReadResult = ValidationResult<ValidTelemetry>;

/**
 * Read the request body and validate it via the shared module.
 *
 * Returns the discriminated result untouched — success or failure — so the
 * caller decides how to render it. No validation logic is duplicated here.
 *
 * @param c      Hono context whose request body holds the telemetry payload.
 * @param limits Optional limits forwarded verbatim to the shared validator.
 */
export async function readTelemetry(
  c: Context,
  limits: TelemetryLimits = DEFAULT_LIMITS,
): Promise<TelemetryReadResult> {
  const raw = await c.req.text();
  return validateTelemetry(raw, limits);
}

/**
 * Map a failed `ValidationResult` onto a JSON error response.
 *
 * The status and code are taken from the shared result as-is, which keeps the
 * STRICT ordering defined by the shared module observable at the HTTP layer:
 * a payload that violates several rules at once fails with the code (and
 * status) of the earliest rule.
 */
function errorResponse(c: Context, result: ValidationErr): Response {
  const body: TelemetryErrorBody = { error: result.code, message: result.message };
  return c.json(body, result.status as 400 | 413);
}

/**
 * Hono handler that validates a telemetry POST body.
 *
 * On success replies `204 No Content` without persisting anything.
 * On failure replies JSON `{ error, message }` with status 400 or 413.
 */
export async function validateTelemetryHandler(c: Context): Promise<Response> {
  const result = await readTelemetry(c);
  if (!result.ok) return errorResponse(c, result);
  // Accepted — persistence is A08, so we only acknowledge.
  return c.body(null, 204);
}

/**
 * Ready-to-mount Hono app exposing the validated telemetry POST route.
 *
 * Tests mount this on their own app/router; production wiring may mount it at
 * any path (e.g. `app.route("/v1/telemetry", postTelemetryValidated)`).
 */
export const postTelemetryValidated = new Hono();

postTelemetryValidated.post("/", validateTelemetryHandler);
