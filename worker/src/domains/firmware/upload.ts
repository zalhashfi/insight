/**
 * firmware/upload — OTA image upload: bytes → object store → `firmware` row.
 *
 * Ticket A18 (FR-OTA-01, NFR-SEC-03). This is the *write* half of OTA: an
 * admin uploads a firmware image for a project, and the platform records what
 * it stored so a later device can be offered it (`GET /v1/ota`, A18b) and
 * stream it back (`GET /v1/ota/image`, A18c). It implements **no HTTP route**;
 * like every other domain module it is a pure service over injected seams, so
 * the upload's rules are pinned by a unit test rather than through `createApp`.
 *
 * ## Two seams, one ordering guarantee
 *
 * The upload touches exactly two external systems, both injected:
 *
 *   * {@link ImageStore} — the object store (R2 in production), one `put`
 *     method, over the image bytes; and
 *   * {@link FirmwareRepo} — the metadata store (D1's `firmware` table in
 *     production), the `firmware` row keyed by `(projectId, version)`.
 *
 * The order is load-bearing and must not be "simplified": validate → put →
 * row. The row is written **only after** the put resolves, so a row can never
 * describe bytes that are not in the store — the reader's rule is that *a row
 * implies a retrievable image*. A put that fails therefore leaves no row
 * (the call throws and the DB is untouched).
 *
 * ## The size gate is first and exact
 *
 * §6.4/§6.5 require a device to check `size == offer.size` before flashing, so
 * the `size` we record MUST be the byte length of the exact object we stored.
 * The gate is therefore the first thing the upload does, and it measures
 * `body.byteLength` — never a `File.size` that a multipart parser might report
 * differently. A body strictly greater than {@link MAX_FIRMWARE_BYTES} (8 MiB)
 * is refused **413** and *nothing* is stored: no object, no row.
 *
 * ## SHA-256 is over the exact stored bytes
 *
 * §6.4's `sha256` is what the device verifies after buffering the downloaded
 * image, so it MUST be the digest of the bytes we put, not of a re-encoded or
 * string-decoded copy. {@link sha256Hex} digests the `ArrayBuffer` view
 * directly and returns **lowercase hex**, exactly 64 characters — the frozen
 * shape of `update.sha256` (`OTA_SHA256_HEX_LENGTH`).
 *
 * ## Determinism: the key is a pure function of `(projectId, version)`
 *
 * {@link firmwareKey} is `firmware/<projectId>/<version>.bin` — no clock, no
 * random — so re-uploading the same version targets the same object and the
 * same row. That makes the upload naturally idempotent and gives it a single
 * documented conflict rule:
 *
 *   * **default — replace.** Same `(projectId, version)` ⇒ the image object is
 *     overwritten and the row is upserted in place. This is the right default
 *     for OTA: a firmware *version string* names immutable content, and
 *     re-uploading it is how an operator recovers from a truncated upload or a
 *     bad build without inventing a new version. It also keeps the device-side
 *     promise honest — a device that checks `size`+`sha256` from an offer will
 *     still find matching bytes at the key.
 *   * **opt-in — conflict.** With `conflict: "reject"` the upload refuses to
 *     clobber an existing version: it throws {@link FirmwareError}
 *     `firmware_exists` (→ **409**) and stores nothing, for callers that would
 *     rather a botched re-upload be loud than silent.
 *
 * Either way the operation is **deterministic**: the same input yields the same
 * key and the same row, and the chosen policy is stated in the result's
 * {@link UploadFirmwareResult.replaced} flag.
 */

// ---------------------------------------------------------------------------
// Limits & key derivation
// ---------------------------------------------------------------------------

/**
 * The largest firmware image accepted, in bytes: **8 MiB** (8 × 1024 × 1024).
 *
 * §6.4/§6.5 buffer the whole image on-device before verifying it, so the
 * ceiling is what a device can hold; 8 MiB is the ticket's limit. A body of
 * exactly this size is accepted — the rule is `size > MAX` → refuse.
 */
export const MAX_FIRMWARE_BYTES = 8 * 1024 * 1024;

/** The fixed, deterministic object-key prefix for every firmware image. */
export const FIRMWARE_KEY_PREFIX = "firmware";

/** The media type of a stored firmware image (spec §6.5). */
export const FIRMWARE_CONTENT_TYPE = "application/octet-stream";

/** The lowercase-hex length of a SHA-256 digest, in characters. */
export const SHA256_HEX_LENGTH = 64;

/** Pattern a recorded `sha256` must match: exactly 64 lowercase hex chars. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The deterministic object key for one version of one project's firmware:
 * `firmware/<projectId>/<version>.bin`.
 *
 * A pure function of its arguments — no clock, no random, no normalisation
 * beyond the caller's already-trimmed inputs — so the upload, the offer
 * (A18b) and the image stream (A18c) all agree on where a version lives
 * without sharing state.
 */
export function firmwareKey(projectId: string, version: string): string {
  return `${FIRMWARE_KEY_PREFIX}/${projectId}/${version}.bin`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable, machine-readable failure codes for the firmware domain. */
export type FirmwareErrorCode =
  | "invalid_input"
  /** The image exceeds {@link MAX_FIRMWARE_BYTES}. */
  | "payload_too_large"
  /** `conflict: "reject"` and the version already exists. */
  | "firmware_exists";

/**
 * Lookup of a {@link FirmwareErrorCode} onto the HTTP status it surfaces as
 * (spec §6.9, `test/contracts/contract-lock.ts`): bad input is `400`, an
 * oversized body is the frozen `413 payload_too_large`, and an existing row is
 * `409`. No route maps these yet (A18 implements no HTTP), but the mapping is
 * the contract the eventual admin route consumes.
 */
export const FIRMWARE_STATUS_CODE: Record<FirmwareErrorCode, number> = {
  invalid_input: 400,
  payload_too_large: 413,
  firmware_exists: 409,
};

/**
 * Error thrown by every failing entry point of this module.
 *
 * Same convention as `devices/metadata.ts` and `projects/membership.ts`:
 * operations throw a typed error with a stable `code` and the HTTP `status` it
 * maps onto, rather than returning a `{ ok:false }` a caller might ignore.
 * {@link code} `payload_too_large` is spelled to match the frozen wire code
 * (`CONTRACT_ERRORS.payload_too_large`), so a route can forward it verbatim.
 */
export class FirmwareError extends Error {
  /** Stable code, also the `error` field a route would emit. */
  readonly code: FirmwareErrorCode;

  /** HTTP status corresponding to {@link code}. */
  readonly status: number;

  constructor(code: FirmwareErrorCode, message: string) {
    super(message);
    this.name = "FirmwareError";
    this.code = code;
    this.status = FIRMWARE_STATUS_CODE[code];
  }
}

/** Convenience guard for `catch` blocks. */
export function isFirmwareError(err: unknown): err is FirmwareError {
  return err instanceof FirmwareError;
}

// ---------------------------------------------------------------------------
// Entities & repository seam
// ---------------------------------------------------------------------------

/**
 * One uploaded firmware image, as recorded in the `firmware` table (spec
 * §5.3).
 *
 * `size` is the byte length of the stored object and `sha256` its lowercase
 * 64-hex digest — together exactly the `size`/`sha256` pair a device verifies
 * against an offer (§6.4/§6.5), so this row is the single source of truth for
 * both. `r2Key` names the stored object, so the row alone is enough to stream
 * the image back without re-deriving the key.
 */
export interface Firmware {
  readonly id: string;
  readonly projectId: string;
  /** Firmware version string, unique within a project. */
  readonly version: string;
  /** Byte length of the stored image — the exact object put. */
  readonly size: number;
  /** Lowercase 64-hex SHA-256 of the stored image bytes. */
  readonly sha256: string;
  /** Object key the image is stored under ({@link firmwareKey}). */
  readonly r2Key: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Storage seam for firmware metadata — D1's `firmware` table in production,
 * an in-memory fake ({@link InMemoryFirmwareRepo}) in tests.
 *
 * Keyed by **`(projectId, version)`**: a version string is unique inside a
 * project but two projects may both ship `1.0.0`, and the tenant is part of
 * the identity so one project can never shadow another's version.
 */
export interface FirmwareRepo {
  /** The `(projectId, version)` row, or `null`. Never another tenant's row. */
  find(projectId: string, version: string): Promise<Firmware | null>;

  /** Insert a new row. Rejects a duplicate `(projectId, version)` (the PK). */
  insert(firmware: Firmware): Promise<Firmware>;

  /** Upsert in place — the replace policy of a re-upload. */
  upsert(firmware: Firmware): Promise<Firmware>;
}

/**
 * Object-store seam: the one non-idempotent operation in an upload.
 *
 * Deliberately a single `put`, mirroring {@link R2Like} in
 * `telemetry/flush.ts`, so an in-memory fake can observe exactly the object
 * under test and a fault-injecting fake can fail the *one* call that matters.
 * The body is the raw image bytes; the key is deterministic
 * ({@link firmwareKey}), so a plain put is an overwrite, not a new object.
 */
export interface ImageStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Options & results
// ---------------------------------------------------------------------------

/** What to do when `(projectId, version)` already exists. */
export type ConflictPolicy =
  /** Overwrite the object and upsert the row (the default; see module docs). */
  | "replace"
  /** Refuse with {@link FirmwareError} `firmware_exists` (409); store nothing. */
  | "reject";

/** The input an upload receives — the bytes plus the two identity fields. */
export interface UploadFirmwareInput {
  readonly projectId: string;
  readonly version: string;
  /**
   * The image bytes. A `Uint8Array` (or any array-like of octets) is accepted
   * and digested/put verbatim; use {@link uploadFirmwareFromBody} to adapt a
   * `Blob`/`ArrayBuffer` request body.
   */
  readonly body: Uint8Array;
}

/** The result of a successful {@link FirmwareUploadService.upload}. */
export interface UploadFirmwareResult {
  /** The persisted row (version, size, sha256, r2Key). */
  readonly firmware: Firmware;
  /** The deterministic key the bytes were stored under. */
  readonly key: string;
  /** True when an existing `(projectId, version)` was overwritten. */
  readonly replaced: boolean;
}

/** Options accepted by {@link FirmwareUploadService}. */
export interface FirmwareUploadServiceOptions {
  /** The object-store seam. Required. */
  readonly store: ImageStore;
  /** The metadata seam. Required. */
  readonly repo: FirmwareRepo;
  /**
   * Conflict behaviour for a re-upload of an existing version. Defaults to
   * `"replace"` (see the module doc for why that is the right OTA default).
   */
  readonly conflict?: ConflictPolicy;
  /** Maximum accepted image size, in bytes. Defaults to {@link MAX_FIRMWARE_BYTES}. */
  readonly maxBytes?: number;
  /** Clock, `Date.now` by default; injected so tests assert timestamps. */
  readonly now?: () => number;
  /** Id seam; defaults to `crypto.randomUUID`. */
  readonly genId?: () => string;
  /**
   * Digest seam; defaults to WebCrypto SHA-256 ({@link sha256Hex}). Injected
   * only so a fake can be deterministic — it must return lowercase 64-hex.
   */
  readonly sha256?: (bytes: Uint8Array) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const HEX = "0123456789abcdef";

/**
 * Lowercase hex of a byte array — the SAME encoding `platform/lib/tokens.ts`
 * uses for `token_hash`, so every digest in the system reads the same way.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += HEX[(bytes[i] >> 4) & 0xf] + HEX[bytes[i] & 0xf];
  }
  return out;
}

/**
 * SHA-256 of `bytes` as lowercase hex — the digest recorded in `firmware.sha256`
 * and returned in an OTA offer.
 *
 * Digests the bytes verbatim: the argument is the exact octet sequence that is
 * put to the store, so the device's post-download check compares like for like.
 * Deterministic by construction (same bytes ⇒ same digest), which is what makes
 * a re-upload's row and object consistent.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Pass the exact octet range, never the whole backing buffer: a `Uint8Array`
  // may be a view (byteOffset/length) into a larger one, and digesting the
  // buffer would hash bytes we do not store. Copy into a plain `ArrayBuffer` so
  // the `BufferSource` is unambiguous (a view's `buffer` is `ArrayBufferLike`).
  const view = new Uint8Array(bytes).slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Adapt a `Blob`/`ArrayBuffer` upload body to the `Uint8Array` the service
 * takes, so a route can hand over `await c.req.blob()`/`.arrayBuffer()`
 * without a cast at the call site. A `Uint8Array` passes through untouched
 * (same reference), so a caller that already holds one pays no copy.
 */
export async function uploadFirmwareFromBody(
  body: Blob | ArrayBuffer | Uint8Array,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await body.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * The firmware-upload use case: validate → digest → put → row.
 *
 * Stateless apart from its injected seams; every method is async and follows
 * the throw-on-failure convention at the top of this file.
 */
export class FirmwareUploadService {
  readonly #store: ImageStore;
  readonly #repo: FirmwareRepo;
  readonly #conflict: ConflictPolicy;
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #genId: () => string;
  readonly #sha256: (bytes: Uint8Array) => Promise<string>;

  constructor(options: FirmwareUploadServiceOptions) {
    this.#store = options.store;
    this.#repo = options.repo;
    this.#conflict = options.conflict ?? "replace";
    this.#maxBytes = options.maxBytes ?? MAX_FIRMWARE_BYTES;
    this.#now = options.now ?? (() => Date.now());
    this.#genId = options.genId ?? (() => crypto.randomUUID());
    this.#sha256 = options.sha256 ?? sha256Hex;
  }

  /**
   * Upload one firmware image.
   *
   * Order (each step's failure leaves the store and the DB untouched):
   *   1. validate `projectId`/`version`/`body` and enforce the size gate;
   *   2. resolve an existing `(projectId, version)` and, under `"reject"`,
   *      refuse it;
   *   3. **put** the bytes under the deterministic key;
   *   4. **only then** insert/upsert the `firmware` row.
   *
   * @throws {FirmwareError} `invalid_input` (400) for a blank project/version;
   *         `payload_too_large` (413) when the body exceeds the limit;
   *         `firmware_exists` (409) under `conflict: "reject"`.
   */
  async upload(input: UploadFirmwareInput): Promise<UploadFirmwareResult> {
    const projectId = input.projectId?.trim();
    if (!projectId) throw new FirmwareError("invalid_input", "projectId is required");

    const version = input.version?.trim();
    if (!version) throw new FirmwareError("invalid_input", "version is required");

    if (!(input.body instanceof Uint8Array)) {
      throw new FirmwareError("invalid_input", "body must be a Uint8Array of image bytes");
    }
    const body = input.body;

    // --- Step 1: the size gate — FIRST, and before anything is stored -------
    if (body.byteLength > this.#maxBytes) {
      throw new FirmwareError(
        "payload_too_large",
        `firmware image is ${body.byteLength} bytes, limit is ${this.#maxBytes}`,
      );
    }

    const key = firmwareKey(projectId, version);

    // --- Step 2: conflict resolution (still before any write) --------------
    const existing = await this.#repo.find(projectId, version);
    if (existing !== null && this.#conflict === "reject") {
      throw new FirmwareError(
        "firmware_exists",
        `firmware ${projectId}/${version} already exists (conflict policy "reject")`,
      );
    }

    // --- Step 3: digest the exact bytes, then put them ---------------------
    const sha256 = await this.#sha256(body);
    await this.#store.put(key, body, FIRMWARE_CONTENT_TYPE);

    // --- Step 4: the row, only now that the object is durable --------------
    const at = this.#now();
    const row: Firmware = {
      id: existing?.id ?? this.#genId(),
      projectId,
      version,
      size: body.byteLength,
      sha256,
      r2Key: key,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    const firmware =
      existing === null ? await this.#repo.insert(row) : await this.#repo.upsert(row);

    return { firmware, key, replaced: existing !== null };
  }
}

// ---------------------------------------------------------------------------
// In-memory fakes — honest implementations of the seams for tests & local dev
// ---------------------------------------------------------------------------

/** One object in {@link InMemoryImageStore}: its bytes plus the metadata. */
export interface StoredImage {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

/**
 * In-memory {@link ImageStore}.
 *
 * Honest about the one property the upload relies on: a `put` to an existing
 * key **overwrites** (it never appends), so a re-upload of a version is
 * observable as a replacement, and `puts` records every call in order so a test
 * can assert how many attempts were made (including ones that threw).
 */
export class InMemoryImageStore implements ImageStore {
  readonly #objects = new Map<string, StoredImage>();
  /** Every put attempt in call order: `{ key, bytes }`. */
  readonly puts: { key: string; bytes: number }[] = [];
  #fault: Error | null = null;

  /** Program the *next* `put` to throw, then clear itself. */
  failNext(error?: Error): void {
    this.#fault = error ?? new Error("injected put failure");
  }

  /** The object stored under `key`, or `undefined`. */
  get(key: string): StoredImage | undefined {
    return this.#objects.get(key);
  }

  /** The keys currently held, in insertion order. */
  keys(): string[] {
    return [...this.#objects.keys()];
  }

  /** {@link ImageStore.put}: records the attempt, honours a fault, stores bytes. */
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.puts.push({ key, bytes: body.byteLength });
    if (this.#fault !== null) {
      const error = this.#fault;
      this.#fault = null;
      throw error;
    }
    // Copy on write so a caller mutating its buffer later cannot change what
    // was stored — R2 durably keeps the bytes it was handed.
    this.#objects.set(key, { key, body: Uint8Array.from(body), contentType });
  }
}

/**
 * In-memory {@link FirmwareRepo}.
 *
 * Keyed by `(projectId, version)` with the NUL separator the membership fake
 * uses (a NUL never appears in a normalised id), so the tenant is part of the
 * key and one project cannot read another's version. `insert` rejects a
 * duplicate key (models the PK); `upsert` overwrites in place.
 */
export class InMemoryFirmwareRepo implements FirmwareRepo {
  readonly #byKey = new Map<string, Firmware>();

  /** Every stored row, insertion-ordered. */
  all(): readonly Firmware[] {
    return Array.from(this.#byKey.values());
  }

  async find(projectId: string, version: string): Promise<Firmware | null> {
    return this.#byKey.get(InMemoryFirmwareRepo.#key(projectId, version)) ?? null;
  }

  async insert(firmware: Firmware): Promise<Firmware> {
    const key = InMemoryFirmwareRepo.#key(firmware.projectId, firmware.version);
    if (this.#byKey.has(key)) {
      throw new Error(
        `InMemoryFirmwareRepo: duplicate firmware ${firmware.projectId}/${firmware.version}`,
      );
    }
    this.#byKey.set(key, firmware);
    return firmware;
  }

  async upsert(firmware: Firmware): Promise<Firmware> {
    this.#byKey.set(InMemoryFirmwareRepo.#key(firmware.projectId, firmware.version), firmware);
    return firmware;
  }

  static #key(projectId: string, version: string): string {
    return `${projectId}\u0000${version}`;
  }
}
