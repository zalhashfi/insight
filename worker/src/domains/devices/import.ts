/**
 * devices/import — bulk device provisioning from CSV or JSON (FR-DEV-06, A34).
 *
 * A field engineer arrives with a spreadsheet, not with an API client: a
 * hundred devices to enrol before a rollout. This module turns that sheet (or
 * an equivalent JSON array) into device records through the SAME
 * {@link DeviceMetadataService} that a single `POST` uses, so an imported
 * device is indistinguishable from a hand-created one — same lifecycle
 * vocabulary, same normalisation, same tenant scoping, no second write path.
 *
 * ── The acceptance rule: "no partial device" ───────────────────────────────
 * The ticket fixes two things at once — *failed rows are reported with a
 * reason*, and *no partial device exists*. Those are reconciled here by making
 * the unit of atomicity the ROW, not the file:
 *
 *   * a row is **validated in full, in memory, before any write** — so a row
 *     that would fail never reaches storage at all;
 *   * valid rows commit through {@link DeviceMetadataService.createDevice},
 *     whose insert is one atomic step on the repo (a duplicate id fails the
 *     whole insert, never half a record);
 *   * therefore a device either fully exists or was reported failed; there is
 *     no state in which a device has been half-written.
 *
 * This is *per-row skip*, and it is deliberate: a single typo on row 137 of a
 * 500-row sheet must not discard the 499 correct rows. It is also
 * *deterministic*: rows commit in source order, and an id must be unique
 * across BOTH the file and the project, so there is no "which duplicate won"
 * ambiguity (see {@link DeviceImportResult}).
 *
 * ── Cross-row references must not dangle ───────────────────────────────────
 * A row may name the id it will be stored under. Two rows naming the SAME id
 * would collide in the database, so the FIRST occurrence commits and every
 * later one is reported `duplicate_id` — a deterministic, source-order winner
 * rather than a race. Because ids settle exactly once, an explicit id can
 * never disagree with itself afterwards, so there is no cross-row check to
 * defer and the whole batch is validated before it is committed.
 *
 * ── Format handling ────────────────────────────────────────────────────────
 * Both formats are read into ONE intermediate representation — an ordered list
 * of `{ row, values }` — and then run through ONE validator
 * ({@link normaliseDeviceInput}). The format layer therefore owns only
 * *lexing*; every business rule (required fields, the lifecycle vocabulary,
 * duplicate policy, tenant scoping) lives in exactly one place and cannot
 * drift between the CSV and JSON paths.
 *
 *   * **JSON** — an array of objects, or `{ devices: [...] }`. Unknown keys are
 *     ignored; a non-object element is reported with its 1-based index.
 *   * **CSV** — a header row names the columns; each data row is a record.
 *     RFC 4180 quoting is honoured (see {@link parseCsv}): comma/semicolon/
 *     newline inside quotes, `""` for an embedded quote, and CRLF or bare LF
 *     line endings. A BOM is stripped. The separator is sniffed from the
 *     header (tab and `;` are common in exported sheets), and the column names
 *     are matched case-insensitively with a few friendly aliases.
 *
 * ── Reporting ──────────────────────────────────────────────────────────────
 * The result is a {@link DeviceImportResult}: the created devices (in source
 * order) plus one {@link DeviceImportFailure} per rejected row carrying the
 * row/bookkeeping number and a stable, machine-readable reason. The row is
 * reported with a reason, and nothing about it is written.
 */

import {
  DeviceMetadataService,
  isDeviceError,
  isDeviceStatus,
  normaliseOptional,
  type CreateDeviceInput,
  type Device,
  type DeviceStatus,
} from "./metadata";
import { byteLength } from "../../shared/validation";

// ---------------------------------------------------------------------------
// Options & limits
// ---------------------------------------------------------------------------

/**
 * Tunable limits for an import. All three are *resource* guards, not storage
 * limits: they bound the work a single request may do — the bytes it may lex
 * (`maxBytes`), the rows it may process (`maxRows`) and the size of the report
 * it returns (`maxMessageLength`) — so one oversized sheet cannot pin the
 * worker. A body over `maxBytes` is refused before lexing; a batch over
 * `maxRows` is refused wholesale (`too_many_rows`) — a half-imported sheet is
 * less useful than a clear "split this file" answer.
 */
export interface DeviceImportLimits {
  /**
   * Maximum byte length (UTF-8) of one import body. This is a *lexing* guard,
   * checked against `input.data` BEFORE any parsing, so a huge upload is
   * refused (`payload_too_large`, 413) rather than fully walked: a multi-GB CSV
   * must not be scanned character-by-character to discover it is too big.
   */
  readonly maxBytes: number;
  /** Maximum number of data rows in one import. */
  readonly maxRows: number;
  /** Maximum characters in one report message (rows are elided past this). */
  readonly maxMessageLength: number;
}

/** Default import limits: 8 MiB body, 1000 rows, 500-character reasons. */
export const DEFAULT_IMPORT_LIMITS: DeviceImportLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxRows: 1_000,
  maxMessageLength: 500,
};

/** Options accepted by {@link DeviceImportService}. */
export interface DeviceImportOptions {
  /** Per-import limit overrides (merged over {@link DEFAULT_IMPORT_LIMITS}). */
  readonly limits?: Partial<DeviceImportLimits>;
}

// ---------------------------------------------------------------------------
// Format & input vocabulary
// ---------------------------------------------------------------------------

/** The two wire formats a bulk import accepts. */
export type DeviceImportFormat = "csv" | "json";

/** The `?format=` values that select {@link DeviceImportFormat}. */
export const IMPORT_FORMAT_PARAM = "format" as const;

/**
 * Map a `?format=` token (or a content-type) onto the format it names, or
 * `null` when it names neither. Case-insensitive and permissive about the
 * usual aliases, so `?format=CSV`, `text/csv` and `application/json` all work.
 */
export function parseImportFormat(value: string | null | undefined): DeviceImportFormat | null {
  const token = value?.trim().toLowerCase();
  if (!token) return null;
  if (token === "csv" || token === "text/csv" || token.endsWith("+csv")) return "csv";
  if (
    token === "json" ||
    token === "application/json" ||
    token === "text/json" ||
    token.endsWith("+json")
  ) {
    return "json";
  }
  return null;
}

export const IMPORT_FORMATS: readonly DeviceImportFormat[] = ["csv", "json"];

// ---------------------------------------------------------------------------
// Raw-row model — the ONE intermediate representation both formats produce
// ---------------------------------------------------------------------------

/**
 * One raw row, already keyed by canonical field name but not yet validated.
 *
 * `values` uses the {@link DeviceImportField} names; the validator — not the
 * lexer — decides what a missing or blank value means, so CSV and JSON cannot
 * disagree about, say, whether an empty status means "active".
 */
export interface RawDeviceRow {
  /**
   * 1-based position in the source: for CSV the record number, where the header
   * is record 1 and the first data row is record 2 (so it reads as a line an
   * operator can jump to); for JSON the array index. Bookkeeping, not data.
   */
  readonly row: number;
  readonly values: Record<string, string>;
}

/** The canonical field names a row may set. */
export type DeviceImportField =
  | "id"
  | "key"
  | "name"
  | "model"
  | "location"
  | "note"
  | "status";

/** The canonical fields, in sheet order — the documented column set. */
export const DEVICE_IMPORT_FIELDS: readonly DeviceImportField[] = [
  "id",
  "key",
  "name",
  "model",
  "location",
  "note",
  "status",
];

/**
 * Header/key aliases → canonical field.
 *
 * Two normalised views of the SAME table: one keyed by the alias with
 * separators intact (`device_name`), one by the alias with separators removed
 * (`devicename`). Lookup tries the first, then the second, so `Device Name`,
 * `device_name` and `deviceName` all resolve — without the alias list having to
 * spell every variant twice.
 */
const FIELD_ALIASES: Record<string, DeviceImportField> = {
  id: "id",
  device_id: "id",
  key: "key",
  device_key: "key",
  name: "name",
  device_name: "name",
  display_name: "name",
  model: "model",
  device_model: "model",
  location: "location",
  locus: "location",
  note: "note",
  notes: "note",
  comment: "note",
  status: "status",
  lifecycle: "status",
  state: "status",
};
const FIELD_ALIASES_FLAT: Record<string, DeviceImportField> = Object.fromEntries(
  Object.entries(FIELD_ALIASES).map(([alias, field]) => [alias.replace(/_/g, ""), field]),
);

/**
 * Reduce a raw header cell or JSON key to its canonical field, or `null` when
 * nothing recognises it. Exported so a caller (a UI column mapper, say) can ask
 * what a sheet's header means without running an import.
 */
export function canonicalField(raw: string): DeviceImportField | null {
  const token = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const flat = token.replace(/_/g, "");
  if (token in FIELD_ALIASES) return FIELD_ALIASES[token];
  return flat in FIELD_ALIASES_FLAT ? FIELD_ALIASES_FLAT[flat] : null;
}

// ---------------------------------------------------------------------------
// CSV — RFC 4180 reader
// ---------------------------------------------------------------------------

/** The header separators considered, in sniff order. */
const CSV_SEPARATORS = [",", ";", "\t"] as const;

/**
 * Split CSV `text` into records of string cells.
 *
 * Implements the parts of RFC 4180 that real exports actually use:
 *   * a quoted cell (`"…"`) may contain the separator, newlines and `""` for a
 *     literal quote;
 *   * records end at CRLF or a bare LF (and a lone CR), inside quotes or not;
 *   * a leading BOM is removed before anything else.
 *
 * Parsing is character-driven, not split-on-separator, precisely so a quoted
 * field containing the separator cannot shatter the row — the bug that makes
 * naive CSV importers silently mis-map columns.
 */
export function parseCsv(text: string, separator = ","): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let sawAny = false;

  const endField = (): void => {
    record.push(field);
    field = "";
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1; // consume the escaped quote
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
      sawAny = true;
    } else if (ch === separator) {
      endField();
    } else if (ch === "\n") {
      endRecord();
    } else if (ch === "\r") {
      endRecord();
      if (input[i + 1] === "\n") i += 1; // CRLF is one terminator
    } else {
      field += ch;
      sawAny = true;
    }
  }

  // Flush the final cell/record only when the input did not already end on a
  // terminator, so a trailing newline does not fabricate an empty record.
  if (field.length > 0 || record.length > 0 || quoted) {
    endRecord();
  } else if (sawAny && records.length === 0) {
    endRecord();
  }

  return records;
}

/**
 * Pick the separator for a CSV body: the candidate that appears most often,
 * unquoted, on the first line. Counting (rather than "first found") keeps a
 * header like `name,location` stable even when a quoted cell contains a
 * semicolon — a tab- or `;`-delimited export is common enough to auto-handle,
 * and a plain comma header simply wins with its own count.
 */
function sniffSeparator(firstLine: string): string {
  let best: string = ",";
  let bestCount = -1;
  for (const candidate of CSV_SEPARATORS) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < firstLine.length; i += 1) {
      const ch = firstLine[i];
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === candidate) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable, machine-readable failure codes for a device import. */
export type DeviceImportErrorCode =
  | "invalid_input"
  | "invalid_format"
  | "empty_import"
  | "too_many_rows"
  | "payload_too_large";

/** Lookup of a {@link DeviceImportErrorCode} onto an HTTP status. */
export const DEVICE_IMPORT_STATUS: Record<DeviceImportErrorCode, number> = {
  invalid_input: 400,
  invalid_format: 400,
  empty_import: 400,
  too_many_rows: 413,
  payload_too_large: 413,
};

/**
 * Error thrown when the *import as a whole* cannot proceed — a malformed file,
 * no rows at all, or more rows than {@link DeviceImportLimits.maxRows}.
 *
 * These are the failures that are NOT attributable to a single row; a row-level
 * problem never throws, it is reported in {@link DeviceImportResult.failed}.
 */
export class DeviceImportError extends Error {
  /** Stable code suitable for mapping onto an HTTP response. */
  readonly code: DeviceImportErrorCode;

  /** HTTP status corresponding to {@link code}. */
  readonly status: number;

  constructor(code: DeviceImportErrorCode, message: string) {
    super(message);
    this.name = "DeviceImportError";
    this.code = code;
    this.status = DEVICE_IMPORT_STATUS[code];
  }
}

/** Convenience guard for `catch` blocks. */
export function isDeviceImportError(err: unknown): err is DeviceImportError {
  return err instanceof DeviceImportError;
}

// ---------------------------------------------------------------------------
// Result vocabulary
// ---------------------------------------------------------------------------

/**
 * Why one row was rejected. Every code is attributable to that row alone, so
 * the report reads as an actionable list ("row 12: unknown status 'archived'")
 * rather than a single opaque verdict.
 *
 * `duplicate_id` and `device_exists` are kept apart on purpose: the first is a
 * collision *inside this file* (two rows claim one id — fix the sheet), the
 * second is a collision *with the project* (the id is already taken — pick
 * another). The operator's next action differs, so the codes differ.
 */
export type DeviceImportFailureCode =
  | "missing_name"
  | "unknown_status"
  | "duplicate_id"
  | "device_exists"
  | "invalid_input";

/** One rejected row: where it was, what it was, and why it did not land. */
export interface DeviceImportFailure {
  /**
   * Where the row sat in the source: the CSV record number (header is 1, first
   * data row is 2) or the JSON array index. Enough to locate it in the file.
   */
  readonly row: number;
  /** Stable reason code. */
  readonly code: DeviceImportFailureCode;
  /** Human-readable reason naming the offending value. */
  readonly message: string;
}

/** A successful import: what landed, and what did not (with reasons). */
export interface DeviceImportResult {
  readonly format: DeviceImportFormat;
  /** The devices that were created, in source order. */
  readonly created: readonly Device[];
  /** The rejected rows, in source order, each with a reason. */
  readonly failed: readonly DeviceImportFailure[];
  /** `created.length` / (`created.length` + `failed.length`), or `0` for none. */
  readonly totalRows: number;
}

// ---------------------------------------------------------------------------
// Validation — the single set of business rules, format-independent
// ---------------------------------------------------------------------------

/** Outcome of validating one raw row. */
type RowValidation =
  | { readonly ok: true; readonly input: CreateDeviceInput }
  | { readonly ok: false; readonly code: DeviceImportFailureCode; readonly message: string };

/**
 * Turn one {@link RawDeviceRow} into a {@link CreateDeviceInput}, or explain
 * why it cannot become one.
 *
 * `claimedIds` is the set of explicit ids already accepted earlier in the file:
 * a row whose id is in it is `duplicate_id`. Only an explicit id enters the
 * set — generated ids are unique by construction and never collide.
 *
 * Everything here is pure and synchronous: a row is fully judged before any
 * write is attempted, which is what makes "no partial device" true by
 * construction rather than by cleanup.
 */
export function normaliseDeviceInput(
  raw: RawDeviceRow,
  projectId: string,
  claimedIds: ReadonlySet<string>,
): RowValidation {
  const v = raw.values;

  // `name` is the one required field (matching `createDevice`). A blank or
  // whitespace-only name is refused here rather than at the service so the
  // report can name the row; the service would only say "device name is
  // required" with no row context.
  const name = v.name?.trim();
  if (!name) {
    return { ok: false, code: "missing_name", message: "device name is required" };
  }

  // Status: absent ⇒ let `createDevice` apply its documented default
  // (`active`); present ⇒ it must be one of the three lifecycle values.
  let status: DeviceStatus | undefined;
  const rawStatus = v.status?.trim();
  if (rawStatus) {
    if (!isDeviceStatus(rawStatus)) {
      return {
        ok: false,
        code: "unknown_status",
        message: `unknown device status: ${rawStatus} (expected active, dormant or retired)`,
      };
    }
    status = rawStatus;
  }

  const id = v.id?.trim();
  if (id && claimedIds.has(id)) {
    return {
      ok: false,
      code: "duplicate_id",
      message: `device id "${id}" is used by more than one row in this file`,
    };
  }

  // Note `key` falls back to the id inside `createDevice`, so a blank key is
  // left undefined rather than sent as "" (which the service would persist).
  return {
    ok: true,
    input: {
      projectId,
      name,
      ...(id ? { id } : {}),
      ...(v.key?.trim() ? { key: v.key.trim() } : {}),
      ...(v.model !== undefined ? { model: normaliseOptional(v.model) } : {}),
      ...(v.location !== undefined ? { location: normaliseOptional(v.location) } : {}),
      ...(v.note !== undefined ? { note: normaliseOptional(v.note) } : {}),
      ...(status ? { status } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Options accepted by {@link DeviceImportService.importDevices}. */
export interface ImportDevicesInput {
  readonly projectId: string;
  /** The raw file body: CSV text, or a JSON document string. */
  readonly data: string;
  /** Which format `data` is in (see {@link DeviceImportFormat}). */
  readonly format: DeviceImportFormat;
}

/**
 * Bulk-provision devices through the single-device service.
 *
 * The service owns no storage: it validates each row, then commits it via
 * {@link DeviceMetadataService.createDevice}, which is the same atomic insert a
 * single create uses. That is why an imported device is never partial — and why
 * importing needs no new repository method to be correct.
 */
export class DeviceImportService {
  readonly #devices: DeviceMetadataService;
  readonly #limits: DeviceImportLimits;

  constructor(devices: DeviceMetadataService, options: DeviceImportOptions = {}) {
    this.#devices = devices;
    this.#limits = { ...DEFAULT_IMPORT_LIMITS, ...options.limits };
  }

  /** The effective limits (for a route that wants to advertise them). */
  get limits(): DeviceImportLimits {
    return this.#limits;
  }

  /**
   * Import every valid row of `input.data`.
   *
   * Returns the created devices and a per-row failure report. Throws a
   * {@link DeviceImportError} only when the import as a whole cannot proceed
   * (malformed file, no rows, too many rows) — a bad row is reported, never
   * thrown.
   */
  async importDevices(input: ImportDevicesInput): Promise<DeviceImportResult> {
    const projectId = input.projectId?.trim();
    if (!projectId) throw new DeviceImportError("invalid_input", "projectId is required");

    const raw = this.#parse(input);
    if (raw.length > this.#limits.maxRows) {
      throw new DeviceImportError(
        "too_many_rows",
        `import has ${raw.length} rows, limit is ${this.#limits.maxRows}`,
      );
    }

    const created: Device[] = [];
    const failed: DeviceImportFailure[] = [];
    const claimedIds = new Set<string>();

    for (const row of raw) {
      // 1. Validate (pure) — a row that fails here is reported and skipped
      //    before any write, so it can never leave a partial device.
      const validated = normaliseDeviceInput(row, projectId, claimedIds);
      if (!validated.ok) {
        failed.push(this.#failure(row.row, validated.code, validated.message));
        continue;
      }

      // 2. Commit (atomic). The service is the single source of truth for
      //    "create a device"; a duplicate id it reports means the row is
      //    skipped, not an abandoned half-record.
      try {
        const { device } = await this.#devices.createDevice(validated.input);
        created.push(device);
        if (validated.input.id) claimedIds.add(validated.input.id);
      } catch (err) {
        const { code, message } = this.#translate(err);
        failed.push(this.#failure(row.row, code, message));
      }
    }

    return { format: input.format, created, failed, totalRows: raw.length };
  }

  // -- internals ------------------------------------------------------------

  /** Lex the body into raw rows, or throw `invalid_format`/`empty_import`. */
  #parse(input: ImportDevicesInput): RawDeviceRow[] {
    const data = input.data;

    // Size gate FIRST — before any lexing. A body over `maxBytes` is refused
    // whole (`payload_too_large`, 413) so a huge upload is never walked
    // character-by-character. Mirrors `checkSize` in `shared/validation.ts`,
    // which likewise runs before the payload is parsed.
    if (typeof data === "string" && byteLength(data) > this.#limits.maxBytes) {
      throw new DeviceImportError(
        "payload_too_large",
        `import body exceeds ${this.#limits.maxBytes} bytes`,
      );
    }

    if (typeof data !== "string" || data.trim().length === 0) {
      throw new DeviceImportError("empty_import", "import body is empty");
    }
    return input.format === "json" ? this.#parseJson(data) : this.#parseCsvBody(data);
  }

  /**
   * JSON: an array of objects, or `{ devices: [...] }`.
   *
   * A non-object element is kept as an empty row so it is REPORTED at its index
   * (rather than aborting the file): one malformed entry should not hide the
   * 300 good ones next to it.
   */
  #parseJson(data: string): RawDeviceRow[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new DeviceImportError("invalid_format", "malformed JSON");
    }

    let list: unknown[];
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (parsed !== null && typeof parsed === "object" && "devices" in parsed && Array.isArray(parsed.devices)) {
      list = parsed.devices;
    } else {
      throw new DeviceImportError(
        "invalid_format",
        "expected a JSON array of devices, or an object with a `devices` array",
      );
    }

    const rows: RawDeviceRow[] = [];
    list.forEach((entry, index) => {
      const values: Record<string, string> = {};
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        for (const [key, value] of Object.entries(entry)) {
          const field = canonicalField(key);
          if (field === null) continue; // unknown keys are ignored
          if (typeof value === "string") values[field] = value;
          else if (typeof value === "number" || typeof value === "boolean") values[field] = String(value);
          else if (value !== null && value !== undefined) {
            // An object/array where a scalar belongs: keep it visible so the
            // validator can reject the field rather than dropping it silently.
            values[field] = JSON.stringify(value);
          }
        }
      }
      rows.push({ row: index + 1, values });
    });
    return rows;
  }

  /** CSV: header row + data rows, matched by alias, quoted-aware. */
  #parseCsvBody(data: string): RawDeviceRow[] {
    // Sniff on the first physical line only, then parse the whole body with the
    // chosen separator so a quoted cell containing another candidate cannot
    // change the shape mid-file.
    const firstLineEnd = data.search(/\r?\n/);
    const firstLine = firstLineEnd === -1 ? data : data.slice(0, firstLineEnd);
    const separator = sniffSeparator(firstLine);

    const records = parseCsv(data, separator);
    if (records.length === 0) {
      throw new DeviceImportError("empty_import", "CSV has no header row");
    }

    const columnFields = records[0].map((cell) => canonicalField(cell));
    if (columnFields.every((f) => f === null)) {
      throw new DeviceImportError(
        "invalid_format",
        `CSV header names no known device column (expected one of: ${DEVICE_IMPORT_FIELDS.join(", ")})`,
      );
    }

    // Number data rows by their LINE in the file (the header is line 1), so a
    // reported row number is the line an operator can jump to. Blank records
    // are skipped WITHOUT compacting the numbering — dropping them from an
    // array first would silently renumber every following row.
    const rows: RawDeviceRow[] = [];
    for (let i = 1; i < records.length; i += 1) {
      const record = records[i];
      if (!record.some((cell) => cell.trim() !== "")) continue;
      const values: Record<string, string> = {};
      for (let col = 0; col < record.length; col += 1) {
        const field = columnFields[col];
        if (field === null || field === undefined) continue;
        values[field] = record[col];
      }
      rows.push({ row: i + 1, values });
    }
    return rows;
  }

  /** Map a `createDevice` failure onto a row failure code + message. */
  #translate(err: unknown): { code: DeviceImportFailureCode; message: string } {
    if (isDeviceError(err)) {
      const code: DeviceImportFailureCode =
        err.code === "device_exists"
          ? "device_exists"
          : err.code === "invalid_status"
            ? "unknown_status"
            : "invalid_input";
      return { code, message: err.message };
    }
    return { code: "invalid_input", message: err instanceof Error ? err.message : String(err) };
  }

  /** Build a bounded failure record (a runaway message cannot bloat a report). */
  #failure(row: number, code: DeviceImportFailureCode, message: string): DeviceImportFailure {
    const limit = this.#limits.maxMessageLength;
    const bounded =
      message.length > limit ? `${message.slice(0, Math.max(0, limit - 3))}...` : message;
    return { row, code, message: bounded };
  }
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

/**
 * Import `data` with a throwaway {@link DeviceImportService} — for a caller
 * that already holds a {@link DeviceMetadataService} and does not need to
 * configure limits.
 */
export function importDevices(
  devices: DeviceMetadataService,
  input: ImportDevicesInput,
  options?: DeviceImportOptions,
): Promise<DeviceImportResult> {
  return new DeviceImportService(devices, options).importDevices(input);
}
