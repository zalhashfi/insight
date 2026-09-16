// <iot-api> — fetches and displays live data from an external REST/JSON API.
// Self-contained: manages its own fetch polling and JSON path resolution.

const TEMPLATE = `
  <style>
    :host {
      display: block;
      height: 100%;
      width: 100%;
      box-sizing: border-box;
      container-type: size;
      font-family: system-ui, -apple-system, sans-serif;
      color: var(--color-text, #171717);
    }
    .card {
      display: grid;
      grid-template-rows: auto 1fr auto;
      height: 100%;
      width: 100%;
      box-sizing: border-box;
      padding: clamp(10px, 7cqmin, 20px);
      background: var(--color-bg-elevated, white);
      border: 1px solid var(--color-border, #e5e5e5);
      border-radius: 10px;
      transition: border-color 120ms ease, box-shadow 120ms ease;
      overflow: hidden;
    }
    .card:hover { border-color: var(--color-border-strong, #d4d4d4); }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5em;
      min-width: 0;
    }
    .title-group {
      display: flex;
      align-items: center;
      gap: 0.4em;
      min-width: 0;
    }
    .title {
      font-size: 11px;
      color: var(--color-text-muted, #525252);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 600;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      background: #a3a3a3;
      transition: background-color 200ms ease;
    }
    .status-dot.ok { background: #10b981; box-shadow: 0 0 6px rgba(16, 185, 129, 0.4); }
    .status-dot.fetching { background: #f59e0b; animation: pulse 1s infinite; }
    .status-dot.error { background: #ef4444; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .reading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-width: 0;
      min-height: 0;
      line-height: 1;
      text-align: center;
      padding: 4px 0;
    }
    .val-wrap {
      display: flex;
      align-items: baseline;
      justify-content: center;
      gap: 0.25em;
      max-width: 100%;
    }
    .value {
      font-size: clamp(20px, 26cqmin, 56px);
      font-weight: 700;
      line-height: 1;
      letter-spacing: -0.02em;
      color: var(--color-text, #171717);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .unit {
      font-size: clamp(10px, 8cqmin, 18px);
      color: var(--color-text-subtle, #737373);
      font-weight: 500;
    }
    .subtext {
      margin-top: 6px;
      font-size: clamp(9px, 5cqmin, 12px);
      color: var(--color-text-muted, #737373);
      max-width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .subtext.err {
      color: #ef4444;
      font-weight: 500;
    }
    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5em;
      font-size: 9px;
      color: var(--color-text-faint, #a3a3a3);
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }
    .endpoint {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 55%;
      opacity: 0.8;
    }
  </style>
  <div class="card">
    <div class="header">
      <div class="title-group">
        <div class="status-dot"></div>
        <div class="title">External API</div>
      </div>
      <div class="endpoint"></div>
    </div>
    <div class="reading">
      <div class="val-wrap">
        <span class="value">—</span><span class="unit"></span>
      </div>
      <div class="subtext"></div>
    </div>
    <div class="footer">
      <div class="ts"></div>
      <div class="cadence"></div>
    </div>
  </div>
`;

function getNestedValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  const cleanPath = path.trim();
  if (!cleanPath) return obj;

  // Split by dots and bracket notations, e.g. "data[0].val" or "items.0.price"
  const tokens = cleanPath
    .replace(/\[(\w+)\]/g, '.$1')
    .replace(/^\./, '')
    .split('.');

  let curr: unknown = obj;
  for (const token of tokens) {
    if (curr === null || curr === undefined || typeof curr !== 'object') return undefined;
    curr = (curr as Record<string, unknown>)[token];
  }
  return curr;
}

export class IotApiElement extends HTMLElement {
  #timer: ReturnType<typeof setInterval> | null = null;
  #abortController: AbortController | null = null;
  #value: unknown = null;
  #ts: number | null = null;
  #status: 'idle' | 'fetching' | 'ok' | 'error' = 'idle';
  #statusMsg: string = '';

  static get observedAttributes() {
    return ['data-title', 'data-url', 'data-path', 'data-unit', 'data-interval', 'data-headers'];
  }

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
  }

  connectedCallback() {
    this.restart();
  }

  disconnectedCallback() {
    this.cleanup();
  }

  attributeChangedCallback(name: string, oldVal: string, newVal: string) {
    if (oldVal === newVal) return;
    if (name === 'data-title' || name === 'data-unit') {
      this.render();
    } else {
      this.restart();
    }
  }

  private cleanup() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#abortController) {
      this.#abortController.abort();
      this.#abortController = null;
    }
  }

  private restart() {
    this.cleanup();
    this.render();
    const url = (this.getAttribute('data-url') ?? '').trim();
    if (!url) {
      this.#status = 'idle';
      this.#statusMsg = 'Configure API URL in widget settings';
      this.render();
      return;
    }

    const rawInterval = Number(this.getAttribute('data-interval'));
    const intervalSec = Number.isFinite(rawInterval) && rawInterval >= 3 ? rawInterval : 15;

    this.poll();
    this.#timer = setInterval(() => this.poll(), intervalSec * 1000);
  }

  private async poll() {
    const url = (this.getAttribute('data-url') ?? '').trim();
    if (!url) return;

    if (this.#abortController) {
      this.#abortController.abort();
    }
    this.#abortController = new AbortController();

    this.#status = 'fetching';
    this.render();

    try {
      let customHeaders: Record<string, string> = {};
      const rawHeaders = (this.getAttribute('data-headers') ?? '').trim();
      if (rawHeaders) {
        try {
          const parsed = JSON.parse(rawHeaders);
          if (typeof parsed === 'object' && parsed !== null) {
            customHeaders = parsed;
          }
        } catch {
          // ignore header parse errors
        }
      }

      const res = await fetch(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          ...customHeaders,
        },
        signal: this.#abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      let data: unknown;
      if (contentType.includes('application/json')) {
        data = await res.json();
      } else {
        const text = await res.text();
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      const path = (this.getAttribute('data-path') ?? '').trim();
      const extracted = getNestedValue(data, path);

      if (extracted === undefined) {
        this.#status = 'error';
        this.#statusMsg = `Field "${path}" not found`;
      } else if (typeof extracted === 'object' && extracted !== null) {
        this.#status = 'ok';
        this.#statusMsg = '';
        this.#value = JSON.stringify(extracted);
        this.#ts = Math.floor(Date.now() / 1000);
      } else {
        this.#status = 'ok';
        this.#statusMsg = '';
        this.#value = extracted;
        this.#ts = Math.floor(Date.now() / 1000);
      }
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') return;
      this.#status = 'error';
      this.#statusMsg = (err as Error).message || 'Failed to fetch API';
    } finally {
      this.render();
    }
  }

  private render() {
    const shadow = this.shadowRoot;
    if (!shadow) return;

    const titleEl = shadow.querySelector('.title')!;
    const valEl = shadow.querySelector('.value')!;
    const unitEl = shadow.querySelector('.unit')!;
    const subtextEl = shadow.querySelector('.subtext')!;
    const dotEl = shadow.querySelector('.status-dot')!;
    const tsEl = shadow.querySelector('.ts')!;
    const endpointEl = shadow.querySelector('.endpoint')!;
    const cadenceEl = shadow.querySelector('.cadence')!;

    const title = this.getAttribute('data-title') || 'External API';
    const unit = this.getAttribute('data-unit') ?? '';
    const url = (this.getAttribute('data-url') ?? '').trim();

    titleEl.textContent = title;
    unitEl.textContent = unit;

    try {
      endpointEl.textContent = url ? new URL(url).hostname : '';
    } catch {
      endpointEl.textContent = url.slice(0, 20);
    }

    dotEl.className = `status-dot ${this.#status}`;

    if (this.#value !== null && this.#value !== undefined) {
      if (typeof this.#value === 'number') {
        valEl.textContent = this.#value.toLocaleString(undefined, { maximumFractionDigits: 4 });
      } else {
        valEl.textContent = String(this.#value);
      }
    } else {
      valEl.textContent = '—';
    }

    if (this.#status === 'error') {
      subtextEl.textContent = this.#statusMsg;
      subtextEl.className = 'subtext err';
    } else if (this.#status === 'idle') {
      subtextEl.textContent = this.#statusMsg;
      subtextEl.className = 'subtext';
    } else {
      subtextEl.textContent = '';
      subtextEl.className = 'subtext';
    }

    tsEl.textContent = this.#ts ? `Updated ${new Date(this.#ts * 1000).toLocaleTimeString()}` : '';

    const rawInterval = Number(this.getAttribute('data-interval'));
    const intervalSec = Number.isFinite(rawInterval) && rawInterval >= 3 ? rawInterval : 15;
    cadenceEl.textContent = url ? `every ${intervalSec}s` : '';
  }
}
