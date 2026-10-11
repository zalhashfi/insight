/**
 * `useDashboardGrid` — the stateful half of the dashboard grid editor (A13d).
 *
 * Wraps the pure layout model in `builder/grid.ts` in a tiny imperative API the
 * editor UI drives directly:
 *
 * ```ts
 * const grid = useDashboardGrid({ storage: new MemoryLayoutStorage() });
 * grid.place({ id: "w1", type: "gauge", variable: "humidity" });
 * grid.move("w1", { x: 4, y: 2 });
 * grid.resize("w1", { w: 3, h: 2 });
 * grid.save();                       // -> storage.set(LAYOUT_KEY, json)
 * const reloaded = useDashboardGrid({ storage });
 * reloaded.load();                   // -> exact same positions/sizes
 * ```
 *
 * Every mutation returns the (normalised) {@link GridModel}, so a host can
 * persist opportunistically; {@link DashboardGrid.save} is the explicit
 * "commit" the task asks for, and {@link DashboardGrid.load} the "restore".
 *
 * **Framework-agnostic on purpose.** The repo's web layer is a Vue dashboard,
 * but nothing here imports Vue: the object *is* the composable. A thin
 * `ref()`/`computed()` binding can wrap it later without touching the model.
 *
 * **Storage is an injected seam.** {@link LayoutStorage} is one method on top of
 * a string map; {@link MemoryLayoutStorage} is the in-memory fake the tests use
 * and a browser `localStorage` adapter can implement the same interface.
 */

import {
  DEFAULT_GRID_SPEC,
  DEFAULT_COLLISION_POLICY,
  normalizeModel,
  cloneLayout,
  createGridModel,
  createWidget,
  fromJSON,
  gridsEqual,
  nextPlacement,
  removeWidget,
  toJSON,
  updateWidget,
  type Cell,
  type CollisionPolicy,
  type GridModel,
  type GridSpec,
  type GridWidget,
  type GridVariable,
  moveWidget as moveInModel,
  placeWidget as placeInModel,
  resizeWidget as resizeInModel,
} from "../builder/grid";

export {
  DEFAULT_GRID_SPEC,
  type Cell,
  type CollisionPolicy,
  type GridModel,
  type GridSpec,
  type GridWidget,
  type GridVariable,
} from "../builder/grid";

/** Where the editor writes the layout; the app owns the concrete key. */
export const DASHBOARD_LAYOUT_KEY = "insight.dashboard.layout.v1";

/**
 * The persistence seam. One `getItem`/`setItem` pair is deliberately all it
 * takes: an in-memory fake, a `localStorage` adapter and a REST-backed store
 * are then interchangeable.
 */
export interface LayoutStorage {
  /** A `getItem`-shaped read; `null` when nothing has been saved. */
  getItem(key: string): string | null;
  /** A `setItem`-shaped write. */
  setItem(key: string, value: string): void;
}

/** In-memory `LayoutStorage` — the test fake and the pre-persistence default. */
export class MemoryLayoutStorage implements LayoutStorage {
  private readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.has(key) ? (this.entries.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** A widget to place; `x`/`y` are optional (first free cell), `w`/`h` default 1. */
export interface PlaceWidgetInput {
  id: string;
  type: string;
  variable?: GridVariable;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** Knobs the editor passes once, at construction. */
export interface DashboardGridOptions {
  /** Persistence seam; omitted → edits stay in memory only. */
  storage?: LayoutStorage;
  /** Key written to/read from `storage`; defaults to {@link DASHBOARD_LAYOUT_KEY}. */
  storageKey?: string;
  /** Initial canvas geometry; defaults to {@link DEFAULT_GRID_SPEC}. */
  spec?: GridSpec;
  /** Collision policy for `place`/`move`/`resize`. */
  collision?: CollisionPolicy;
  /** Restore from `storage` immediately (defaults to `true`). */
  autoLoad?: boolean;
}

/** The composable's surface. */
export interface DashboardGrid {
  /** Place a widget; returns the resulting layout. */
  place(widget: PlaceWidgetInput): GridModel;
  /** Move a placed widget by id; clamped + collision-resolved. */
  move(id: string, target: Partial<Pick<GridWidget, "x" | "y">>): GridModel;
  /** Resize a placed widget by id; clamped + collision-resolved. */
  resize(id: string, target: Partial<Pick<GridWidget, "w" | "h">>): GridModel;
  /** Patch a placed widget's `variable`/`type`/geometry. */
  update(id: string, patch: Partial<Omit<GridWidget, "id">>): GridModel;
  /** Remove a placed widget. */
  remove(id: string): GridModel;
  /** Replace the whole layout (also applies a new spec, if given). */
  setLayout(model: GridModel): GridModel;
  /** Discard everything but the spec. */
  clear(): GridModel;
  /** Serialize and write the layout to the storage seam. */
  save(): GridModel;
  /** Read the storage seam and adopt the saved layout (`null` → fresh). */
  load(json?: string | null): GridModel | null;
  /** JSON string of the current layout (`{widgets:[...]}`). */
  serialize(): string;
  /** Parse JSON into the model without adopting it — a validation probe. */
  deserialize(json: string): GridModel;
  /** The current layout, deep-copied so callers cannot mutate editor state. */
  getLayout(): GridModel;
  /** The widgets of the current layout (same deep copy). */
  getWidgets(): GridWidget[];
  /** One widget by id, or `null`. */
  getWidget(id: string): GridWidget | null;
  /** The spec in force. */
  getSpec(): GridSpec;
  /** The first free cell, or `null` when the grid is full. */
  nextSlot(): Cell | null;
  /** The layout key used by `save`/`load`. */
  readonly storageKey: string;
  /** The model itself — mutable on purpose for hosts that bind refs to it. */
  readonly model: GridModel;
}

/**
 * Create a dashboard-grid editor over an optional storage seam.
 *
 * The returned object holds the model in a closure and hands out deep copies,
 * so a UI can read `getLayout()` on every keystroke without racing the editor.
 */
export function useDashboardGrid(options: DashboardGridOptions = {}): DashboardGrid {
  const storageKey = options.storageKey ?? DASHBOARD_LAYOUT_KEY;
  const policy = options.collision ?? DEFAULT_COLLISION_POLICY;
  const spec = options.spec ?? DEFAULT_GRID_SPEC;
  const storage = options.storage;
  const placementOptions = { spec, policy } as const;

  const model: GridModel = createGridModel(spec);

  const adopt = (next: GridModel): GridModel => {
    const normalized = normalizeModel(next);
    model.spec = normalized.spec;
    model.widgets = normalized.widgets;
    return snapshot();
  };

  const snapshot = (): GridModel => cloneLayout(model);

  const place = (widget: PlaceWidgetInput): GridModel => {
    // `createWidget` keeps omitted `x`/`y` as `NaN`, which `placeWidget` reads
    // as "first free cell". A half-specified cell (only one axis given) borrows
    // the other axis from the first free cell so the widget lands somewhere sane.
    const onlyX = widget.y === undefined && widget.x !== undefined;
    const onlyY = widget.x === undefined && widget.y !== undefined;
    const free = onlyX || onlyY ? nextPlacement(model) : null;
    const candidate = createWidget({
      id: widget.id,
      type: widget.type,
      variable: widget.variable ?? null,
      x: widget.x ?? (onlyY ? free?.x : undefined),
      y: widget.y ?? (onlyX ? free?.y : undefined),
      w: widget.w,
      h: widget.h,
    });
    return adopt(placeInModel(model, candidate, placementOptions));
  };

  const move = (id: string, target: Partial<Pick<GridWidget, "x" | "y">>): GridModel =>
    adopt(moveInModel(model, id, target, placementOptions));

  const resize = (id: string, target: Partial<Pick<GridWidget, "w" | "h">>): GridModel =>
    adopt(resizeInModel(model, id, target, placementOptions));

  const update = (id: string, patch: Partial<Omit<GridWidget, "id">>): GridModel =>
    adopt(updateWidget(model, { id, ...patch }));

  const remove = (id: string): GridModel => adopt(removeWidget(model, id));

  const setLayout = (next: GridModel): GridModel => adopt(next);

  const clear = (): GridModel => adopt({ spec: model.spec, widgets: [] });

  const save = (): GridModel => {
    if (storage) storage.setItem(storageKey, toJSON(model));
    return snapshot();
  };

  const load = (json: string | null = null): GridModel | null => {
    const payload = json ?? storage?.getItem(storageKey) ?? null;
    if (payload === null) return null;
    const parsed = fromJSON(payload);
    adopt({ spec: parsed.spec, widgets: parsed.widgets });
    return snapshot();
  };

  const serialize = (): string => toJSON(model);

  const deserialize = (json: string): GridModel => fromJSON(json);

  const getLayout = (): GridModel => snapshot();

  const getWidgets = (): GridWidget[] => snapshot().widgets;

  const getWidget = (id: string): GridWidget | null =>
    model.widgets.find((widget) => widget.id === id) ?? null;

  const getSpec = (): GridSpec => ({ ...model.spec });

  const nextSlot = (): Cell | null => {
    const cell = nextPlacement(model);
    const full = model.widgets.some(
      (widget) =>
        cell.x >= widget.x &&
        cell.x < widget.x + widget.w &&
        cell.y >= widget.y &&
        cell.y < widget.y + widget.h,
    );
    return full ? null : cell;
  };

  const api: DashboardGrid = {
    place,
    move,
    resize,
    update,
    remove,
    setLayout,
    clear,
    save,
    load,
    serialize,
    deserialize,
    getLayout,
    getWidgets,
    getWidget,
    getSpec,
    nextSlot,
    storageKey,
    model,
  };

  if (storage && options.autoLoad !== false) load();

  return api;
}

/**
 * Convenience predicate for hosts that poll the seam: is the stored layout the
 * same as the one in memory? Handy for "unsaved changes" indicators.
 */
export function isSaved(grid: DashboardGrid, storage: LayoutStorage, key = grid.storageKey): boolean {
  const stored = storage.getItem(key);
  if (stored === null) return false;
  try {
    return gridsEqual(fromJSON(stored), grid.getLayout());
  } catch {
    return false;
  }
}
