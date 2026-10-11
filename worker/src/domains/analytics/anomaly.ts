/**
 * Per-variable **anomaly detection** over an injected series seam and clock —
 * the analytic core of FR-AI-05 (`ambang + z-score/EWMA per variable`).
 *
 * ## Why this unit exists
 *
 * A variable is a stream: temperature climbing toward an unsafe band, a current
 * that spikes, a pressure that drifts and never recovers. A dashboard shows the
 * number; it does not tell anyone that the number is *wrong*. This module is the
 * thing that says so, so that a notification can be raised **before** the
 * problem grows (spec §57).
 *
 * It is deliberately small and pure: it reads samples through one seam
 * ({@link SeriesReader}), reads time through another ({@link Clock}), and hands
 * its verdict out through a third ({@link EmitAnomaly}). It holds **no store and
 * no policy of its own beyond the numbers it is configured with** — the caller
 * owns what a variable's normal looks like.
 *
 * ## The three detectors (documented choice)
 *
 * One detection language, three ways to decide "abnormal" (FR-AI-05). They
 * compose per variable rather than being exclusive: a variable may carry a
 * static band *and* a learned baseline, and the first rule that fires wins.
 *
 *   1. **Static threshold** — {@link ThresholdDetector}. `value > high` fires
 *      `above_range`; `value < low` fires `below_range`. The band `[low, high]`
 *      is **inclusive**: a value exactly on a bound is normal. This is the
 *      operator a human writes down ("flag anything over 80 °C"), and it needs
 *      no history.
 *   2. **Z-score** — {@link ZScoreDetector}. Over the trailing
 *      {@link StatisticsWindow} of *previous* accepted samples it computes a
 *      rolling mean and a **sample** standard deviation
 *      (`n - 1`, Bessel's correction), then measures how far the new value sits
 *      from that mean in sigmas. Past {@link ZScoreDetector} `sigma` it fires.
 *      The value under test is **excluded** from its own baseline: scoring a
 *      point against a mean that already contains it damps exactly the spikes
 *      the detector exists to catch, and at `n = 1` would make every deviation
 *      zero.
 *   3. **EWMA** — {@link EwmaDetector}. A smoothing factor `alpha` folds every
 *      accepted sample into an exponentially weighted moving average — the
 *      "smoothed baseline" — and a companion deviation band widens by the same
 *      factor. A reading that leaves `baseline ± k·deviation` fires. This is the
 *      detector that survives a **sustained shift**: the baseline crawls toward
 *      the new level, so a step change is anomalous only while the baseline has
 *      not yet caught up — and it *does* fire on the first samples of the step,
 *      which is the whole point.
 *
 * ### Rejected alternative: one function with a `mode` switch
 *
 * Modelling the three as a single entry point keyed by a string would force
 * every caller to carry every knob (a z-score's window is meaningless to a
 * threshold; an EWMA's alpha is meaningless to both) and would push the "does
 * this detector need history" question into a runtime branch. Three small
 * detectors behind one interface each carry only their own configuration.
 *
 * ### Rejected alternative: anomaly when `|z| > sigma` *or* `|z| >= sigma`
 *
 * The comparison is defined **strictly**: `|z| > sigma` fires. A value exactly
 * `sigma` sigmas out is *at* the limit, not past it, which keeps a configured
 * `3σ` meaning literally "more than three sigma" and makes the boundary case
 * assertable rather than accidental.
 *
 * ## Determinism under the injected clock
 *
 * Time enters in exactly two places: the `at` an observation carries (stamped
 * from the {@link Clock}, never `Date.now`), and the `[from, to]` window a
 * series is read over. Nothing here sleeps, schedules or reads a host clock, so
 * a test that owns the clock and the series replays byte-for-byte — the same
 * input always yields the same verdict and the same event.
 */

import { defaultClock, type Clock } from "../../platform/lib/clock";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Sample standard deviation (Bessel's correction, divisor `n - 1`).
 *
 * A z-score compares a new reading against a *sample* of the process, not
 * against the process's true parameters, so the sample estimator is the honest
 * one. At `n = 1` it is undefined — {@link meanStddev} reports `0` and the
 * detector treats the baseline as unusable rather than dividing by a
 * zero-width band (see {@link ZScoreDetector}).
 */
export const VARIANCE_DIVISOR_OFFSET = 1 as const;

/**
 * Default smoothing factor for {@link EwmaDetector.alpha}. `0.3` weights the
 * last few samples meaningfully while still needing several to move the
 * baseline — a sustained step trips, steady noise does not.
 */
export const DEFAULT_EWMA_ALPHA = 0.3 as const;

/**
 * Default deviation-band width for {@link EwmaDetector.k}. Three sigma, the
 * same shape as the conventional `3σ` control limit.
 */
export const DEFAULT_EWMA_K = 3 as const;

/** Stable, machine-readable reasons an anomaly is reported. */
export type AnomalyReason =
  | "above_range"
  | "below_range"
  | "z_score_high"
  | "z_score_low"
  | "ewma_high"
  | "ewma_low";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Read seam. Returns the variable's samples over an inclusive `[from, to]`
 * window, **oldest first**.
 *
 * The detector owns no storage: the shard ring, a Durable Object, or a test's
 * plain array all answer this shape. Non-numeric samples (`value: null` — a
 * cleared variable) are the reader's to drop or pass; the detector ignores them
 * either way, so a gap never becomes a phantom reading.
 */
export type SeriesReader = (
  variable: string,
  from: number,
  to: number,
) => Promise<readonly Sample[]> | readonly Sample[];

/**
 * Emit seam. Called **once per anomaly**, never for a normal reading.
 *
 * The event carries the variable, the value that tripped it and a stable
 * machine-readable reason, so a downstream notification can route on `reason`
 * without parsing prose. Returning a promise lets a sink persist the event
 * (the integration/notification path) while a test passes a plain recorder.
 */
export type EmitAnomaly = (event: AnomalyEvent) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One sample as the detector reads it. Mirrors the read surface's point. */
export interface Sample {
  readonly variable: string;
  readonly value: number | null;
  /** Unix epoch milliseconds the reading was taken. */
  readonly ts: number;
}

/** The anomaly handed to {@link EmitAnomaly}, and returned by every `feed`. */
export interface AnomalyEvent {
  readonly variable: string;
  /** The reading that tripped the detector. */
  readonly value: number;
  readonly reason: AnomalyReason;
  /** The instant of the reading (injected clock). */
  readonly ts: number;
  /**
   * The baseline the reading was judged against, when the detector has one
   * (z-score's mean, EWMA's smoothed average). Absent for a static threshold,
   * which judges against a fixed band and has no learned baseline to report.
   */
  readonly baseline?: number;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Summary of a sample of readings: the rolling mean and its standard deviation. */
export interface MeanStddev {
  /** Arithmetic mean of the sample. `0` for an empty sample. */
  readonly mean: number;
  /** Sample standard deviation (Bessel). `0` when `n < 2`. */
  readonly stddev: number;
  /** Sample size. */
  readonly n: number;
}

/**
 * Compute the rolling mean and sample standard deviation of `values`.
 *
 * Pure and total: an empty sample is `{ mean: 0, stddev: 0, n: 0 }`, and a
 * single value is `{ mean: v, stddev: 0, n: 1 }` — the degenerate band the
 * z-score detector refuses to divide by.
 */
export function meanStddev(values: readonly number[]): MeanStddev {
  const n = values.length;
  if (n === 0) return { mean: 0, stddev: 0, n };

  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / n;
  if (n === 1) return { mean, stddev: 0, n };

  let squared = 0;
  for (const value of values) {
    const delta = value - mean;
    squared += delta * delta;
  }

  return { mean, stddev: Math.sqrt(squared / (n - VARIANCE_DIVISOR_OFFSET)), n };
}

// ---------------------------------------------------------------------------
// Detector interface
// ---------------------------------------------------------------------------

/**
 * What every detector can be asked and told.
 *
 * `warmPending` and `warm` are split so the *reading path* stays synchronous:
 * {@link AnomalyDetector.feed} is pure arithmetic over in-memory state, and the
 * only I/O — filling the rolling window from the {@link SeriesReader} — happens
 * once, at construction, through {@link AnomalyDetector.warm}. A detector that
 * needs no history (`warmPending === false`) warms to a no-op, so a threshold
 * variable never touches the series seam.
 */
export interface AnomalyDetector {
  readonly variable: string;
  /** The rule that produced it, for reporting. */
  readonly kind: DetectorKind;
  /** True when this detector reads history through the series seam. */
  readonly warmPending: boolean;
  /** A reading that has already left the detector's own state, if abnormal. */
  readonly lastAnomaly: AnomalyEvent | null;
  /** Fill the rolling window before the first {@link AnomalyDetector.feed}. */
  warm(samples: readonly Sample[]): void;
  /**
   * Judge one reading. Returns the anomaly when abnormal, `null` when normal.
   *
   * Every reading is remembered (the caller stamps `ts` from the clock), so the
   * rolling window is fed by the live stream as well as by {@link
   * AnomalyDetector.warm}.
   */
  feed(value: number, ts: number): AnomalyEvent | null;
}

/** The kinds of detector a variable may be configured with (FR-AI-05). */
export type DetectorKind = "threshold" | "z_score" | "ewma";

/**
 * State shared by the rolling-window detectors: the last accepted readings, in
 * order. Kept as a small class so its trimming rule lives in exactly one place
 * and both the z-score and any future windowed detector inherit it.
 */
class RollingWindow {
  readonly #size: number;
  readonly #values: number[] = [];

  constructor(size: number) {
    // A window must be able to hold something; a caller asking for `0` gets a
    // window that is always empty, which the detectors read as "not ready".
    this.#size = Math.max(0, Math.floor(size));
  }

  /** Append a reading, dropping the oldest past `size`. */
  push(value: number): void {
    this.#values.push(value);
    const overflow = this.#values.length - this.#size;
    if (overflow > 0) this.#values.splice(0, overflow);
  }

  /** The retained readings, oldest first. */
  values(): readonly number[] {
    return this.#values;
  }

  /** True once the window holds `size` readings (so the baseline is complete). */
  get full(): boolean {
    return this.#size > 0 && this.#values.length >= this.#size;
  }

  get size(): number {
    return this.#size;
  }
}

// ---------------------------------------------------------------------------
// Threshold detector
// ---------------------------------------------------------------------------

/** A static band `[low, high]`, either bound optional, both inclusive. */
export interface ThresholdDetectorOptions {
  readonly variable: string;
  /** Readings strictly **above** this fire `above_range`. Omit for no ceiling. */
  readonly high?: number;
  /** Readings strictly **below** this fire `below_range`. Omit for no floor. */
  readonly low?: number;
}

/**
 * Static threshold: the operator a human writes down.
 *
 * The band is inclusive — `value === high` is normal, `value > high` is not —
 * so a configured `high: 30` means "flag what is over thirty", matching the
 * `gt`/`lt` the automation engine already speaks. A detector with neither bound
 * can never fire (there is no band to leave); one with a single bound watches
 * only that side.
 */
export class ThresholdDetector implements AnomalyDetector {
  readonly variable: string;
  readonly kind = "threshold" as const;
  readonly warmPending = false;
  #lastAnomaly: AnomalyEvent | null = null;

  readonly #high: number | undefined;
  readonly #low: number | undefined;

  constructor(options: ThresholdDetectorOptions) {
    this.variable = options.variable;
    this.#high = options.high;
    this.#low = options.low;
  }

  get lastAnomaly(): AnomalyEvent | null {
    return this.#lastAnomaly;
  }

  /** No history to fill: a static band is a pure function of the reading. */
  warm(): void {}

  feed(value: number, ts: number): AnomalyEvent | null {
    if (this.#high !== undefined && value > this.#high) {
      return this.#record(value, ts, "above_range");
    }
    if (this.#low !== undefined && value < this.#low) {
      return this.#record(value, ts, "below_range");
    }
    return null;
  }

  #record(value: number, ts: number, reason: AnomalyReason): AnomalyEvent {
    const event: AnomalyEvent = { variable: this.variable, value, reason, ts };
    this.#lastAnomaly = event;
    return event;
  }
}

// ---------------------------------------------------------------------------
// Z-score detector
// ---------------------------------------------------------------------------

/** Rolling-baseline configuration for {@link ZScoreDetector}. */
export interface ZScoreDetectorOptions {
  readonly variable: string;
  /** Sigma multiplier: fire when `|value - mean| > sigma · stddev`. */
  readonly sigma: number;
  /**
   * Number of *previous* accepted readings that form the baseline. Must be at
   * least {@link MIN_ZSCORE_WINDOW} before the detector fires; until the window
   * is full every reading is normal, so the baseline is never a half-built one.
   */
  readonly window: number;
}

/**
 * The smallest window a z-score can be computed over: two readings give a
 * sample standard deviation at all (`n - 1 = 1`). Below it the detector is warm
 * -up, not anomalous.
 */
export const MIN_ZSCORE_WINDOW = 2 as const;

/**
 * Rolling z-score: how many sigmas the new reading sits from recent history.
 *
 * Fires when `|value - mean| > sigma · stddev` over the trailing `window`
 * readings. Two guards make it quiet rather than noisy during warm-up: a
 * baseline shorter than {@link MIN_ZSCORE_WINDOW} (no dispersion to speak of)
 * and a **zero** standard deviation (a perfectly flat baseline) both report
 * normal — with `stddev === 0` any difference would be an infinite z-score, and
 * a flat line must not turn its first genuine step into a division by zero.
 */
export class ZScoreDetector implements AnomalyDetector {
  readonly variable: string;
  readonly kind = "z_score" as const;
  readonly warmPending = true;
  #lastAnomaly: AnomalyEvent | null = null;

  readonly #sigma: number;
  readonly #window: RollingWindow;

  constructor(options: ZScoreDetectorOptions) {
    this.variable = options.variable;
    this.#sigma = options.sigma;
    this.#window = new RollingWindow(options.window);
  }

  get lastAnomaly(): AnomalyEvent | null {
    return this.#lastAnomaly;
  }

  /**
   * Prime the window from history. Only the most recent `window` numeric
   * readings survive, oldest first, so the baseline matches what the live
   * stream would have built.
   */
  warm(samples: readonly Sample[]): void {
    for (const sample of samples) {
      if (sample.value !== null) this.#window.push(sample.value);
    }
  }

  /** The rolling baseline, exposed so a caller can report it (not mutated). */
  get baseline(): MeanStddev {
    return meanStddev(this.#window.values());
  }

  feed(value: number, ts: number): AnomalyEvent | null {
    const { mean, stddev, n } = this.baseline;
    const ready = n >= MIN_ZSCORE_WINDOW && stddev > 0;
    const anomaly = ready && Math.abs(value - mean) > this.#sigma * stddev
      ? (value > mean ? "z_score_high" : "z_score_low")
      : null;

    // The reading joins the baseline whether or not it was anomalous: a spike
    // must not be excluded from history, or the next equally-spiky reading
    // would be judged against a baseline that deliberately forgot the first.
    this.#window.push(value);

    if (anomaly === null) return null;
    return this.#record(value, ts, anomaly, mean);
  }

  #record(
    value: number,
    ts: number,
    reason: AnomalyReason,
    baseline: number,
  ): AnomalyEvent {
    const event: AnomalyEvent = {
      variable: this.variable,
      value,
      reason,
      ts,
      baseline,
    };
    this.#lastAnomaly = event;
    return event;
  }
}

// ---------------------------------------------------------------------------
// EWMA detector
// ---------------------------------------------------------------------------

/** Smoothed-baseline configuration for {@link EwmaDetector}. */
export interface EwmaDetectorOptions {
  readonly variable: string;
  /** Smoothing factor in `(0, 1]`; higher tracks the stream faster. */
  readonly alpha?: number;
  /** Band width in deviations: fire when `|value - baseline| > k · deviation`. */
  readonly k?: number;
}

/**
 * EWMA: a smoothed baseline plus a deviation band that widens the same way.
 *
 * The baseline is `avg ← avg + alpha·(value - avg)`; the band's half-width is
 * `max(mad, dev)` where `mad ← mad + alpha·(|value - avg| - mad)`, scaled by
 * {@link EwmaDetectorOptions.k}. A reading outside `baseline ± k·half-width`
 * fires.
 *
 * ### Why the band has a floor (documented choice)
 *
 * The deviation is the exponentially weighted **mean absolute deviation**, so a
 * *perfectly steady* stream drives it toward zero — and then a band of
 * `k · dev` would flag a jitter of any amplitude as anomalous, because the
 * denominator it is measured against is itself vanishing. Worse, the reading
 * under test is always `|value − avg| ≈ 2·amplitude` while the smoothing
 * converges `mad → alpha·amplitude`, so the flag never stops.
 *
 * The floor `mad` is therefore never allowed *below* its own running level: the
 * half-width is `max(mad, dev)`. A stream that holds steady at one level keeps
 * a band wide enough to admit its own noise (steady state fires nothing), while
 * a genuine **shift** — a step far larger than that standing noise — leaves the
 * band immediately and trips on its leading samples. Once the baseline has
 * caught up to the new level, the band widens around it and the alarm retires:
 * a drift becomes the new normal instead of an endless siren.
 */
export class EwmaDetector implements AnomalyDetector {
  readonly variable: string;
  readonly kind = "ewma" as const;
  /** EWMA needs no external history: it learns from the live stream itself. */
  readonly warmPending = false;
  #lastAnomaly: AnomalyEvent | null = null;

  readonly #alpha: number;
  readonly #k: number;
  #average: number | null = null;
  #deviation = 0;
  /** Running mean absolute deviation; the floor under {@link deviation}. */
  #mad = 0;

  constructor(options: EwmaDetectorOptions) {
    this.variable = options.variable;
    this.#alpha = options.alpha ?? DEFAULT_EWMA_ALPHA;
    this.#k = options.k ?? DEFAULT_EWMA_K;
  }

  get lastAnomaly(): AnomalyEvent | null {
    return this.#lastAnomaly;
  }

  /** The current smoothed baseline, or `null` before the first reading. */
  get baseline(): number | null {
    return this.#average;
  }

  /** Band half-width before `k` scales it: `max(mad, deviation)`. */
  get deviation(): number {
    return Math.max(this.#mad, this.#deviation);
  }

  /** No history to fill: the baseline is bootstrapped from the first reading. */
  warm(): void {}

  feed(value: number, ts: number): AnomalyEvent | null {
    const previous = this.#average;
    if (previous === null) {
      // The first reading defines the baseline; there is nothing to be far from.
      this.#average = value;
      this.#deviation = 0;
      this.#mad = 0;
      return null;
    }

    const reason = this.#classify(value, previous);
    const delta = value - previous;
    this.#average = previous + this.#alpha * delta;
    this.#deviation += this.#alpha * (Math.abs(delta) - this.#deviation);
    this.#mad += this.#alpha * (Math.abs(delta) - this.#mad);

    if (reason === null) return null;
    return this.#record(value, ts, reason, previous);
  }

  /** Which side of `previous ± k·max(mad, dev)` the reading left, if any. */
  #classify(value: number, previous: number): AnomalyReason | null {
    const halfWidth = this.#k * this.deviation;
    if (value > previous + halfWidth) return "ewma_high";
    if (value < previous - halfWidth) return "ewma_low";
    return null;
  }

  #record(
    value: number,
    ts: number,
    reason: AnomalyReason,
    baseline: number,
  ): AnomalyEvent {
    const event: AnomalyEvent = {
      variable: this.variable,
      value,
      reason,
      ts,
      baseline,
    };
    this.#lastAnomaly = event;
    return event;
  }
}

// ---------------------------------------------------------------------------
// Rule configuration
// ---------------------------------------------------------------------------

/** A threshold rule as declared in configuration: a variable and its band. */
export interface ThresholdRule {
  readonly detector: "threshold";
  readonly variable: string;
  readonly high?: number;
  readonly low?: number;
}

/** A z-score rule as declared in configuration. */
export interface ZScoreRule {
  readonly detector: "z_score";
  readonly variable: string;
  readonly sigma: number;
  /** Defaults to {@link DEFAULT_ZSCORE_WINDOW} when omitted. */
  readonly window?: number;
}

/** An EWMA rule as declared in configuration. */
export interface EwmaRule {
  readonly detector: "ewma";
  readonly variable: string;
  readonly alpha?: number;
  readonly k?: number;
}

/** One declared anomaly rule (FR-AI-05). */
export type AnomalyRule = ThresholdRule | ZScoreRule | EwmaRule;

/**
 * Default rolling window for a z-score rule that does not name one: twenty
 * readings, long enough to be a baseline and short enough to follow a shift.
 */
export const DEFAULT_ZSCORE_WINDOW = 20 as const;

/** Build the detector a rule describes. Pure factory, no I/O. */
export function detectorFor(rule: AnomalyRule): AnomalyDetector {
  switch (rule.detector) {
    case "threshold":
      return new ThresholdDetector({
        variable: rule.variable,
        ...(rule.high === undefined ? {} : { high: rule.high }),
        ...(rule.low === undefined ? {} : { low: rule.low }),
      });
    case "z_score":
      return new ZScoreDetector({
        variable: rule.variable,
        sigma: rule.sigma,
        window: rule.window ?? DEFAULT_ZSCORE_WINDOW,
      });
    case "ewma":
      return new EwmaDetector({
        variable: rule.variable,
        ...(rule.alpha === undefined ? {} : { alpha: rule.alpha }),
        ...(rule.k === undefined ? {} : { k: rule.k }),
      });
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** Construction options for {@link AnomalyEngine}. */
export interface AnomalyEngineOptions {
  /** The detectors to run, one or more per variable. */
  readonly detectors: readonly AnomalyDetector[];
  /**
   * History seam, used only to warm detectors whose {@link
   * AnomalyDetector.warmPending} is true. Omitted when no detector needs it —
   * and then a warm-pending detector simply starts cold.
   */
  readonly series?: SeriesReader;
  /** Emit seam; called once per anomaly and never for a normal reading. */
  readonly emit?: EmitAnomaly;
  /** Clock seam; defaults to wall-clock `Date.now`. */
  readonly now?: Clock;
  /**
   * How far back {@link AnomalyEngine.warm} reads per variable. Must comfortably
   * exceed the largest detector window; the reader itself bounds the result.
   */
  readonly warmWindowMs?: number;
}

/** Default warm-up look-back: one hour (`query.ts`'s default read window). */
export const DEFAULT_WARM_WINDOW_MS = 60 * 60 * 1000;

/**
 * The anomaly engine: detectors plus the series/clock/emit seams.
 *
 * One instance holds the detectors for a project's variables. {@link
 * AnomalyEngine.observe} is the only mutation point and is **synchronous** — it
 * judges the reading, feeds every detector that watches that variable, and
 * emits each anomaly it finds. {@link AnomalyEngine.warm} performs the one piece
 * of I/O: priming rolling windows from history before the stream arrives.
 */
export class AnomalyEngine {
  readonly #clock: Clock;
  readonly #emit: EmitAnomaly | undefined;
  readonly #series: SeriesReader | undefined;
  readonly #warmWindowMs: number;
  /** variable -> its detectors, so `observe` is a map lookup not a scan. */
  readonly #byVariable = new Map<string, AnomalyDetector[]>();
  /** Variables whose warm-pending detectors still want history. */
  readonly #pending: AnomalyDetector[] = [];

  constructor(options: AnomalyEngineOptions) {
    this.#clock = options.now ?? defaultClock;
    this.#emit = options.emit;
    this.#series = options.series;
    this.#warmWindowMs = options.warmWindowMs ?? DEFAULT_WARM_WINDOW_MS;

    for (const detector of options.detectors) {
      const existing = this.#byVariable.get(detector.variable);
      if (existing === undefined) {
        this.#byVariable.set(detector.variable, [detector]);
      } else {
        existing.push(detector);
      }
      if (detector.warmPending) this.#pending.push(detector);
    }
  }

  /** Every detector currently registered, in construction order. */
  get detectors(): readonly AnomalyDetector[] {
    return [...this.#byVariable.values()].flat();
  }

  /**
   * Prime every warm-pending detector from the series seam.
   *
   * Reads `[now - warmWindowMs, now]` per variable from the injected clock, and
   * clears the pending set even when a detector finds no history: warm-up is a
   * one-time step, so a later call is a no-op rather than a re-read. A detector
   * with no reader behind it starts cold and warms from the live stream instead.
   */
  async warm(): Promise<void> {
    if (this.#pending.length === 0) return;
    const to = this.#clock();
    const from = to - this.#warmWindowMs;

    for (const detector of this.#pending) {
      const series = this.#series;
      if (series !== undefined) {
        const samples = await series(detector.variable, from, to);
        detector.warm(samples);
      } else {
        detector.warm([]);
      }
    }
    this.#pending.length = 0;
  }

  /**
   * Judge one reading of `variable` at the current clock instant.
   *
   * Every detector watching the variable is fed; each anomaly that results is
   * emitted through the seam. Time is read **once**, so all detectors of a
   * reading share an instant. Returns what was emitted, in detector order, so a
   * caller (or a test) can assert without spying on the sink.
   */
  observe(variable: string, value: number): readonly AnomalyEvent[] {
    const ts = this.#clock();
    const detectors = this.#byVariable.get(variable);
    if (detectors === undefined) return [];

    const found: AnomalyEvent[] = [];
    for (const detector of detectors) {
      const anomaly = detector.feed(value, ts);
      if (anomaly === null) continue;
      found.push(anomaly);
      this.#emit?.(anomaly);
    }
    return found;
  }

  /** The most recent anomaly each detector raised, keyed by variable. */
  lastAnomalies(): ReadonlyMap<string, AnomalyEvent> {
    const latest = new Map<string, AnomalyEvent>();
    for (const detector of this.detectors) {
      const anomaly = detector.lastAnomaly;
      if (anomaly !== null) latest.set(detector.variable, anomaly);
    }
    return latest;
  }
}
