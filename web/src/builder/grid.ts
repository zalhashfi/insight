/**
 * Dashboard grid layout model.
 *
 * The dashboard canvas is a fixed {@link GridSpec} of `columns × rows` cells
 * with unit-size (1×1) widgets. This module is the *pure* half of the grid
 * editor (A13d): every function is total, side-effect free and never touches
 * the DOM, so the persistence composable in `composables/useDashboardGrid.ts`
 * can wrap it and the whole thing is testable without a browser.
 *
 * Three guarantees the editor builds on:
 *
 *   1. **Placements are always valid** — a widget that would fall off the grid
 *      or run past its right/bottom edge is *clamped* back inside, never
 *      rejected and never stored out of bounds.
 *   2. **Occupancy is exclusive** — a move or resize that would land on cells
 *      already held by another widget is resolved by the widget's own
 *      collision policy ({@link CollisionPolicy}); the grid stays a partition
 *      of distinct cells.
 *   3. **Layouts round-trip** — {@link serializeLayout} /
 *      {@link deserializeLayout} convert to and from the wire JSON
 *      (`{widgets:[{id, variable, x, y, w, h, type}]}`) losslessly, and
 *      {@link gridsEqual} compares two models by value.
 *
 * Identifiers are opaque strings; nothing here assumes UUIDs.
 */

/** A widget kind, mirrored from the widget kit (`web/src/widgets`). */
export type GridWidgetType = string;

/** A variable a widget is bound to; `null` means "unbound" (e.g. a `push`). */
export type GridVariable = string | null;

/** The canvas geometry: `columns × rows` unit cells. */
export interface GridSpec {
  /** Number of columns; positive integer. */
  readonly columns: number;
  /** Number of rows; positive integer. */
  readonly rows: number;
}

/** The shipped default canvas — 12 columns, room to scroll down. */
export const DEFAULT_GRID_SPEC: GridSpec = Object.freeze({ columns: 12, rows: 12 });

/** Hard bounds on a canvas, so a hostile/typo'd spec cannot explode memory. */
export const GRID_LIMITS = Object.freeze({ minColumns: 1, maxColumns: 48, minRows: 1, maxRows: 96 });

/** What to do when a move/resize collides with another widget's cells. */
export type CollisionPolicy =
  /** Land on the nearest free cell; the widget is always kept. */
  | "find-free"
  /** If the requested placement collides, keep the widget where it is. */
  | "keep"
  /** Drop every colliding widget, the moved one wins. */
  | "replace";

/** Default collision policy for {@link moveWidget} / {@link resizeWidget}. */
export const DEFAULT_COLLISION_POLICY: CollisionPolicy = "find-free";

/**
 * One placed widget.
 *
 * `x`/`y` are the top-left cell, `w`/`h` the size in cells, `variable` the
 * telemetry binding and `type` the widget kind. All of `x`, `y`, `w`, `h` are
 * integers with `x >= 0`, `y >= 0`, `w >= 1`, `h >= 1`, and every placement
 * returned by this module satisfies those.
 */
export interface GridWidget {
  /** Stable identifier; unique within a layout. */
  id: string;
  /** Telemetry variable bound to, or `null` when unbound. */
  variable: GridVariable;
  /** Left column, 0-based. */
  x: number;
  /** Top row, 0-based. */
  y: number;
  /** Width in columns, `>= 1`. */
  w: number;
  /** Height in rows, `>= 1`. */
  h: number;
  /** Widget kind. */
  type: GridWidgetType;
}

/** A layout: the spec plus the widgets placed on it. */
export interface GridModel {
  spec: GridSpec;
  widgets: GridWidget[];
}

/** The wire form of a single widget — exactly the keys the task specifies. */
export interface SerializedWidget {
  id: string;
  variable: GridVariable;
  x: number;
  y: number;
  w: number;
  h: number;
  type: GridWidgetType;
}

/** The wire form of a layout: `{widgets:[...]}`, ascending by id. */
export interface SerializedLayout {
  widgets: SerializedWidget[];
}

/** A partial change to a placement; every field optional. */
export interface PlacementPatch {
  id: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  variable?: GridVariable;
  type?: GridWidgetType;
}

/** Options accepted by {@link placeWidget}, {@link moveWidget} and {@link resizeWidget}. */
export interface PlacementOptions {
  /** Collision policy; defaults to {@link DEFAULT_COLLISION_POLICY}. */
  policy?: CollisionPolicy;
  /** Canvas geometry; defaults to {@link DEFAULT_GRID_SPEC}. */
  spec?: GridSpec;
}

/** A zero-based cell coordinate. */
export interface Cell {
  x: number;
  y: number;
}

/** Fields {@link moveWidget} may change. */
export type MoveTarget = Partial<Pick<GridWidget, "x" | "y">>;

/** Fields {@link resizeWidget} may change. */
export type ResizeTarget = Partial<Pick<GridWidget, "w" | "h">>;

/** Thrown when a layout payload is not JSON or not shaped like a layout. */
export class GridJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GridJsonError";
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Force `n` to a finite integer, falling back to `fallback` when it is not. */
function toInt(n: unknown, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Clamp `n` into `[min, max]` (min/max are ordered by the caller). */
function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/** Coerce an unknown spec to positive integers; `null` when unusable. */
function normalizeSpecValue(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clamp(Math.trunc(value), min, max);
}

/** Copies of the fixed keys of a placement patch. */
function patchValues(patch: MoveTarget | ResizeTarget): Record<string, number> {
  const values: Record<string, number> = {};
  for (const key of ["x", "y", "w", "h"] as const) {
    const value = (patch as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) values[key] = Math.trunc(value);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

/** Force a spec to integral, in-range dimensions (never throws). */
export function clampSpec(spec: Partial<GridSpec> | null | undefined): GridSpec {
  const columns =
    normalizeSpecValue(spec?.columns, GRID_LIMITS.minColumns, GRID_LIMITS.maxColumns) ??
    DEFAULT_GRID_SPEC.columns;
  const rows =
    normalizeSpecValue(spec?.rows, GRID_LIMITS.minRows, GRID_LIMITS.maxRows) ??
    DEFAULT_GRID_SPEC.rows;
  return { columns, rows };
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

/** Do two placements overlap on at least one cell? */
export function overlaps(a: GridWidget, b: GridWidget): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Is `(x, y)` strictly inside the spec? */
export function inBounds(spec: GridSpec, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < spec.columns && y < spec.rows;
}

/** The widgets (other than `self`) occupying cell `(x, y)`. */
export function widgetsAt(model: GridModel, x: number, y: number, self?: string): GridWidget[] {
  return model.widgets.filter(
    (widget) =>
      widget.id !== self &&
      x >= widget.x &&
      x < widget.x + widget.w &&
      y >= widget.y &&
      y < widget.y + widget.h,
  );
}

/** Is cell `(x, y)` free — inside the spec and held by nobody but `self`? */
export function isCellFree(model: GridModel, x: number, y: number, self?: string): boolean {
  return inBounds(model.spec, x, y) && widgetsAt(model, x, y, self).length === 0;
}

/** Every free cell of the grid, row-major, as a flat list. */
export function freeCells(model: GridModel): Cell[] {
  const cells: Cell[] = [];
  for (let y = 0; y < model.spec.rows; y += 1) {
    for (let x = 0; x < model.spec.columns; x += 1) {
      if (isCellFree(model, x, y)) cells.push({ x, y });
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Repair a placement in place-free fashion: integers, `w`/`h` at least one,
 * and — when the widget fits at all — pulled inside the spec. Widgets larger
 * than the grid are grown to the grid rather than the canvas being resized.
 */
export function clampWidget(widget: GridWidget, spec: GridSpec = DEFAULT_GRID_SPEC): GridWidget {
  const columns = Math.max(1, spec.columns);
  const rows = Math.max(1, spec.rows);
  const w = clamp(toInt(widget.w, 1), 1, columns);
  const h = clamp(toInt(widget.h, 1), 1, rows);
  const x = clamp(toInt(widget.x, 0), 0, columns - w);
  const y = clamp(toInt(widget.y, 0), 0, rows - h);
  return { ...widget, x, y, w, h };
}

/**
 * Normalise a whole model: clamp the spec, clamp every widget into it, drop
 * exact duplicates (same id, or same cell range) and sort by `id`. Placing
 * this at every mutation boundary is what makes an invalid layout impossible.
 */
export function normalizeModel(model: GridModel): GridModel {
  const spec = clampSpec(model.spec);
  const widgets: GridWidget[] = [];
  const seenIds = new Set<string>();
  const seenCells = new Set<string>();
  for (const candidate of [...model.widgets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const widget = clampWidget(candidate, spec);
    if (!widget.id || seenIds.has(widget.id)) continue;
    const cells = `${widget.x},${widget.y},${widget.w},${widget.h}`;
    if (seenCells.has(cells)) continue;
    seenIds.add(widget.id);
    seenCells.add(cells);
    widgets.push(widget);
  }
  return { spec, widgets };
}

/** Find a widget by id, or `undefined`. */
export function findWidget(model: GridModel, id: string): GridWidget | undefined {
  return model.widgets.find((widget) => widget.id === id);
}

/** The default placement of a new widget: the first free cell, 1×1. */
export function nextPlacement(model: GridModel): Cell {
  return freeCells(model)[0] ?? { x: 0, y: 0 };
}

/**
 * The nearest cell to `origin` where a `w × h` block can sit without touching
 * any of `blockers`, scanning by Chebyshev distance (then row-major). `null`
 * when no such cell exists — the grid is too full.
 */
export function findFreeSpot(
  model: GridModel,
  origin: Cell,
  w: number,
  h: number,
  blockers: readonly GridWidget[],
): Cell | null {
  const { columns, rows } = model.spec;
  const maxX = columns - Math.max(1, w);
  const maxY = rows - Math.max(1, h);
  if (maxX < 0 || maxY < 0) return null;

  const startX = clamp(toInt(origin.x, 0), 0, maxX);
  const startY = clamp(toInt(origin.y, 0), 0, maxY);

  const fits = (x: number, y: number): boolean => {
    const probe: GridWidget = { id: "", variable: null, type: "", x, y, w, h };
    return !blockers.some((blocker) => overlaps(probe, blocker));
  };

  const span = Math.max(columns, rows);
  for (let distance = 0; distance <= span; distance += 1) {
    for (let dy = -distance; dy <= distance; dy += 1) {
      for (let dx = -distance; dx <= distance; dx += 1) {
        // Only the ring at exactly `distance` — inner rings were already tried.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== distance) continue;
        const x = startX + dx;
        const y = startY + dy;
        if (x < 0 || y < 0 || x > maxX || y > maxY) continue;
        if (fits(x, y)) return { x, y };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mutations — all pure, all returning a fresh normalised model
// ---------------------------------------------------------------------------

/**
 * Place a widget. Without an explicit `x`/`y` it lands on the first free cell.
 * Explicit coordinates that collide are resolved by the collision policy; a
 * fully occupied grid leaves the model unchanged rather than throwing.
 */
export function placeWidget(
  model: GridModel,
  widget: GridWidget,
  options: PlacementOptions = {},
): GridModel {
  const spec = clampSpec(options.spec ?? model.spec);
  const policy = options.policy ?? DEFAULT_COLLISION_POLICY;
  const base = normalizeModel({ spec, widgets: model.widgets });
  if (base.widgets.some((existing) => existing.id === widget.id)) return base;

  const requested: GridWidget = { ...widget, variable: widget.variable ?? null };
  const wanted = clampWidget(requested, spec);
  const hasCoords = Number.isFinite(widget.x) && Number.isFinite(widget.y);
  const preexisting = policy === "replace" ? [] : base.widgets;

  // Auto-placement asks for the first free cell; an explicit request may land
  // on occupied cells, in which case the policy decides who moves.
  const blockers = hasCoords
    ? preexisting.filter((other) => overlaps(other, wanted))
    : preexisting;
  const requestedCell: Cell = hasCoords ? { x: wanted.x, y: wanted.y } : nextPlacement(base);
  const mustDodge =
    policy !== "replace" &&
    (hasCoords ? blockers.length > 0 : blockers.some((other) => overlaps(other, wanted)));

  let x = requestedCell.x;
  let y = requestedCell.y;

  if (mustDodge) {
    const spot = findFreeSpot(base, requestedCell, wanted.w, wanted.h, preexisting);
    if (!spot) return base; // grid full: no-op, never an invalid layout
    x = spot.x;
    y = spot.y;
  }

  const placed = clampWidget({ ...requested, x, y, w: wanted.w, h: wanted.h }, spec);
  const survivors = base.widgets.filter(
    (other) => !(policy === "replace" && overlaps(other, placed)),
  );
  return normalizeModel({ spec, widgets: [...survivors, placed] });
}

/**
 * Move a widget (the drag handler's only mutation). Coordinates are clamped to
 * the grid; collisions are resolved by the policy. An unknown id is a no-op.
 */
export function moveWidget(
  model: GridModel,
  id: string,
  target: MoveTarget,
  options: PlacementOptions = {},
): GridModel {
  const spec = clampSpec(options.spec ?? model.spec);
  const base = normalizeModel({ spec, widgets: model.widgets });
  const widget = findWidget(base, id);
  if (!widget) return base;

  const moved = clampWidget({ ...widget, ...patchValues(target) }, spec);
  const movedToSameSpot = moved.x === widget.x && moved.y === widget.y;
  const policy = options.policy ?? DEFAULT_COLLISION_POLICY;
  if (movedToSameSpot) return base;

  const others = base.widgets.filter((other) => other.id !== id);
  const collisions = others.filter((other) => overlaps(other, moved));
  if (collisions.length > 0 && policy === "keep") return base;

  // "replace" wins outright: the moved widget lands exactly where asked and
  // whatever it covers is dropped. Only the other policies dodge.
  const placement =
    collisions.length > 0 && policy !== "replace"
      ? findFreeSpot(base, { x: moved.x, y: moved.y }, moved.w, moved.h, others)
      : { x: moved.x, y: moved.y };
  if (!placement) return base;

  const placed = clampWidget({ ...moved, x: placement.x, y: placement.y }, spec);
  const survivors =
    policy === "replace" ? others.filter((other) => !overlaps(other, placed)) : others;
  return normalizeModel({ spec, widgets: [...survivors, placed] });
}

/**
 * Resize a widget (the drag-handle mutation). The size is clamped to the grid
 * (`1..columns` × `1..rows`) and to the room left at its position; when the
 * grown widget would collide, the policy decides whether it is nudged to a
 * free spot, kept as-is, or wins over the widgets underneath.
 */
export function resizeWidget(
  model: GridModel,
  id: string,
  target: ResizeTarget,
  options: PlacementOptions = {},
): GridModel {
  const spec = clampSpec(options.spec ?? model.spec);
  const base = normalizeModel({ spec, widgets: model.widgets });
  const widget = findWidget(base, id);
  if (!widget) return base;

  const values = patchValues(target);
  const maxW = Math.max(1, spec.columns - widget.x);
  const maxH = Math.max(1, spec.rows - widget.y);
  const resized: GridWidget = {
    ...widget,
    w: values.w === undefined ? widget.w : clamp(values.w, 1, maxW),
    h: values.h === undefined ? widget.h : clamp(values.h, 1, maxH),
  };
  const policy = options.policy ?? DEFAULT_COLLISION_POLICY;
  if (resized.w === widget.w && resized.h === widget.h) {
    if (policy !== "replace") return base;
  }

  const others = base.widgets.filter((other) => other.id !== id);
  const collisions = others.filter((other) => overlaps(other, resized));
  if (collisions.length > 0 && policy === "keep") return base;

  let placement: Cell = { x: resized.x, y: resized.y };
  if (collisions.length > 0 && policy !== "replace") {
    const spot = findFreeSpot(base, placement, resized.w, resized.h, others);
    if (!spot) {
      // No free room for the grown size: keep the last valid size.
      return base;
    }
    placement = spot;
  }

  const placed = clampWidget({ ...resized, x: placement.x, y: placement.y }, spec);
  const survivors =
    policy === "replace" ? others.filter((other) => !overlaps(other, placed)) : others;
  return normalizeModel({ spec, widgets: [...survivors, placed] });
}

/** Remove a widget by id; an unknown id is a no-op. */
export function removeWidget(model: GridModel, id: string): GridModel {
  const base = normalizeModel(model);
  if (!base.widgets.some((widget) => widget.id === id)) return base;
  return normalizeModel({ spec: base.spec, widgets: base.widgets.filter((widget) => widget.id !== id) });
}

/** Edit a placement's `variable`/`type` (and geometry, if given). */
export function updateWidget(model: GridModel, patch: PlacementPatch): GridModel {
  const base = normalizeModel(model);
  const widget = findWidget(base, patch.id);
  if (!widget) return base;

  const next: GridWidget = {
    ...widget,
    x: patch.x === undefined ? widget.x : toInt(patch.x, widget.x),
    y: patch.y === undefined ? widget.y : toInt(patch.y, widget.y),
    w: patch.w === undefined ? widget.w : toInt(patch.w, widget.w),
    h: patch.h === undefined ? widget.h : toInt(patch.h, widget.h),
    variable: patch.variable === undefined ? widget.variable : patch.variable,
    type: patch.type === undefined ? widget.type : patch.type,
  };
  const clamped = clampWidget(next, base.spec);
  const siblings = base.widgets.filter((other) => other.id !== patch.id);
  const collisions = siblings.filter((other) => overlaps(other, clamped));
  if (collisions.length > 0) {
    // A property edit must not silently teleport the widget: nudge it only as
    // far as needed, and leave it alone if even that is impossible.
    const spot = findFreeSpot(base, { x: clamped.x, y: clamped.y }, clamped.w, clamped.h, siblings);
    if (!spot) return base;
    clamped.x = spot.x;
    clamped.y = spot.y;
  }
  return normalizeModel({ spec: base.spec, widgets: [...siblings, clamped] });
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/** A layout in wire form, ascending by `id`. */
export function serializeLayout(model: GridModel): SerializedLayout {
  const base = normalizeModel(model);
  return {
    widgets: [...base.widgets]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(toSerializedWidget),
  };
}

/** Rebuild a model from wire form; every placement is clamped and de-duplicated. */
export function deserializeLayout(payload: SerializedLayout | null | undefined): GridModel {
  const raw = Array.isArray(payload?.widgets) ? payload.widgets : [];
  const widgets = raw.map(fromSerializedWidget);
  return normalizeModel({ spec: DEFAULT_GRID_SPEC, widgets });
}

/** JSON text of {@link serializeLayout}, payload only (no space wasted). */
export function toJSON(model: GridModel): string {
  return JSON.stringify(serializeLayout(model));
}

/**
 * Parse {@link toJSON} output. Throws {@link GridJsonError} for malformed JSON
 * or a payload whose `widgets` is not an array — a reload must never silently
 * restore an invalid layout.
 */
export function fromJSON(json: string): GridModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new GridJsonError(`layout is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as SerializedLayout).widgets)) {
    throw new GridJsonError("layout must be an object with a `widgets` array");
  }
  return deserializeLayout(parsed as SerializedLayout);
}

/** Deep value equality of two models (id, geometry, binding and kind). */
export function gridsEqual(a: GridModel, b: GridModel): boolean {
  const left = normalizeModel(a);
  const right = normalizeModel(b);
  if (left.spec.columns !== right.spec.columns || left.spec.rows !== right.spec.rows) return false;
  if (left.widgets.length !== right.widgets.length) return false;
  for (let i = 0; i < left.widgets.length; i += 1) {
    const x = left.widgets[i];
    const y = right.widgets[i];
    if (
      x.id !== y.id ||
      x.variable !== y.variable ||
      x.x !== y.x ||
      x.y !== y.y ||
      x.w !== y.w ||
      x.h !== y.h ||
      x.type !== y.type
    ) {
      return false;
    }
  }
  return true;
}

/** Deep-clone a layout so callers cannot mutate shared state. */
export function cloneLayout(model: GridModel): GridModel {
  const base = normalizeModel(model);
  return {
    spec: { ...base.spec },
    widgets: base.widgets.map((widget) => ({ ...widget })),
  };
}

/** A fresh, empty layout on `spec` (defaults to {@link DEFAULT_GRID_SPEC}). */
export function createGridModel(spec: Partial<GridSpec> = DEFAULT_GRID_SPEC, widgets: readonly GridWidget[] = []): GridModel {
  return normalizeModel({ spec: clampSpec(spec), widgets: [...widgets] });
}

/**
 * Build a placement, filling defaults for anything omitted.
 *
 * `x`/`y` are *preserved as `NaN`* when absent, because callers use
 * `Number.isFinite` to mean "the user asked for this exact cell" versus "put
 * it wherever there is room" — defaulting to `0` would silently turn every
 * auto-placement into a request for the origin.
 */
export function createWidget(input: Partial<GridWidget> & { id: string }): GridWidget {
  return {
    id: input.id,
    variable: input.variable ?? null,
    x: input.x === undefined ? Number.NaN : toInt(input.x, 0),
    y: input.y === undefined ? Number.NaN : toInt(input.y, 0),
    w: Math.max(1, toInt(input.w, 1)),
    h: Math.max(1, toInt(input.h, 1)),
    type: input.type ?? "value",
  };
}

/** One-way conversion into the wire shape (exactly the seven keys). */
function toSerializedWidget(widget: GridWidget): SerializedWidget {
  return {
    id: widget.id,
    variable: widget.variable,
    x: widget.x,
    y: widget.y,
    w: widget.w,
    h: widget.h,
    type: widget.type,
  };
}

/** One-way conversion out of the wire shape, defaulting/repairing as needed. */
function fromSerializedWidget(raw: Partial<SerializedWidget> | null | undefined): GridWidget {
  const source = raw ?? {};
  return {
    id: typeof source.id === "string" ? source.id : String(source.id ?? ""),
    variable: typeof source.variable === "string" ? source.variable : null,
    x: toInt(source.x, 0),
    y: toInt(source.y, 0),
    w: Math.max(1, toInt(source.w, 1)),
    h: Math.max(1, toInt(source.h, 1)),
    type: typeof source.type === "string" ? source.type : "value",
  };
}
