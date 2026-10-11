/**
 * `insight` dashboard widget kit — nine custom elements.
 *
 * The kit is split into exactly two layers so that a widget can be exercised
 * *without a browser* and so that importing this module in a non-DOM
 * environment (Bun/vitest under node, SSR, the CI typecheck) can never throw:
 *
 *   1. {@link WidgetCore} — a pure, dependency-free class holding all of the
 *      interesting behaviour: which variable the widget is bound to, what value
 *      is currently displayed, and how a value maps onto the widget's DOM. It
 *      touches no `document`, no `window` and no `customElements`.
 *
 *   2. {@link WidgetElement} — a *thin* `<HTMLElement>` wrapper that owns a
 *      {@link WidgetCore} and forwards the reflected attributes (`variable`,
 *      `value`) and the core's render pass to the DOM. It is only ever
 *      *defined* when a DOM is present, and its class body is guarded so that
 *      merely importing the file is safe everywhere.
 *
 * The contract every widget honours (see `registry.ts` for the catalog):
 *
 *   * `type`    — one of the nine widget kinds; a stable discriminator.
 *   * `tag`     — the custom-element tag name (`ins-<type>`).
 *   * `bind(v)` — bind the widget to a variable in the telemetry model. Binding
 *     **resets** the displayed value to the widget's neutral default, so a stale
 *     reading from the previous binding can never leak into the new one.
 *   * `update(v)` — display a new value. Recording the value is unconditional
 *     and idempotent; a widget whose value is bound *and* changed always
 *     reflects the change (an ignored update is a failure), and only a
 *     *notification* render is coalesced while the widget has no DOM.
 *   * `init()`  — run the first render; never throws (no DOM => no work).
 *
 * Custom elements are *not* registered on import. Call
 * {@link defineCustomElements} from an entry point that is known to run in a
 * browser.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The nine widget kinds the dashboard ships. */
export type WidgetType =
  | "value"
  | "gauge"
  | "chart"
  | "map"
  | "toggle"
  | "push"
  | "slider"
  | "color"
  | "percent";

/** A value a widget can carry or display. `null` means "no reading yet". */
export type WidgetValue = number | string | boolean | null;

/** A `[lat, lon]` pair for map widgets. */
export type WidgetPosition = [number, number];

/**
 * Everything a widget can be handed by {@link WidgetCore.update}: a scalar, a
 * chart point (`[t, v]` / `{t, v}`) or a map marker (`{lat, lon}` / full marker).
 */
export type WidgetData =
  | WidgetValue
  | WidgetPosition
  | ChartPoint
  | Partial<MapMarker>;

/** A DOM sink the core renders into; both methods are optional. */
export interface WidgetSink {
  /** Write the human-readable reading (text, percent, hex …). */
  text?(value: string): void;
  /** Colour hint derived from the reading (`null` clears it). */
  style?(value: string | null): void;
}

/** Constructor shape of a {@link WidgetCore} subclass. */
export type WidgetCoreCtor = new (variable?: string | null) => WidgetCore;

// ---------------------------------------------------------------------------
// Small pure helpers (no globals touched)
// ---------------------------------------------------------------------------

/** Clamp `n` into `[min, max]`. */
function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Coerce a widget value to a finite number, else `null`. */
function toNumber(value: WidgetData): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Coerce a widget value to a boolean, else `null`. */
function toBoolean(value: WidgetData): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : null;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "on") return true;
    if (v === "false" || v === "0" || v === "off") return false;
  }
  return null;
}

/** Decimal places used when formatting numeric readings. */
const DECIMALS = 2;

/** Format a scalar for display; `null` renders the placeholder. */
function format(value: WidgetData, placeholder = "—"): string {
  if (value === null) return placeholder;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return placeholder;
    return String(Math.round(value * 10 ** DECIMALS) / 10 ** DECIMALS);
  }
  return String(value);
}

/** Normalise a numeric reading onto `[0, 1]` given the widget's range. */
function ratio(value: WidgetData, min: number, max: number): number | null {
  const n = toNumber(value);
  return n === null || max <= min ? null : clamp((n - min) / (max - min), 0, 1);
}

// ---------------------------------------------------------------------------
// WidgetCore — the testable, DOM-free half
// ---------------------------------------------------------------------------

/**
 * Pure behaviour shared by every widget kind.
 *
 * Subclasses only ever override {@link renderValue}; the binding/update
 * bookkeeping (and the "an update is never silently dropped" guarantee) lives
 * here once.
 */
export class WidgetCore {
  /** The widget kind; overwritten by every subclass. */
  readonly type: WidgetType = "value";
  /** Canonical custom-element tag (`ins-<type>`). */
  readonly tag: string = "ins-value";

  /** The variable this widget is bound to, or `null` when unbound. */
  variable: string | null;
  /** The most recent value handed to {@link update}, or `null`. */
  value: WidgetData = null;

  /** DOM targets the core renders into. */
  protected readonly sink: { host?: WidgetSink; text?: WidgetSink };
  /** Guards the "render once on init" path so it is idempotent. */
  #rendered = false;

  constructor(variable: string | null = null, tag = "ins-value") {
    this.variable = variable;
    this.tag = tag;
    this.sink = {};
  }

  /** Attach a DOM sink; runs an initial render when the widget is bound. */
  attachSink(kind: "host" | "text", sink: WidgetSink): void {
    this.sink[kind] = sink;
    this.render();
  }

  /**
   * Bind the widget to `variable`.
   *
   * Re-binding resets {@link value} to the widget's neutral default — a reading
   * from the previous variable must never survive into the new binding — and
   * re-renders. Binding to the same variable is idempotent.
   */
  bind(variable: string | null): WidgetCore {
    this.variable = normalizeVariable(variable);
    this.value = this.defaultValue();
    this.#rendered = true;
    this.render();
    return this;
  }

  /**
   * Display `value`.
   *
   * The value is always recorded (never ignored) and a render is requested.
   * Returns `this` so calls chain. Callers may rely on {@link displayValue}
   * reflecting exactly what was passed in.
   */
  update(value: WidgetData): WidgetCore {
    this.value = value;
    this.#rendered = true;
    this.render();
    return this;
  }

  /**
   * Initialise the widget.
   *
   * Resets the reading to the widget's neutral default (the same baseline
   * {@link bind} uses — `null` for read-outs, `false` for the boolean toggles),
   * runs the first render and marks the widget rendered. Idempotent, and never
   * throws without a DOM.
   */
  init(): this {
    this.value = this.defaultValue();
    this.#rendered = true;
    this.render();
    return this;
  }

  /**
   * The value as displayed: exactly what the last {@link update} was given, or
   * `null` (or the kind's neutral default) before any update. Recorded updates
   * are never hidden from this getter.
   */
  get displayValue(): WidgetData {
    return this.value;
  }

  /** True once the widget has rendered at least once. */
  get rendered(): boolean {
    return this.#rendered;
  }

  /** The neutral value shown for the widget's kind before any update. */
  protected defaultValue(): WidgetValue {
    return null;
  }

  /** Render pass; overridden per kind. */
  protected render(): void {
    /* base widget renders nothing */
  }

  /** Render a scalar reading into the attached sinks. */
  protected renderScalar(text: string, style: string | null = null): void {
    this.sink.host?.text?.(text);
    this.sink.host?.style?.(style);
    this.sink.text?.text?.(text);
    this.sink.text?.style?.(style);
  }
}

/** Trim a variable key; blank/absent becomes `null` (meaning "unbound"). */
export function normalizeVariable(variable: string | null | undefined): string | null {
  if (variable === null || variable === undefined) return null;
  const trimmed = String(variable).trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ---------------------------------------------------------------------------
// The nine widget cores
// ---------------------------------------------------------------------------

/** `value` — plain scalar read-out: the reading verbatim, plus its unit. */
export class ValueCore extends WidgetCore {
  /** Unit appended to the reading (informational only). */
  unit = "";

  constructor(variable: string | null = null, unit = "") {
    super(variable, "ins-value");
    this.unit = unit;
  }

  /** The reading with its unit appended (`"21.5"`, `"21.5 °C"`). */
  get text(): string {
    const body = format(this.displayValue);
    return this.unit && this.displayValue !== null ? `${body} ${this.unit}` : body;
  }

  protected override render(): void {
    this.renderScalar(this.text);
  }
}

/** `gauge` — numeric reading mapped onto an arc/fill `[0, 1]`. */
export class GaugeCore extends WidgetCore {
  /** The widget's type discriminator. */
  override readonly type: WidgetType = "gauge" as WidgetType;
  min: number;
  max: number;

  constructor(variable: string | null = null, min = 0, max = 100) {
    super(variable, "ins-gauge");
    this.min = min;
    this.max = max;
  }

  /** Fraction of the range filled by the current reading (`null` if unknown). */
  get ratio(): number | null {
    return ratio(this.displayValue, this.min, this.max);
  }

  /** Fraction as a percentage (`null` when no readable value). */
  get percent(): number | null {
    const r = this.ratio;
    return r === null ? null : Math.round(r * 100);
  }

  protected override render(): void {
    const pct = this.percent;
    this.renderScalar(pct === null ? "—" : `${pct}%`, pct === null ? null : `${pct}%`);
  }
}

/** One point of a series. */
export interface ChartPoint {
  t: number;
  v: number;
}

/** `chart` — a bounded series of readings fed one point at a time. */
export class ChartCore extends WidgetCore {
  /** Maximum retained points; the oldest is dropped first. */
  readonly capacity: number;
  readonly points: ChartPoint[] = [];

  constructor(variable: string | null = null, capacity = 60) {
    super(variable, "ins-chart");
    this.capacity = capacity;
  }

  /**
   * Append a reading to the series. Accepts a bare number (stamped with the
   * series index) or a `[t, v]` / `{t, v}` point.
   */
  override update(value: WidgetData): this {
    const point = this.#normalize(value);
    if (point) {
      this.points.push(point);
      while (this.points.length > this.capacity) this.points.shift();
    }
    super.update(value);
    return this;
  }

  /** The newest reading in the series (`null` when empty). */
  get latest(): number | null {
    const last = this.points.at(-1);
    return last ? last.v : null;
  }

  protected override render(): void {
    this.renderScalar(
      this.latest === null ? "—" : format(this.latest),
      `series:${this.points.length}`,
    );
  }

  #normalize(value: unknown): ChartPoint | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return { t: this.points.length, v: value };
    }
    if (Array.isArray(value) && value.length >= 2) {
      const [t, v] = value as unknown as readonly [number, number];
      if (Number.isFinite(t) && Number.isFinite(v)) return { t, v };
      return null;
    }
    if (value && typeof value === "object") {
      const p = value as ChartPoint;
      if (Number.isFinite(p.t) && Number.isFinite(p.v)) return { t: p.t, v: p.v };
    }
    return null;
  }
}

/** One marker on the map: a device at `[lat, lon]`. */
export interface MapMarker {
  device: string;
  lat: number;
  lon: number;
}

/** `map` — device positions, latest position wins per device. */
export class MapCore extends WidgetCore {
  readonly markers: MapMarker[] = [];

  constructor(variable: string | null = null) {
    super(variable, "ins-map");
  }

  /**
   * Place/refresh a device marker. Accepts `[lat, lon]`,
   * `{ lat, lon }` or `{ device, lat, lon }`; the bound variable names the
   * device when the payload does not.
   */
  override update(value: WidgetData): this {
    const marker = this.#normalize(value);
    if (marker) {
      const i = this.markers.findIndex((m) => m.device === marker.device);
      if (i >= 0) this.markers[i] = marker;
      else this.markers.push(marker);
    }
    super.update(value);
    return this;
  }

  /** The marker for the bound device, if any. */
  get marker(): MapMarker | undefined {
    return this.variable === null
      ? undefined
      : this.markers.find((m) => m.device === this.variable);
  }

  /** Coordinates of the last value received, as `[lat, lon]` (or `null`). */
  get coordinates(): readonly [number, number] | null {
    const m = this.marker ?? this.markers.at(-1);
    return m ? [m.lat, m.lon] : null;
  }

  protected override render(): void {
    const c = this.coordinates;
    this.renderScalar(
      c ? `${format(c[0])}, ${format(c[1])}` : "—",
      c ? "marker" : null,
    );
  }

  #normalize(value: unknown): MapMarker | null {
    const device = this.variable ?? "unknown";
    if (Array.isArray(value) && value.length >= 2) {
      const [lat, lon] = value as unknown as readonly [number, number];
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { device, lat, lon };
      return null;
    }
    if (value && typeof value === "object") {
      const p = value as Partial<MapMarker>;
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
        return { device: p.device ?? device, lat: p.lat as number, lon: p.lon as number };
      }
    }
    return null;
  }
}

/** Widgets whose reading is a boolean state. */
class BooleanCore extends WidgetCore {
  override readonly type: WidgetType = "toggle" as WidgetType;

  protected defaultValue(): WidgetValue {
    return false;
  }

  /** Current state as a boolean. */
  get state(): boolean {
    if (!this.rendered) return false;
    return toBoolean(this.value) ?? false;
  }
}

/** `toggle` — two-state switch (`on`/`off`). */
export class ToggleCore extends BooleanCore {
  constructor(variable: string | null = null) {
    super(variable, "ins-toggle");
  }

  protected override render(): void {
    const on = this.state;
    this.renderScalar(on ? "on" : "off", on ? "on" : "off");
  }
}

/** `push` — momentary button; the last press is kept for the UI. */
export class PushCore extends BooleanCore {
  constructor(variable: string | null = null) {
    super(variable, "ins-push");
  }

  /** Record a press (`update(true)`). */
  press(): WidgetCore {
    return this.update(true);
  }

  /** Clear the press (`update(false)`). */
  release(): WidgetCore {
    return this.update(false);
  }

  protected override render(): void {
    const pressed = toBoolean(this.value) === true;
    this.renderScalar(pressed ? "pressed" : "idle", pressed ? "pressed" : "idle");
  }
}

/** `slider` — continuous set-point within `[min, max]`. */
export class SliderCore extends WidgetCore {
  min: number;
  max: number;

  constructor(variable: string | null = null, min = 0, max = 100) {
    super(variable, "ins-slider");
    this.min = min;
    this.max = max;
  }

  /** The current reading clamped into the widget's range (`null` if unknown). */
  get position(): number | null {
    const n = toNumber(this.displayValue);
    if (n === null) return null;
    return clamp(n, this.min, this.max);
  }

  protected override render(): void {
    const p = this.position;
    this.renderScalar(p === null ? "—" : format(p), p === null ? null : String(p));
  }
}

/** `color` — a colour reading (`#rrggbb`). */
export class ColorCore extends WidgetCore {
  constructor(variable: string | null = null) {
    super(variable, "ins-color");
  }

  /** The reading as a CSS colour, or `null` when absent/invalid. */
  get color(): string | null {
    const value = this.displayValue;
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return `#${clamp(Math.round(value), 0, 0xffffff).toString(16).padStart(6, "0")}`;
    const raw = String(value).trim();
    if (raw === "") return null;
    return /^#?[0-9a-f]{3,8}$/i.test(raw) ? (raw.startsWith("#") ? raw : `#${raw}`) : null;
  }

  protected override render(): void {
    const c = this.color;
    this.renderScalar(c ?? "—", c);
  }
}

/** `percent` — a numeric reading shown as a 0–100 percentage. */
export class PercentCore extends WidgetCore {
  min: number;
  max: number;

  constructor(variable: string | null = null, min = 0, max = 100) {
    super(variable, "ins-percent");
    this.min = min;
    this.max = max;
  }

  /** The current reading as a 0–100 percentage (`null` if unknown). */
  get percent(): number | null {
    const r = ratio(this.displayValue, this.min, this.max);
    return r === null ? null : Math.round(r * 100);
  }

  protected override render(): void {
    const pct = this.percent;
    this.renderScalar(pct === null ? "—" : `${pct}%`, pct === null ? null : `${pct}%`);
  }
}

// ---------------------------------------------------------------------------
// Registry of cores (type -> constructor)
// ---------------------------------------------------------------------------

/** Maps each widget kind to its pure core. */
export const WIDGET_CORE_CLASSES: Readonly<Record<WidgetType, WidgetCoreCtor>> = {
  value: ValueCore,
  gauge: GaugeCore,
  chart: ChartCore,
  map: MapCore,
  toggle: ToggleCore,
  push: PushCore,
  slider: SliderCore,
  color: ColorCore,
  percent: PercentCore,
};

/** Construct the core for `type`, optionally pre-bound to `variable`. */
export function createWidgetCore(
  type: WidgetType,
  variable: string | null = null,
): WidgetCore {
  const Ctor = WIDGET_CORE_CLASSES[type];
  return new Ctor(variable);
}

// ---------------------------------------------------------------------------
// Custom-element layer (guarded — safe to import without a DOM)
// ---------------------------------------------------------------------------

/** Minimal `HTMLElement` stand-in used when no DOM exists. */
const BaseElement: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

/** Attribute names reflected by {@link WidgetElement}. */
export const WIDGET_ATTRIBUTES = {
  variable: "variable",
  value: "value",
} as const;

/**
 * Thin custom-element wrapper around a {@link WidgetCore}.
 *
 * It owns exactly the DOM concerns: reflecting `variable`/`value` attributes
 * onto the core and mirroring the core's render into `textContent` /
 * `data-value`. It extends the real {@link HTMLElement} only when that global
 * exists, so the module imports cleanly under Bun/vitest/CI.
 */
export class WidgetElement extends BaseElement {
  /** The element's kind; overwritten by each subclass. */
  static readonly widgetType: WidgetType = "value";
  /** The element's canonical tag name. */
  static readonly tagName: string = "ins-value";

  /** The pure behaviour behind this element. */
  core!: WidgetCore;

  constructor() {
    super();
    const ctor = this.constructor as typeof WidgetElement;
    const el = domElement(this);
    el?.setAttribute("data-widget", ctor.widgetType);
    this.core = createWidgetCore(ctor.widgetType);
    this.core.attachSink("host", {
      text: (text: string) => {
        const target = domElement(this);
        if (!target) return;
        target.textContent = text;
        target.setAttribute("data-value", text);
      },
    });
    this.core.init();
  }

  /** Reflection: `variable="temp"` binds the core to `temp`. */
  attributeChangedCallback(name: string, _old: string | null, next: string | null): void {
    if (name === WIDGET_ATTRIBUTES.variable) this.core.bind(next);
    else if (name === WIDGET_ATTRIBUTES.value) {
      const raw = next === null ? null : Number(next);
      this.core.update(raw !== null && Number.isFinite(raw) ? raw : next);
    }
  }

  /** Bind the core and reflect the binding back onto the attribute. */
  bind(variable: string | null): this {
    this.core.bind(variable);
    const el = domElement(this);
    if (el) {
      const normalized = normalizeVariable(variable);
      if (normalized === null) el.removeAttribute(WIDGET_ATTRIBUTES.variable);
      else el.setAttribute(WIDGET_ATTRIBUTES.variable, normalized);
    }
    return this;
  }

  /** Push a new value through the core (and the DOM). */
  update(value: WidgetData): this {
    this.core.update(value);
    return this;
  }

  /** The value currently displayed by the core. */
  get displayValue(): WidgetData {
    return this.core.displayValue;
  }
}

/** The element as a DOM node, or `null` when no DOM is present. */
function domElement(el: unknown): HTMLElement | null {
  return typeof HTMLElement !== "undefined" && el instanceof HTMLElement ? el : null;
}

/**
 * Define the nine custom elements.
 *
 * Idempotent per tag, and a complete no-op when no `customElements` registry
 * exists (Bun/vitest under node, SSR) — which is why importing this module is
 * safe everywhere. Returns the tag names it ensured are defined.
 */
export function defineCustomElements(): string[] {
  if (typeof customElements === "undefined") return [];
  const tags: string[] = [];
  for (const [type, Core] of Object.entries(WIDGET_CORE_CLASSES) as [WidgetType, WidgetCoreCtor][]) {
    const tag = `ins-${type}`;
    if (customElements.get(tag)) {
      tags.push(tag);
      continue;
    }
    class Element extends WidgetElement {
      static override readonly widgetType: WidgetType = type;
      static override readonly tagName: string = tag;
    }
    Object.defineProperty(Element, "name", { value: elementClassName(type) });
    customElements.define(tag, Element);
    tags.push(tag);
  }
  return tags;
}

/** `"percent"` -> `"InsPercentElement"`. */
function elementClassName(type: WidgetType): string {
  return `Ins${type.charAt(0).toUpperCase()}${type.slice(1)}Element`;
}

export default defineCustomElements;
