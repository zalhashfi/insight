import { describe, expect, it } from "vitest";

// Install the DOM stub BEFORE the widget module is evaluated: `WidgetElement`
// captures `globalThis.HTMLElement` at class-definition time, so the stub must
// already be in place or the render path permanently binds to the no-DOM
// fallback. `dom-stub.ts` itself imports nothing from the widget kit, so this
// import is side-effect-safe to hoist to the very top.
import { installDomStub, type StubHTMLElement } from "./dom-stub";

import {
  ChartCore,
  ColorCore,
  GaugeCore,
  MapCore,
  PercentCore,
  PushCore,
  SliderCore,
  ToggleCore,
  ValueCore,
  WIDGET_CORE_CLASSES,
  WidgetCore,
  createWidgetCore,
  defineCustomElements,
  normalizeVariable,
  type WidgetData,
  type WidgetElement,
  type WidgetType,
  type WidgetValue,
} from "../../web/src/widgets/index";
import {
  WIDGET_CATALOG,
  WIDGET_TYPES,
  createBoundWidget,
  getWidgetDescriptor,
  tagFor,
  type WidgetDescriptor,
} from "../../web/src/widgets/registry";

/**
 * A13c — dashboard widget kit.
 *
 * Asserts the contract the grid editor (A13d) and the live dashboard build on.
 * The pure `WidgetCore` layer is driven directly; the **custom-element render
 * path** is driven through a hand-rolled DOM stub (see `./dom-stub.ts`), so no
 * browser and no jsdom are required:
 *
 *   1. **The catalog is exactly nine kinds** — value, gauge, chart, map, toggle,
 *      push, slider, color, percent — each with a unique tag that matches its
 *      `ins-<type>` element.
 *   2. **A bound widget reflects a change** — after `bind(variable)` an
 *      `update(value)` is observable on the widget. Updates are *not* allowed to
 *      be ignored: `update` on a bound widget always moves `displayValue`, and a
 *      render is emitted whenever a DOM sink is attached.
 *   3. **`defineCustomElements()` registers the nine `ins-*` tags** into the
 *      (stubbed) `customElements` registry, and each registered element —
 *      instantiated for real — binds its `variable` attribute and mirrors a
 *      value change into its stubbed `textContent`/attributes. An ignored update
 *      is a failure.
 *   4. **Initialising all nine never throws** — including on platforms without a
 *      `customElements` registry, where {@link defineCustomElements} is a
 *      documented no-op.
 */

/** The nine expected kinds, in the order the task lists them. */
const EXPECTED_TYPES: readonly WidgetType[] = [
  "value",
  "gauge",
  "chart",
  "map",
  "toggle",
  "push",
  "slider",
  "color",
  "percent",
];

/**
 * One representative update per kind, chosen so the change is *unambiguous*:
 * `null` -> a concrete reading, a `[t, v]` chart point or a `[lat, lon]` map
 * position. The type mirrors `WidgetCore["update"]`'s parameter, spelled out so
 * the tuple reads stay tuples.
 */
type SampleUpdate = WidgetData;

const SAMPLE_UPDATES: Readonly<Record<WidgetType, SampleUpdate>> = {
  value: 42,
  gauge: 75,
  chart: [10, 21.5] as [number, number],
  map: [51.5, -0.12] as [number, number],
  toggle: true,
  push: true,
  slider: 55,
  color: "#ff8800",
  percent: 80,
};

/** A sink that records every render, so "was a render emitted?" is observable. */
function recordingSink(): { texts: string[]; styles: (string | null)[] } {
  return { texts: [], styles: [] };
}

describe("widget catalog", () => {
  it("has exactly nine widgets", () => {
    expect(WIDGET_CATALOG).toHaveLength(9);
  });

  it("exposes the nine expected types in order", () => {
    expect(WIDGET_CATALOG.map((w) => w.type)).toEqual([...EXPECTED_TYPES]);
    expect(WIDGET_TYPES).toEqual([...EXPECTED_TYPES]);
    expect(new Set(WIDGET_TYPES).size).toBe(9);
  });

  it("gives each widget a unique tag derived from its type", () => {
    const tags = WIDGET_CATALOG.map((w) => w.tag);
    expect(new Set(tags).size).toBe(9);
    for (const widget of WIDGET_CATALOG) {
      expect(widget.tag).toBe(`ins-${widget.type}`);
      expect(tagFor(widget.type)).toBe(widget.tag);
    }
  });

  it("has a lookup that resolves by type and by tag", () => {
    for (const type of EXPECTED_TYPES) {
      const byType = getWidgetDescriptor(type);
      expect(byType?.type).toBe(type);
      expect(getWidgetDescriptor(`ins-${type}`)).toEqual(byType);
      // Case/whitespace insensitive: palette input is user-supplied.
      expect(getWidgetDescriptor(`  INS-${type.toUpperCase()}  `)).toEqual(byType);
    }
    expect(getWidgetDescriptor("not-a-widget")).toBeUndefined();
  });

  it("declares a default binding for every widget except the manual push button", () => {
    for (const widget of WIDGET_CATALOG) {
      if (widget.type === "push") {
        expect(widget.defaultBinding).toBeNull();
        expect(widget.bindable).toBe(false);
        continue;
      }
      expect(widget.bindable).toBe(true);
      expect(normalizeVariable(widget.defaultBinding)).toBe(widget.defaultBinding);
    }
  });

  it("keeps its entries immutable, so a consumer cannot corrupt the catalog", () => {
    expect(Object.isFrozen(WIDGET_CATALOG)).toBe(true);
    for (const widget of WIDGET_CATALOG) expect(Object.isFrozen(widget)).toBe(true);
    expect(() => (WIDGET_CATALOG as unknown as WidgetDescriptor[]).push(undefined as never)).toThrow();
  });

  it("has a core class for every type", () => {
    expect(Object.keys(WIDGET_CORE_CLASSES).sort()).toEqual(
      [...EXPECTED_TYPES].sort(),
    );
    for (const type of EXPECTED_TYPES) {
      expect(new WIDGET_CORE_CLASSES[type]()).toBeInstanceOf(WidgetCore);
    }
  });
});

describe("binding a variable", () => {
  it("records the bound variable for every widget", () => {
    for (const type of EXPECTED_TYPES) {
      const widget = createWidgetCore(type);
      expect(widget.variable).toBeNull();
      widget.bind("kitchen.temperature");
      expect(widget.variable).toBe("kitchen.temperature");
    }
  });

  it("treats a blank variable as unbound rather than a variable named ' '", () => {
    for (const type of EXPECTED_TYPES) {
      const widget = createWidgetCore(type);
      widget.bind("temp");
      widget.bind("   ");
      expect(widget.variable).toBeNull();
      expect(normalizeVariable("")).toBeNull();
      expect(normalizeVariable(null)).toBeNull();
    }
  });

  it("resets the displayed value on rebinding, so a stale reading cannot leak", () => {
    for (const type of EXPECTED_TYPES) {
      const widget = createWidgetCore(type);
      widget.bind("first").update(123);
      expect(widget.displayValue).not.toBeNull();

      widget.bind("second");

      expect(widget.variable).toBe("second");
      // Reset to this kind's neutral default: `null` for read-outs, `false`
      // for the boolean toggles — never the stale `123` from `first`.
      const neutral = createWidgetCore(type);
      neutral.init();
      expect(widget.displayValue).toEqual(neutral.displayValue);
      expect(widget.displayValue).not.toEqual(123);
    }
  });

  it("returns the widget from bind/update so calls chain", () => {
    const widget = new ValueCore();
    expect(widget.bind("temp")).toBe(widget);
    expect(widget.update(1)).toBe(widget);
    expect(widget.init()).toBe(widget);
    expect(widget.variable).toBe("temp");
  });
});

describe("update reflects a value change", () => {
  it("moves displayValue for every widget — an ignored update is a failure", () => {
    for (const type of EXPECTED_TYPES) {
      const widget = createWidgetCore(type, "device.var");
      expect(widget.displayValue).toBeNull();

      widget.update(SAMPLE_UPDATES[type]);

      expect(widget.displayValue).not.toBeNull();
      expect(widget.displayValue).toEqual(SAMPLE_UPDATES[type]);
      expect(widget.rendered).toBe(true);
    }
  });

  it("renders a changed reading into an attached sink for every widget", () => {
    for (const type of EXPECTED_TYPES) {
      const widget = createWidgetCore(type, "device.var");
      const sink = recordingSink();
      widget.attachSink("host", {
        text: (text) => void sink.texts.push(text),
        style: (style) => void sink.styles.push(style),
      });
      const before = sink.texts.length;

      widget.update(SAMPLE_UPDATES[type]);

      expect(sink.texts.length).toBeGreaterThan(before);
      const latest = sink.texts.at(-1);
      expect(latest).toBeDefined();
      // The rendered reading is a real, non-placeholder string.
      expect(latest).not.toBe("—");
    }
  });

  it("tracks a second update after the first (not write-once)", () => {
    for (const type of EXPECTED_TYPES) {
      const widget = createWidgetCore(type, "device.var");
      widget.update(SAMPLE_UPDATES[type]);
      const first = widget.displayValue;
      const second = type === "toggle" || type === "push" ? false : 0;

      widget.update(second);

      expect(widget.displayValue).not.toEqual(first);
      expect(widget.displayValue).toEqual(second);
    }
  });
});

describe("per-widget behaviour", () => {
  it("value formats the reading with an optional unit", () => {
    const widget = new ValueCore("temp", "°C");
    expect(widget.text).toBe("—");
    widget.update(21.456);
    expect(widget.text).toBe("21.46 °C");
  });

  it("gauge maps the reading onto its range", () => {
    const widget = new GaugeCore("humidity", 0, 200);
    widget.update(50);
    expect(widget.ratio).toBeCloseTo(0.25);
    expect(widget.percent).toBe(25);
    widget.update(500); // clamps above the range
    expect(widget.ratio).toBe(1);
    expect(widget.percent).toBe(100);
  });

  it("chart retains a bounded series and reports the latest point", () => {
    const widget = new ChartCore("temp", 3);
    for (const [t, v] of [[1, 10], [2, 20], [3, 30], [4, 40]] as const) {
      widget.update([t, v]);
    }
    expect(widget.points).toHaveLength(3);
    expect(widget.points[0]).toEqual({ t: 2, v: 20 });
    expect(widget.latest).toBe(40);
  });

  it("map keeps one marker per device, latest wins", () => {
    const widget = new MapCore("gateway");
    widget.update([51.5, -0.12]);
    widget.update([52.5, -1.5]);
    expect(widget.markers).toHaveLength(1);
    expect(widget.coordinates).toEqual([52.5, -1.5]);
    widget.update({ device: "other", lat: 1, lon: 2 });
    expect(widget.markers).toHaveLength(2);
    expect(widget.marker?.lat).toBe(52.5);
  });

  it("toggle normalises truthy strings into a boolean state", () => {
    const widget = new ToggleCore("relay");
    expect(widget.state).toBe(false);
    widget.update("on");
    expect(widget.state).toBe(true);
    widget.update("OFF");
    expect(widget.state).toBe(false);
  });

  it("push records press and release", () => {
    const widget = new PushCore();
    expect(widget.displayValue).toBeNull();
    widget.press();
    expect(widget.displayValue).toBe(true);
    widget.release();
    expect(widget.displayValue).toBe(false);
  });

  it("slider clamps the reading into its range", () => {
    const widget = new SliderCore("setpoint", 10, 20);
    widget.update(2);
    expect(widget.position).toBe(10);
    widget.update(15);
    expect(widget.position).toBe(15);
    widget.update(99);
    expect(widget.position).toBe(20);
  });

  it("color accepts css-ish strings and numeric values", () => {
    const widget = new ColorCore("led");
    widget.update("#ff8800");
    expect(widget.color).toBe("#ff8800");
    widget.update("00ff00");
    expect(widget.color).toBe("#00ff00");
    widget.update(0xff0000);
    expect(widget.color).toBe("#ff0000");
    widget.update("not a colour");
    expect(widget.color).toBeNull();
  });

  it("percent normalises the reading to 0–100", () => {
    const widget = new PercentCore("battery", 0, 4);
    widget.update(1);
    expect(widget.percent).toBe(25);
    widget.update(2);
    expect(widget.percent).toBe(50);
  });

  it("non-finite readings degrade to the placeholder instead of throwing", () => {
    for (const type of EXPECTED_TYPES) {
      const widget = createWidgetCore(type, "device.var");
      expect(() => widget.update(Number.NaN)).not.toThrow();
      expect(widget.displayValue).toEqual(Number.NaN);
    }
  });
});

describe("initialising all nine", () => {
  it("binds and initialises every widget type without throwing", () => {
    for (const type of EXPECTED_TYPES) {
      expect(() => {
        const widget = createWidgetCore(type);
        widget.bind("device.variable");
        widget.update(SAMPLE_UPDATES[type]);
        widget.init();
        expect(widget.rendered).toBe(true);
      }).not.toThrow();
    }
  });

  it("initialises every catalog widget through the registry helper", () => {
    for (const descriptor of WIDGET_CATALOG) {
      expect(() => {
        const widget = createBoundWidget(descriptor.type);
        expect(widget).toBeInstanceOf(WidgetCore);
        expect(widget.variable).toBe(descriptor.defaultBinding);
        widget.update(SAMPLE_UPDATES[descriptor.type]);
        expect(widget.displayValue).not.toBeNull();
      }).not.toThrow();
    }
  });

  it("lets an explicit binding override the descriptor default", () => {
    const widget = createBoundWidget("value", "  livingroom.temp  ");
    expect(widget.variable).toBe("livingroom.temp");
  });

  it("rejects an unknown type loudly instead of returning a silent stub", () => {
    expect(() => createBoundWidget("does-not-exist" as WidgetType)).toThrow(
      /unknown widget type/,
    );
    expect(() => tagFor("does-not-exist" as WidgetType)).toThrow(
      /unknown widget type/,
    );
  });
});

// ---------------------------------------------------------------------------
// Custom-element render path (hand-rolled DOM stub — no jsdom)
// ---------------------------------------------------------------------------

/**
 * The stub is installed once at module scope, right after the widget module has
 * bound its `HTMLElement` base (see `./dom-stub.ts`). Sharing one instance makes
 * the registry assertions coherent and keeps `elementCtor` usable everywhere.
 */
const stub = installDomStub();

/**
 * The instance shape {@link WidgetElement} presents at runtime: `core` is
 * populated by the constructor (it is `!`-asserted, not optional), and the DOM
 * members come from the stub `HTMLElement` the module bound to on import. The
 * `core` cast is unchecked because the class declares it `!`; no extra shape is
 * fabricated beyond that attribute's real runtime type.
 */
type StubElement = WidgetElement & StubHTMLElement & {
  core: { variable: string | null; displayValue: unknown };
};

/**
 * The registered tag constructors are anonymous subclasses of
 * {@link WidgetElement}; the compiler only knows them as `CustomElementConstructor`.
 * A single named cast (with the reason above) keeps the per-case reads checked.
 */
function elementCtor(tag: string): new () => StubElement {
  const ctor = stub.registry.get(tag);
  if (typeof ctor !== "function") throw new Error(`tag not registered: ${tag}`);
  return ctor as unknown as new () => StubElement;
}

/**
 * One representative value change per kind, plus the exact text the stubbed DOM
 * must end up showing. Kept explicit (no snapshotting the core) so a broken
 * render — or a widget that silently drops an update — fails loudly here.
 *
 * `attr` is the string the `value` attribute carries (parsed as a number when
 * numeric, else handed through verbatim); `argv` is the same reading as the
 * public `update()` argument, where structured kinds can use a tuple/object.
 * `map` reads a marker rather than a scalar, so the render test seeds it through
 * the API and only carries a placeholder `attr`.
 */
const RENDER_EXPECTATIONS: Readonly<
  Record<WidgetType, { attr: string; argv: WidgetData; text: string }>
> = {
  value: { attr: "42", argv: 42, text: "42" },
  gauge: { attr: "75", argv: 75, text: "75%" },
  chart: { attr: "21.5", argv: 21.5, text: "21.5" },
  map: { attr: "51.5", argv: [51.5, -0.12], text: "51.5, -0.12" },
  toggle: { attr: "on", argv: "on", text: "on" },
  push: { attr: "true", argv: true, text: "pressed" },
  slider: { attr: "55", argv: 55, text: "55" },
  color: { attr: "#ff8800", argv: "#ff8800", text: "#ff8800" },
  percent: { attr: "80", argv: 80, text: "80%" },
};

describe("custom-element render path (DOM stub)", () => {
  it("installed an HTMLElement global and a recording customElements registry", () => {
    expect(typeof (globalThis as { HTMLElement?: unknown }).HTMLElement).toBe("function");
    expect(typeof (globalThis as { customElements?: unknown }).customElements).toBe("object");
    expect(stub.registry).toBeTypeOf("object");
  });

  it("defineCustomElements() registers exactly the nine ins-* tags", async () => {
    const { defineCustomElements: define } = await stub.widgets;
    const tags = define();

    expect(tags).toHaveLength(9);
    expect(tags).toEqual(EXPECTED_TYPES.map((type) => `ins-${type}`));
    expect(stub.tags()).toEqual(tags);
    expect(Object.keys(stub.registry.definitions).sort()).toEqual([...tags].sort());
  });

  it("is idempotent: a second call re-registers nothing", async () => {
    const { defineCustomElements: define } = await stub.widgets;
    const before = stub.tags().length;
    const tags = define();
    expect(tags).toEqual(stub.tags());
    expect(stub.tags()).toHaveLength(before);
  });

  it("registers a constructible class per tag, subclassing WidgetElement", async () => {
    const { WidgetElement } = await stub.widgets;
    for (const type of EXPECTED_TYPES) {
      const Ctor = stub.registry.get(`ins-${type}`);
      expect(Ctor, `ins-${type} must be defined`).toBeTypeOf("function");
      expect(Object.getPrototypeOf(Ctor)).toBe(WidgetElement);
    }
  });

  it("instantiates every element without throwing, reflecting data-widget", () => {
    for (const type of EXPECTED_TYPES) {
      const Ctor = elementCtor(`ins-${type}`);
      expect(() => new Ctor()).not.toThrow();

      const el = new Ctor();
      expect(el).toBeInstanceOf(stub.HTMLElement); // the real stub base, not the fallback
      expect(el.getAttribute("data-widget")).toBe(type);
    }
  });

  it("routes the variable attribute to the core (reflection happens via bind())", () => {
    for (const type of EXPECTED_TYPES) {
      const el = new (elementCtor(`ins-${type}`))();

      el.attributeChangedCallback("variable", null, "  kitchen.temperature  ");

      expect(el.core.variable).toBe("kitchen.temperature");

      // The *attribute* path only binds the core; `bind()` is what reflects the
      // normalized name back onto the element.
      el.bind("kitchen.temperature");
      expect(el.getAttribute("variable")).toBe("kitchen.temperature");
    }
  });

  it("reflects a value change into textContent + data-value — an ignored update fails", () => {
    for (const type of EXPECTED_TYPES) {
      const el = new (elementCtor(`ins-${type}`))();

      el.attributeChangedCallback("variable", null, "device.var");
      // Baseline: a bound widget shows its neutral reading, never the update.
      const before = el.textContent;
      expect(before).not.toBe(RENDER_EXPECTATIONS[type].text);

      // `map` reads a marker, not a scalar: a bare value attribute leaves its
      // display untouched (still the placeholder), so it is seeded through the
      // public API instead — every other kind is driven by the attribute.
      if (type === "map") {
        el.update([51.5, -0.12]);
      } else {
        el.attributeChangedCallback("value", null, RENDER_EXPECTATIONS[type].attr);
      }

      // The update reached the core...
      expect(el.core.displayValue).not.toBeNull();
      // ...and the DOM: text, mirrored data-value, and a real textContent.
      expect(el.textContent).toBe(RENDER_EXPECTATIONS[type].text);
      expect(el.getAttribute("data-value")).toBe(RENDER_EXPECTATIONS[type].text);
    }
  });

  it("reacts to the public bind()/update() API the same way as the attributes", () => {
    for (const type of EXPECTED_TYPES) {
      const el = new (elementCtor(`ins-${type}`))();

      el.bind("device.var");
      expect(el.getAttribute("variable")).toBe("device.var");

      el.update(RENDER_EXPECTATIONS[type].argv);

      expect(el.textContent).toBe(RENDER_EXPECTATIONS[type].text);
      expect(el.getAttribute("data-value")).toBe(RENDER_EXPECTATIONS[type].text);
    }
  });

  it("unbinding removes the variable attribute rather than blanking it", () => {
    const el = new (elementCtor("ins-value"))();

    el.bind("temp");
    expect(el.getAttribute("variable")).toBe("temp");

    el.bind("   "); // blank -> unbound
    expect(el.getAttribute("variable")).toBeNull();
    expect(el.hasAttribute("variable")).toBe(false);
  });
});
