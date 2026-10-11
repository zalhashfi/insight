/**
 * A tiny, hand-rolled DOM stub — enough of `HTMLElement` + `customElements`
 * for the custom-element render path to run outside a browser.
 *
 * No jsdom, no happy-dom, no new dependencies: just two globals.
 *
 * ## Why it is shaped this way
 *
 * `web/src/widgets/index.ts` reads the `HTMLElement` global **once, at module
 * evaluation**:
 *
 * ```ts
 * const BaseElement =
 *   typeof HTMLElement === "undefined" ? class {} : HTMLElement;
 * ```
 *
 * So the widget module's classes must be evaluated *after* this stub is
 * installed, or they permanently inherit the no-DOM fallback class — and then
 * `WidgetElement`'s `instanceof HTMLElement` guard greys out every DOM
 * mutation. (Just swapping the global later is not enough: a class's
 * `[[Prototype]]` is fixed the moment it is defined.)
 *
 * {@link installDomStub} therefore returns a loader: {@link DomStub.load}
 * re-evaluates the widget module with a query suffix (`?dom-stub=…`), which the
 * `bun` and `vitest` loaders treat as a distinct module instance, so it is
 * evaluated fresh with the stub already in place.
 *
 * @module
 */

/** Attribute bag + text/style surface a real element exposes. */
export class StubHTMLElement {
  /** name -> value, in insertion order (mirrors real attribute order). */
  attributes: Record<string, string> = {};
  /** The element's text, as `WidgetElement`'s render sink writes it. */
  textContent = "";
  /** Inline style bag; the widget kit mutates it through a `style` sink. */
  style: Record<string, string> = {};

  setAttribute(name: string, value: unknown): void {
    this.attributes[String(name)] = String(value);
  }

  getAttribute(name: string): string | null {
    const key = String(name);
    return key in this.attributes ? this.attributes[key] : null;
  }

  hasAttribute(name: string): boolean {
    return String(name) in this.attributes;
  }

  removeAttribute(name: string): void {
    delete this.attributes[String(name)];
  }
}

/** A `customElements` registry double that records every registration. */
export class StubCustomElementsRegistry {
  /** tag -> constructor, in registration order. */
  readonly definitions: Record<string, CustomElementConstructor> = {};

  define(tag: string, ctor: CustomElementConstructor): void {
    this.definitions[tag] = ctor;
  }

  get(tag: string): CustomElementConstructor | undefined {
    return this.definitions[tag];
  }

  getName(ctor: CustomElementConstructor): string | null {
    return Object.keys(this.definitions).find((t) => this.definitions[t] === ctor) ?? null;
  }

  whenDefined(tag: string): Promise<CustomElementConstructor> {
    return Promise.resolve(this.definitions[tag]);
  }

  /** Every registered tag, in registration order. */
  get tags(): string[] {
    return Object.keys(this.definitions);
  }
}

/** The widget module surface this stub exercises. */
export interface WidgetModule {
  defineCustomElements(): string[];
  WidgetElement: { readonly tagName: string; readonly widgetType: string };
  WIDGET_CORE_CLASSES: Readonly<Record<string, unknown>>;
}

/** The public surface {@link installDomStub} hands back to a test. */
export interface DomStub {
  /** The class installed as `globalThis.HTMLElement`. */
  readonly HTMLElement: typeof StubHTMLElement;
  /** The registry installed as `globalThis.customElements`. */
  readonly registry: StubCustomElementsRegistry;
  /** Tags defined so far, in registration order. */
  tags(): string[];
  /** Evaluate the widget module with the stub active; each call is a fresh instance. */
  load<T>(): Promise<T>;
  /** The widget module, freshly evaluated with the stub active (cached). */
  readonly widgets: Promise<WidgetModule>;
  /** Restore the pre-existing `HTMLElement`/`customElements` globals. */
  restore(): void;
}

const WIDGET_MODULE_URL = "../../web/src/widgets/index.ts";

/**
 * Install the stub globals and return a loader for the widget module.
 *
 * Call as early as possible in a test file — ideally as the module's very
 * first import — so the widget module is evaluated with the stub in place.
 */
export function installDomStub(): DomStub {
  const g = globalThis as Record<string, unknown>;
  const previousHTMLElement = g.HTMLElement;
  const previousCustomElements = g.customElements;

  const registry = new StubCustomElementsRegistry();
  g.HTMLElement = StubHTMLElement;
  g.customElements = registry;

  let counter = 0;
  const load = <T,>(): Promise<T> =>
    import(/* @vite-ignore */ `${WIDGET_MODULE_URL}?dom-stub=${counter++}`) as Promise<T>;

  const widgets = load<WidgetModule>();

  return {
    HTMLElement: StubHTMLElement,
    registry,
    tags: () => registry.tags,
    load,
    widgets,
    restore(): void {
      if (previousHTMLElement === undefined) delete g.HTMLElement;
      else g.HTMLElement = previousHTMLElement;
      if (previousCustomElements === undefined) delete g.customElements;
      else g.customElements = previousCustomElements;
    },
  };
}
