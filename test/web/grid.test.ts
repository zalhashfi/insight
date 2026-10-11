import { describe, expect, it } from "vitest";

import {
  DEFAULT_GRID_SPEC,
  GridJsonError,
  createGridModel,
  createWidget,
  deserializeLayout,
  findFreeSpot,
  fromJSON,
  freeCells,
  gridsEqual,
  isCellFree,
  moveWidget,
  normalizeModel,
  placeWidget,
  removeWidget,
  resizeWidget,
  serializeLayout,
  toJSON,
  type GridModel,
  type GridWidget,
} from "../../web/src/builder/grid";
import {
  DASHBOARD_LAYOUT_KEY,
  MemoryLayoutStorage,
  isSaved,
  useDashboardGrid,
  type DashboardGrid,
} from "../../web/src/composables/useDashboardGrid";

/**
 * A13d — dashboard grid editor + layout persistence.
 *
 * Drives the pure model directly *and* through the `useDashboardGrid`
 * composable, so both halves of the feature are pinned:
 *
 *   1. **place → move** — a drag moves the widget and `getLayout()` reflects it.
 *   2. **resize** — the handle changes `w`/`h` (and never leaves the canvas).
 *   3. **persistence** — `save()` then a *fresh* editor's `load()` restores the
 *      exact positions and sizes, i.e. a reload preserves the layout.
 *   4. **clamping** — negative/out-of-bounds coordinates and sizes are repaired;
 *      an invalid layout is unrepresentable.
 *   5. **round-trip** — `deserialize(serialize(m))` equals `m`, and
 *      `JSON.parse(toJSON(m))` is exactly the specified wire shape.
 *
 * The storage seam is the in-memory {@link MemoryLayoutStorage} fake, so no
 * browser, no filesystem and no `localStorage` shim is needed.
 */

/** A `12 × 12` canvas unless a test says otherwise. */
function emptyGrid(): GridModel {
  return createGridModel(DEFAULT_GRID_SPEC);
}

/** The seven wire keys, in the order the task spells them out. */
const WIRE_KEYS = ["id", "variable", "x", "y", "w", "h", "type"] as const;

/** Every cell a placement covers, as `x,y` strings. */
function cellsOf(widget: GridWidget): string[] {
  const cells: string[] = [];
  for (let y = widget.y; y < widget.y + widget.h; y += 1) {
    for (let x = widget.x; x < widget.x + widget.w; x += 1) cells.push(`${x},${y}`);
  }
  return cells;
}

/** True when no two widgets share a cell. */
function isDisjoint(widgets: readonly GridWidget[]): boolean {
  const seen = new Set<string>();
  for (const widget of widgets) {
    for (const cell of cellsOf(widget)) {
      if (seen.has(cell)) return false;
      seen.add(cell);
    }
  }
  return true;
}

/** Every widget fits inside the spec and respects the `>= 1` size minima. */
function isInBounds(model: GridModel): boolean {
  return model.widgets.every(
    (w) =>
      w.x >= 0 &&
      w.y >= 0 &&
      w.w >= 1 &&
      w.h >= 1 &&
      w.x + w.w <= model.spec.columns &&
      w.y + w.h <= model.spec.rows,
  );
}

// ---------------------------------------------------------------------------
// Pure model — placement, move, resize
// ---------------------------------------------------------------------------

describe("grid model — place, move, resize", () => {
  it("places a widget at the first free cell by default", () => {
    const model = placeWidget(emptyGrid(), createWidget({ id: "w1", type: "gauge" }));
    expect(model.widgets).toHaveLength(1);
    expect(model.widgets[0]).toMatchObject({ id: "w1", x: 0, y: 0, w: 1, h: 1 });
  });

  it("places consecutive widgets on consecutive free cells", () => {
    let model = emptyGrid();
    model = placeWidget(model, createWidget({ id: "a", type: "value" }));
    model = placeWidget(model, createWidget({ id: "b", type: "value" }));
    model = placeWidget(model, createWidget({ id: "c", type: "value" }));
    expect(model.widgets.map((w) => [w.x, w.y])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    expect(isDisjoint(model.widgets)).toBe(true);
  });

  it("moves a widget and keeps the layout disjoint", () => {
    let model = emptyGrid();
    model = placeWidget(model, createWidget({ id: "a", type: "value" }));
    model = placeWidget(model, createWidget({ id: "b", type: "value" }));
    model = moveWidget(model, "a", { x: 5, y: 5 });
    expect(model.widgets.find((w) => w.id === "a")).toMatchObject({ x: 5, y: 5 });
    expect(isDisjoint(model.widgets)).toBe(true);
  });

  it("resizes a widget in place, clamped to the remaining room", () => {
    const placed = placeWidget(emptyGrid(), createWidget({ id: "a", type: "chart" }));
    const grown = resizeWidget(placed, "a", { w: 4, h: 3 });
    expect(grown.widgets[0]).toMatchObject({ x: 0, y: 0, w: 4, h: 3 });

    // A huge resize cannot spill past the canvas.
    const giant = resizeWidget(grown, "a", { w: 100, h: 100 });
    expect(giant.widgets[0]).toMatchObject({
      w: DEFAULT_GRID_SPEC.columns,
      h: DEFAULT_GRID_SPEC.rows,
    });
    expect(isInBounds(giant)).toBe(true);
  });

  it("resizes relative to the widget's position, not from the origin", () => {
    let model = emptyGrid();
    model = placeWidget(model, createWidget({ id: "a", x: 10, y: 10, type: "value" }));
    model = resizeWidget(model, "a", { w: 5, h: 5 });
    expect(model.widgets[0]).toMatchObject({ x: 10, y: 10, w: 2, h: 2 });
  });

  it("ignores move/resize for an unknown id", () => {
    const model = placeWidget(emptyGrid(), createWidget({ id: "a", type: "value" }));
    expect(gridsEqual(moveWidget(model, "nope", { x: 3, y: 3 }), model)).toBe(true);
    expect(gridsEqual(resizeWidget(model, "nope", { w: 3, h: 3 }), model)).toBe(true);
  });

  it("removes a widget and frees its cells", () => {
    let model = placeWidget(emptyGrid(), createWidget({ id: "a", type: "value" }));
    model = removeWidget(model, "a");
    expect(model.widgets).toHaveLength(0);
    expect(isCellFree(model, 0, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Collision handling
// ---------------------------------------------------------------------------

describe("grid model — collisions", () => {
  it("nudges an overlapping move to the nearest free spot", () => {
    let model = emptyGrid();
    model = placeWidget(model, createWidget({ id: "a", type: "value", x: 0, y: 0 }));
    model = placeWidget(model, createWidget({ id: "b", type: "value", x: 1, y: 0 }));
    const moved = moveWidget(model, "b", { x: 0, y: 0 });
    const b = moved.widgets.find((w) => w.id === "b");
    expect(b).not.toMatchObject({ x: 0, y: 0 });
    expect(isDisjoint(moved.widgets)).toBe(true);
    expect(isInBounds(moved)).toBe(true);
  });

  it('honours the "keep" policy by refusing a colliding move', () => {
    let model = emptyGrid();
    model = placeWidget(model, createWidget({ id: "a", type: "value", x: 0, y: 0 }));
    model = placeWidget(model, createWidget({ id: "b", type: "value", x: 4, y: 4 }));
    const kept = moveWidget(model, "b", { x: 0, y: 0 }, { policy: "keep" });
    expect(kept.widgets.find((w) => w.id === "b")).toMatchObject({ x: 4, y: 4 });
  });

  it('honours the "replace" policy by letting the moved widget win', () => {
    let model = emptyGrid();
    model = placeWidget(model, createWidget({ id: "a", type: "value", x: 0, y: 0 }));
    model = placeWidget(model, createWidget({ id: "b", type: "value", x: 4, y: 4 }));
    const replaced = moveWidget(model, "b", { x: 0, y: 0 }, { policy: "replace" });
    expect(replaced.widgets.find((w) => w.id === "b")).toMatchObject({ x: 0, y: 0 });
    expect(replaced.widgets.find((w) => w.id === "a")).toBeUndefined();
    expect(isDisjoint(replaced.widgets)).toBe(true);
  });

  it("leaves the model untouched when a grown widget has nowhere to go", () => {
    // Fill a 2×2 canvas with one 2×2 widget, then try to add a second.
    const tiny: GridModel = createGridModel({ columns: 2, rows: 2 });
    const filled = placeWidget(tiny, createWidget({ id: "big", w: 2, h: 2, type: "chart" }));
    const after = placeWidget(filled, createWidget({ id: "extra", type: "value" }));
    expect(after.widgets).toHaveLength(1);
    expect(after.widgets[0].id).toBe("big");
  });

  it("findFreeSpot returns the nearest free cell, or null when full", () => {
    const model = placeWidget(emptyGrid(), createWidget({ id: "a", x: 0, y: 0 }));
    // The cluster "near" (0,0) is occupied, so the nearest free cell is used.
    expect(findFreeSpot(model, { x: 0, y: 0 }, 1, 1, model.widgets)).toEqual({ x: 1, y: 0 });
    expect(findFreeSpot(model, { x: 0, y: 0 }, 1, 1, [])).toEqual({ x: 0, y: 0 });

    // A 1×1 grid holding one widget has nowhere free left.
    const full: GridModel = placeWidget(
      createGridModel({ columns: 1, rows: 1 }),
      createWidget({ id: "only" }),
    );
    expect(findFreeSpot(full, { x: 0, y: 0 }, 1, 1, full.widgets)).toBeNull();
  });

  it("freeCells lists exactly the unoccupied cells", () => {
    const tiny: GridModel = createGridModel({ columns: 2, rows: 2 });
    const model = placeWidget(tiny, createWidget({ id: "a", x: 0, y: 0 }));
    expect(freeCells(model)).toEqual([
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Serialization round-trip
// ---------------------------------------------------------------------------

describe("grid model — serialization", () => {
  /** A layout with an unbound widget to exercise `variable: null`. */
  function sampleModel(): GridModel {
    let model = emptyGrid();
    model = placeWidget(model, createWidget({ id: "w1", type: "gauge", variable: "humidity", x: 0, y: 0 }));
    model = placeWidget(model, createWidget({ id: "w2", type: "push", variable: null, x: 4, y: 2, w: 2, h: 2 }));
    model = placeWidget(model, createWidget({ id: "w3", type: "chart", variable: "temperature", x: 8, y: 5 }));
    return model;
  }

  it("round-trips a model through serialize/deserialize", () => {
    const model = sampleModel();
    const restored = deserializeLayout(serializeLayout(model));
    expect(gridsEqual(restored, model)).toBe(true);
    expect(restored).toEqual(model);
  });

  it("emits exactly the specified wire shape", () => {
    const payload = serializeLayout(sampleModel());
    expect(Object.keys(payload)).toEqual(["widgets"]);
    for (const widget of payload.widgets) {
      expect(Object.keys(widget)).toEqual([...WIRE_KEYS]);
      expect(typeof widget.id).toBe("string");
      expect(Number.isInteger(widget.x)).toBe(true);
      expect(Number.isInteger(widget.y)).toBe(true);
      expect(Number.isInteger(widget.w)).toBe(true);
      expect(Number.isInteger(widget.h)).toBe(true);
    }
    expect(payload.widgets.map((w) => w.id)).toEqual(["w1", "w2", "w3"]);
    expect(payload.widgets[1]).toEqual({
      id: "w2",
      variable: null,
      x: 4,
      y: 2,
      w: 2,
      h: 2,
      type: "push",
    });
  });

  it("JSON.parse(toJSON(m)) equals the serialization of m", () => {
    const model = sampleModel();
    expect(JSON.parse(toJSON(model))).toEqual(serializeLayout(model));
  });

  it("fromJSON rebuilds an equal model, and rejects malformed payloads", () => {
    const model = sampleModel();
    expect(gridsEqual(fromJSON(toJSON(model)), model)).toBe(true);
    expect(() => fromJSON("{not json")).toThrow(GridJsonError);
    expect(() => fromJSON('{"widgets":42}')).toThrow(GridJsonError);
    expect(() => fromJSON("null")).toThrow(GridJsonError);
  });

  it("repairs hostile payloads instead of trusting them", () => {
    const dirty = deserializeLayout({
      widgets: [
        { id: "bad", variable: "x", x: -50, y: -5, w: 0, h: 0, type: "value" },
        { id: "bad", variable: "dup", x: 1, y: 1, w: 2, h: 2, type: "gauge" },
        { id: "far", variable: null, x: 999, y: 999, w: 3, h: 3, type: "chart" },
      ],
    });
    expect(dirty.widgets.map((w) => w.id)).toEqual(["bad", "far"]);
    expect(isInBounds(dirty)).toBe(true);
    expect(isDisjoint(dirty.widgets)).toBe(true);
    expect(dirty.widgets[0]).toMatchObject({ x: 0, y: 0, w: 1, h: 1 });
  });
});

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

describe("grid model — clamping", () => {
  it("moves a widget back inside when dragged past the edges", () => {
    const placed = placeWidget(emptyGrid(), createWidget({ id: "a", w: 3, h: 2, type: "chart" }));
    const dragged = moveWidget(placed, "a", { x: 999, y: 999 });
    expect(dragged.widgets[0]).toMatchObject({
      x: DEFAULT_GRID_SPEC.columns - 3,
      y: DEFAULT_GRID_SPEC.rows - 2,
    });
    expect(isInBounds(dragged)).toBe(true);
  });

  it("clamps negative coordinates to zero", () => {
    const placed = placeWidget(emptyGrid(), createWidget({ id: "a", x: 5, y: 5 }));
    const dragged = moveWidget(placed, "a", { x: -10, y: -10 });
    expect(dragged.widgets[0]).toMatchObject({ x: 0, y: 0 });
  });

  it("never produces a non-positive size", () => {
    const grown = resizeWidget(placeWidget(emptyGrid(), createWidget({ id: "a" })), "a", { w: -4, h: 0 });
    expect(grown.widgets[0]).toMatchObject({ w: 1, h: 1 });
  });

  it("normalizeModel repairs a hand-built invalid layout", () => {
    const broken: GridModel = {
      spec: { columns: 6, rows: 6 },
      widgets: [
        { id: "a", variable: null, x: -3, y: 20, w: 0, h: 0, type: "value" },
        { id: "a", variable: null, x: 1, y: 1, w: 4, h: 4, type: "gauge" },
      ],
    };
    const fixed = normalizeModel(broken);
    expect(fixed.widgets).toHaveLength(1);
    expect(fixed.widgets[0]).toMatchObject({ id: "a", x: 0, y: 5, w: 1, h: 1 });
    expect(isInBounds(fixed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Composable — the stateful API + persistence
// ---------------------------------------------------------------------------

/** Drive the composable's default key. */
function editor(storage: MemoryLayoutStorage = new MemoryLayoutStorage()): {
  grid: DashboardGrid;
  storage: MemoryLayoutStorage;
} {
  const grid = useDashboardGrid({ storage });
  return { grid, storage };
}

describe("useDashboardGrid — place/move/resize", () => {
  it("places then moves a widget, reflecting it in getLayout()", () => {
    const { grid } = editor();
    grid.place({ id: "w1", type: "gauge", variable: "humidity" });
    expect(grid.getWidget("w1")).toMatchObject({ x: 0, y: 0, w: 1, h: 1 });

    grid.move("w1", { x: 6, y: 3 });
    const layout = grid.getLayout();
    expect(layout.widgets).toHaveLength(1);
    expect(layout.widgets[0]).toMatchObject({ id: "w1", x: 6, y: 3 });
  });

  it("resizes a widget, changing w/h in getLayout()", () => {
    const { grid } = editor();
    grid.place({ id: "w1", type: "chart", variable: "temperature" });
    grid.resize("w1", { w: 4, h: 3 });
    expect(grid.getWidget("w1")).toMatchObject({ w: 4, h: 3 });
    expect(grid.getLayout().widgets[0]).toMatchObject({ w: 4, h: 3 });
  });

  it("returns deep copies so callers cannot corrupt editor state", () => {
    const { grid } = editor();
    grid.place({ id: "w1", type: "value" });
    const first = grid.getLayout();
    first.widgets[0].x = 99;
    first.widgets.push({ id: "ghost", variable: null, x: 0, y: 0, w: 1, h: 1, type: "value" });
    expect(grid.getLayout().widgets).toHaveLength(1);
    expect(grid.getWidget("w1")?.x).toBe(0);
  });

  it("clamps out-of-bounds placements and moves on the composable too", () => {
    const { grid } = editor();
    grid.place({ id: "w1", type: "value", x: -5, y: -5 });
    expect(grid.getWidget("w1")).toMatchObject({ x: 0, y: 0 });

    grid.resize("w1", { w: 2, h: 2 });
    grid.move("w1", { x: 999, y: 999 });
    const layout = grid.getLayout();
    expect(isInBounds(layout)).toBe(true);
    expect(layout.widgets[0]).toMatchObject({
      x: DEFAULT_GRID_SPEC.columns - 2,
      y: DEFAULT_GRID_SPEC.rows - 2,
    });
  });

  it("places an explicit widget at the requested cell and auto-places the rest", () => {
    const { grid } = editor();
    grid.place({ id: "explicit", type: "value", x: 4, y: 4 });
    grid.place({ id: "auto", type: "value" });
    expect(grid.getWidget("explicit")).toMatchObject({ x: 4, y: 4 });
    expect(grid.getWidget("auto")).toMatchObject({ x: 0, y: 0 });
  });

  it("borrows the free axis for a half-specified placement", () => {
    const { grid } = editor();
    grid.place({ id: "w1", type: "value", x: 5 });
    expect(grid.getWidget("w1")).toMatchObject({ x: 5, y: 0 });
    grid.place({ id: "w2", type: "value", y: 6 });
    expect(grid.getWidget("w2")).toMatchObject({ x: 0, y: 6 });
  });

  it("supports update, remove, clear and nextSlot", () => {
    const { grid } = editor();
    grid.place({ id: "w1", type: "value" });
    grid.place({ id: "w2", type: "value" });
    grid.update("w2", { variable: "battery" });
    expect(grid.getWidget("w2")?.variable).toBe("battery");
    expect(grid.nextSlot()).toEqual({ x: 2, y: 0 });

    grid.remove("w2");
    expect(grid.getWidgets()).toHaveLength(1);
    grid.clear();
    expect(grid.getLayout().widgets).toHaveLength(0);
    expect(grid.nextSlot()).toEqual({ x: 0, y: 0 });
  });
});

describe("useDashboardGrid — persistence", () => {
  it("save() then a fresh load() restores exact positions and sizes", () => {
    const storage = new MemoryLayoutStorage();

    const before = useDashboardGrid({ storage });
    before.place({ id: "w1", type: "gauge", variable: "humidity" });
    before.place({ id: "w2", type: "chart", variable: "temperature" });
    before.move("w1", { x: 3, y: 1 });
    before.resize("w1", { w: 4, h: 3 });
    before.move("w2", { x: 8, y: 6 });
    before.resize("w2", { w: 2, h: 2 });
    const expected = before.save().widgets;

    // A brand-new editor over the same seam — the "reload".
    const after = useDashboardGrid({ storage, autoLoad: false });
    expect(after.getLayout().widgets).toHaveLength(0);
    after.load();

    expect(after.getLayout().widgets).toEqual(expected);
    expect(after.getWidget("w1")).toMatchObject({ x: 3, y: 1, w: 4, h: 3, variable: "humidity" });
    expect(after.getWidget("w2")).toMatchObject({ x: 8, y: 6, w: 2, h: 2, variable: "temperature" });
    expect(gridsEqual(after.getLayout(), before.getLayout())).toBe(true);
  });

  it("auto-loads the saved layout at construction", () => {
    const storage = new MemoryLayoutStorage();
    const first = useDashboardGrid({ storage });
    first.place({ id: "w1", type: "percent", variable: "battery" });
    first.save();

    const reloaded = useDashboardGrid({ storage });
    expect(reloaded.getWidgets()).toEqual(first.getWidgets());
  });

  it("writes JSON under the configured key and reports unsaved changes", () => {
    const { grid, storage } = editor();
    grid.place({ id: "w1", type: "value" });
    expect(storage.getItem(DASHBOARD_LAYOUT_KEY)).toBeNull();
    expect(isSaved(grid, storage)).toBe(false);

    grid.save();
    const raw = storage.getItem(DASHBOARD_LAYOUT_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual(serializeLayout(grid.getLayout()));
    expect(isSaved(grid, storage)).toBe(true);

    grid.move("w1", { x: 2, y: 2 });
    expect(isSaved(grid, storage)).toBe(false);
  });

  it("load() accepts explicit JSON and returns null when nothing is stored", () => {
    const { grid } = editor();
    grid.place({ id: "w1", type: "value", x: 1, y: 1 });

    const blank = useDashboardGrid({});
    expect(blank.load()).toBeNull();

    expect(blank.load(grid.serialize())).not.toBeNull();
    expect(blank.getWidget("w1")).toMatchObject({ x: 1, y: 1 });
  });

  it("startup equals a reload equals a fresh load — same layout three ways", () => {
    const storage = new MemoryLayoutStorage();
    const writer = useDashboardGrid({ storage });
    writer.place({ id: "a", type: "map", variable: "location", x: 2, y: 2, w: 3, h: 3 });
    const saved = writer.save();

    const viaAuto = useDashboardGrid({ storage });
    const viaManual = useDashboardGrid({ storage, autoLoad: false });
    viaManual.load();
    const viaJson = useDashboardGrid({});
    viaJson.load(saved && writer.serialize());

    expect(gridsEqual(viaAuto.getLayout(), viaManual.getLayout())).toBe(true);
    expect(gridsEqual(viaManual.getLayout(), viaJson.getLayout())).toBe(true);
    expect(viaAuto.getWidget("a")).toMatchObject({ x: 2, y: 2, w: 3, h: 3 });
  });

  it("is a no-op without a storage seam but still keeps state", () => {
    const grid = useDashboardGrid({});
    grid.place({ id: "w1", type: "value" });
    expect(() => grid.save()).not.toThrow();
    expect(grid.getLayout().widgets).toHaveLength(1);
  });

  it("isolates separate keys in the same storage", () => {
    const storage = new MemoryLayoutStorage();
    const left = useDashboardGrid({ storage, storageKey: "left" });
    const right = useDashboardGrid({ storage, storageKey: "right" });
    left.place({ id: "w1", type: "value", x: 1, y: 1 });
    right.place({ id: "w1", type: "value", x: 9, y: 9 });
    left.save();
    right.save();

    const leftReload = useDashboardGrid({ storage, storageKey: "left" });
    const rightReload = useDashboardGrid({ storage, storageKey: "right" });
    expect(leftReload.getWidget("w1")).toMatchObject({ x: 1, y: 1 });
    expect(rightReload.getWidget("w1")).toMatchObject({ x: 9, y: 9 });
  });
});
