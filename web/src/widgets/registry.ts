/**
 * Dashboard widget catalog.
 *
 * {@link WIDGET_CATALOG} is the single source of truth for *which* widgets the
 * dashboard can place, in which order the palette shows them, and what each one
 * is bound to by default. The grid editor (a separate task) consumes this
 * catalog; it must never hard-code a list of tags of its own.
 *
 * Every entry maps 1:1 onto a {@link WidgetCore} / custom element exported by
 * `./index.ts`:
 *
 *   * `type`            — the widget kind (nine kinds, one entry each).
 *   * `tag`             — the custom-element tag (`ins-<type>`).
 *   * `label`           — human label for the palette.
 *   * `defaultBinding`  — variable the widget binds to when dropped on the
 *                         canvas, or `null` for widgets that are meaningful
 *                         without a telemetry variable (a manual `push`).
 *   * `bindable`        — whether the widget accepts a variable binding.
 *   * `valueKind`       — the scalar shape the widget reads, so the editor can
 *                         offer sensible variables.
 */

import {
  type WidgetType,
  createWidgetCore,
  normalizeVariable,
  type WidgetCore,
} from "./index";

/** The scalar shape a widget reads; `point`/`marker` are structured readings. */
export type WidgetValueKind = "number" | "boolean" | "string" | "point" | "marker";

/** One entry in {@link WIDGET_CATALOG}. */
export interface WidgetDescriptor {
  /** Widget kind; also the catalog key. */
  readonly type: WidgetType;
  /** Custom-element tag name (`ins-<type>`). */
  readonly tag: string;
  /** Human-readable palette label. */
  readonly label: string;
  /** One-line purpose, used as the palette tooltip. */
  readonly description: string;
  /** Variable bound to when the widget is first placed (`null` = unbound). */
  readonly defaultBinding: string | null;
  /** Whether the widget accepts a variable binding. */
  readonly bindable: boolean;
  /** The scalar shape the widget reads. */
  readonly valueKind: WidgetValueKind;
}

/** The nine widgets, in palette order. */
export const WIDGET_CATALOG: readonly WidgetDescriptor[] = Object.freeze([
  Object.freeze({
    type: "value" as const,
    tag: "ins-value",
    label: "Value",
    description: "Plain numeric/string read-out with an optional unit.",
    defaultBinding: "temperature",
    bindable: true,
    valueKind: "number" as const,
  }),
  Object.freeze({
    type: "gauge" as const,
    tag: "ins-gauge",
    label: "Gauge",
    description: "Reading mapped onto an arc between a minimum and maximum.",
    defaultBinding: "humidity",
    bindable: true,
    valueKind: "number" as const,
  }),
  Object.freeze({
    type: "chart" as const,
    tag: "ins-chart",
    label: "Chart",
    description: "Bounded time series of a variable's readings.",
    defaultBinding: "temperature",
    bindable: true,
    valueKind: "point" as const,
  }),
  Object.freeze({
    type: "map" as const,
    tag: "ins-map",
    label: "Map",
    description: "Latest known position of a device.",
    defaultBinding: "location",
    bindable: true,
    valueKind: "marker" as const,
  }),
  Object.freeze({
    type: "toggle" as const,
    tag: "ins-toggle",
    label: "Toggle",
    description: "Two-state switch (on/off).",
    defaultBinding: "relay",
    bindable: true,
    valueKind: "boolean" as const,
  }),
  Object.freeze({
    type: "push" as const,
    tag: "ins-push",
    label: "Push button",
    description: "Momentary action button; needs no variable to operate.",
    defaultBinding: null,
    bindable: false,
    valueKind: "boolean" as const,
  }),
  Object.freeze({
    type: "slider" as const,
    tag: "ins-slider",
    label: "Slider",
    description: "Continuous set-point within a range.",
    defaultBinding: "setpoint",
    bindable: true,
    valueKind: "number" as const,
  }),
  Object.freeze({
    type: "color" as const,
    tag: "ins-color",
    label: "Colour",
    description: "Colour reading rendered as a `#rrggbb` swatch.",
    defaultBinding: "led",
    bindable: true,
    valueKind: "string" as const,
  }),
  Object.freeze({
    type: "percent" as const,
    tag: "ins-percent",
    label: "Percent",
    description: "Numeric reading shown as a 0–100 percentage.",
    defaultBinding: "battery",
    bindable: true,
    valueKind: "number" as const,
  }),
]);

/** Every widget kind, in catalog order. */
export const WIDGET_TYPES: readonly WidgetType[] = Object.freeze(
  WIDGET_CATALOG.map((widget) => widget.type),
);

/** Look a widget up by its kind, or by its tag name. */
export function getWidgetDescriptor(
  key: WidgetType | string,
): WidgetDescriptor | undefined {
  const normalized = key.trim().toLowerCase();
  return WIDGET_CATALOG.find(
    (widget) => widget.type === normalized || widget.tag === normalized,
  );
}

/** Every descriptor whose tag matches `key`'s custom-element tag. */
export function tagFor(type: WidgetType): string {
  const descriptor = getWidgetDescriptor(type);
  if (!descriptor) throw new Error(`unknown widget type: ${type}`);
  return descriptor.tag;
}

/**
 * Instantiate the core for a catalog entry, bound to `variable` when one is
 * given (falling back to the descriptor's {@link WidgetDescriptor.defaultBinding}).
 * Throws for an unknown type so a bad catalog key fails loudly.
 */
export function createBoundWidget(
  type: WidgetType,
  variable?: string | null,
): WidgetCore {
  const descriptor = getWidgetDescriptor(type);
  if (!descriptor) throw new Error(`unknown widget type: ${type}`);
  const binding = normalizeVariable(variable ?? descriptor.defaultBinding);
  return createWidgetCore(descriptor.type, binding);
}

export default WIDGET_CATALOG;
