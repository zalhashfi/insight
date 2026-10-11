import { describe, expect, it } from "vitest";
import {
  AnomalyEngine,
  DEFAULT_WARM_WINDOW_MS,
  EwmaDetector,
  MIN_ZSCORE_WINDOW,
  ThresholdDetector,
  ZScoreDetector,
  detectorFor,
  meanStddev,
  type AnomalyEvent,
  type DetectorKind,
  type Sample,
  type SeriesReader,
} from "../../worker/src/domains/analytics/anomaly";

/**
 * Spec tests for per-variable anomaly detection (A30, FR-AI-05).
 *
 * Every seam is injected and the *real* classes are exercised: the series is a
 * plain array, the clock is a value the test owns, and the sink is a recording
 * closure — no mocking of the code under test and no wall-clock anywhere, so
 * every case below is deterministic and re-runnable.
 *
 * The acceptance properties, one `describe` each:
 *
 *   1. **Threshold** — a value outside the band emits an event carrying the
 *      variable and a reason; a value inside it emits nothing; a value exactly
 *      on a bound is inside (the band is inclusive).
 *   2. **Z-score** — a spike beyond `sigma` times a *computed* mean/stddev emits
 *      `z_score_high`; a normal value emits nothing. The sigma multiplier is
 *      asserted against `meanStddev` over exactly the window it claims, so the
 *      test fails if the detector's arithmetic (or its window slicing) drifts.
 *   3. **EWMA** — a sustained shift trips (and keeps tripping while the smoothed
 *      baseline lags), while a steady state never does.
 *   4. **Event shape & clock** — each detection carries its variable plus a
 *      stable reason, and the `ts` on the event is the injected clock's value,
 *      not the host's.
 *   5. **Engine wiring** — `observe` emits through the seam, `warm` primes a
 *      rolling window from history (and is a one-time no-op without it).
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A clock the test owns, so every stamped `ts` is exactly knowable. */
const FIXED_NOW = 1_700_000_000_000;

/** The default variable every fixture watches. */
const VARIABLE = "temp";

/**
 * A clock plus a recorder sink, so a case can move time and read back exactly
 * what was emitted without a framework spy.
 */
function harness(variable: string = VARIABLE): {
  now: () => number;
  advance: (ms: number) => void;
  emitted: AnomalyEvent[];
  emit: (event: AnomalyEvent) => void;
} {
  let clock = FIXED_NOW;
  const emitted: AnomalyEvent[] = [];
  return {
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    emitted,
    emit: (event: AnomalyEvent) => {
      emitted.push(event);
    },
  };
}

/** A {@link SeriesReader} over a fixed table, so warming reads real history. */
function seriesOf(
  samples: readonly Sample[],
): { series: SeriesReader; reads: Array<{ variable: string; from: number; to: number }> } {
  const reads: Array<{ variable: string; from: number; to: number }> = [];
  return {
    reads,
    series: (variable, from, to) => {
      reads.push({ variable, from, to });
      return samples.filter((sample) => sample.variable === variable);
    },
  };
}

/** A reading, stamped with the given instant. */
function sample(variable: string, value: number | null, ts: number): Sample {
  return { variable, value, ts };
}

/** Feed `values` to a detector one at a time, returning the anomalies it raised. */
function drive(
  detector: { feed: (value: number, ts: number) => AnomalyEvent | null },
  values: readonly number[],
  start: number = FIXED_NOW,
): AnomalyEvent[] {
  const found: AnomalyEvent[] = [];
  values.forEach((value, index) => {
    const anomaly = detector.feed(value, start + index);
    if (anomaly !== null) found.push(anomaly);
  });
  return found;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

describe("meanStddev — the rolling baseline every windowed detector divides by", () => {
  it("computes the sample mean and Bessel-corrected stddev", () => {
    // mean([2,4,4,4,5,5,7,9]) = 5; the sum of squared deviations is 32; the
    // SAMPLE stddev divides by n-1 = 7, so it is sqrt(32/7), not sqrt(32/8).
    const { mean, stddev, n } = meanStddev([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(mean).toBe(5);
    expect(n).toBe(8);
    expect(stddev).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });

  it("is total on the degenerate samples a cold window produces", () => {
    // Empty is all zeros — no NaN, no throw — so a detector can inspect it.
    expect(meanStddev([])).toEqual({ mean: 0, stddev: 0, n: 0 });
    // One value has no dispersion to measure (n-1 = 0); report zero, not NaN.
    expect(meanStddev([7])).toEqual({ mean: 7, stddev: 0, n: 1 });
  });
});

// ---------------------------------------------------------------------------
// Threshold
// ---------------------------------------------------------------------------

describe("threshold — a static, inclusive band", () => {
  it("emits above_range when the value leaves the band upward", () => {
    const detector = new ThresholdDetector({ variable: VARIABLE, high: 80 });
    const anomaly = detector.feed(81.5, FIXED_NOW);

    expect(anomaly).not.toBeNull();
    expect(anomaly).toMatchObject({
      variable: VARIABLE,
      value: 81.5,
      reason: "above_range",
    });
  });

  it("emits below_range when the value leaves the band downward", () => {
    const detector = new ThresholdDetector({ variable: VARIABLE, low: 10 });
    expect(detector.feed(9.25, FIXED_NOW)).toMatchObject({
      variable: VARIABLE,
      reason: "below_range",
    });
  });

  it("emits nothing for a value inside the band", () => {
    const detector = new ThresholdDetector({ variable: VARIABLE, low: 10, high: 80 });
    expect(detector.feed(42, FIXED_NOW)).toBeNull();
  });

  it("treats the bounds themselves as normal (the band is inclusive)", () => {
    const detector = new ThresholdDetector({ variable: VARIABLE, low: 10, high: 80 });
    expect(detector.feed(80, FIXED_NOW)).toBeNull();
    expect(detector.feed(10, FIXED_NOW)).toBeNull();
  });

  it("needs no history, so it never reaches for the series seam", () => {
    expect(new ThresholdDetector({ variable: VARIABLE, high: 1 }).warmPending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Z-score
// ---------------------------------------------------------------------------

describe("z-score — how many sigmas a reading sits from recent history", () => {
  it("emits a spike beyond the configured sigma, verified against a computed mean/stddev", () => {
    // A tight, symmetric baseline: ten readings of 5.0 (and one 5.1) are
    // deliberately absent, so the mean is exactly 5 and stddev is exactly 0 —
    // then the window is padded with real dispersion before the spike.
    const baseline = [5.0, 4.0, 6.0, 5.0, 4.0, 6.0, 5.0, 5.0];
    const window = baseline.length;
    const detector = new ZScoreDetector({ variable: VARIABLE, sigma: 3, window });

    // Every baseline reading is normal: the window is not yet full/firing.
    expect(drive(detector, baseline)).toEqual([]);

    // The baseline the NEXT reading is judged against is exactly `meanStddev`
    // over those ten... here eight, readings — asserted, not assumed.
    const { mean, stddev, n } = meanStddev(baseline);
    expect(n).toBe(window);
    expect(stddev).toBeGreaterThan(0);

    const spike = 100;
    const z = Math.abs(spike - mean) / stddev;
    expect(z).toBeGreaterThan(3); // past sigma -> it MUST fire

    const anomaly = detector.feed(spike, FIXED_NOW);
    expect(anomaly).not.toBeNull();
    expect(anomaly).toMatchObject({
      variable: VARIABLE,
      value: spike,
      reason: "z_score_high",
    });
    // The reported baseline is the rolling mean the verdict was computed from.
    expect(anomaly?.baseline).toBe(mean);
  });

  it("emits nothing for a value within sigma of the rolling mean", () => {
    const baseline = [5.0, 4.0, 6.0, 5.0, 4.0, 6.0];
    const detector = new ZScoreDetector({ variable: VARIABLE, sigma: 3, window: baseline.length });
    drive(detector, baseline);

    const { mean, stddev } = meanStddev(baseline);
    const normal = mean + stddev; // exactly one sigma out: well inside 3σ
    expect(detector.feed(normal, FIXED_NOW)).toBeNull();
  });

  it("stays quiet until it has enough history to have a baseline at all", () => {
    const detector = new ZScoreDetector({ variable: VARIABLE, sigma: 1, window: 5 });
    // Two readings are not a baseline (no dispersion): a jump is not yet a
    // spike, however large, because a z-score of the first delta is meaningless.
    expect(detector.feed(0, FIXED_NOW)).toBeNull();
    expect(detector.feed(1_000, FIXED_NOW + 1)).toBeNull();
    expect(MIN_ZSCORE_WINDOW).toBe(2);
  });

  it("reports a low outlier as z_score_low", () => {
    const baseline = [50, 51, 49, 50, 51, 49, 50, 50];
    const detector = new ZScoreDetector({ variable: VARIABLE, sigma: 3, window: baseline.length });
    drive(detector, baseline);
    expect(detector.feed(-500, FIXED_NOW)).toMatchObject({ reason: "z_score_low" });
  });

  it("keeps a spike in the baseline, so history is never blinded by it", () => {
    const detector = new ZScoreDetector({ variable: VARIABLE, sigma: 3, window: 3 });
    drive(detector, [10, 10, 10]); // flat: stddev 0, so nothing fires
    // A large step is judged against the zero-width band -> normal for now, but
    // it MUST still enter the window: its own baseline must not be discarded, or
    // the NEXT step would be judged against a history that forgot it.
    expect(detector.feed(20, FIXED_NOW)).toBeNull();
    expect(detector.baseline.mean).toBe(meanStddev([10, 10, 20]).mean); // the 20 is retained
    expect(detector.baseline.n).toBe(3);
  });

  it("declares it needs warming from the series seam", () => {
    expect(new ZScoreDetector({ variable: VARIABLE, sigma: 3, window: 5 }).warmPending).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EWMA
// ---------------------------------------------------------------------------

describe("ewma — a smoothed baseline plus a deviation band", () => {
  it("eventually trips on a sustained shift, and keeps tripping while it lags", () => {
    const detector = new EwmaDetector({ variable: VARIABLE, alpha: 0.3, k: 2 });

    // A long steady phase at 10 lets the deviation band settle near zero.
    expect(drive(detector, new Array<number>(40).fill(10))).toEqual([]);

    // Now the level shifts to 30 and STAYS there. The baseline crawls upward, so
    // the first samples of the step are outside the band: they must trip, and
    // trip while the baseline is still lagging.
    const found = drive(detector, new Array<number>(40).fill(30), FIXED_NOW + 100);

    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(found.every((event) => event.reason === "ewma_high")).toBe(true);
    expect(found.map((event) => event.value)).toEqual([30, 30]);
    expect(detector.baseline).not.toBeNull();
    // Having caught up, the baseline now sits on the new level — the shift has
    // become the normal, which is why the alarm stops.
    expect(detector.baseline!).toBeCloseTo(30, 3);
  });

  it("does not trip in steady state", () => {
    const detector = new EwmaDetector({ variable: VARIABLE });
    // Ten minutes of a constant reading: no dispersion, no anomaly, ever.
    expect(drive(detector, new Array<number>(600).fill(21.5))).toEqual([]);
  });

  it("does not trip on small jitter inside the band", () => {
    const detector = new EwmaDetector({ variable: VARIABLE, alpha: 0.3, k: 3 });
    // Alternating ±1 around 50 is standing noise: the band's floor is the
    // running mean absolute deviation, so it settles wide enough to admit the
    // swing. Only the very first reading (which bootstraps the baseline and is
    // always normal) and the second — judged against a still-cold band — are
    // different; the whole settled tail is silent, however long it runs.
    const jitter = Array.from({ length: 200 }, (_, i) => 50 + (i % 2 === 0 ? 1 : -1));
    const found = drive(detector, jitter);
    expect(found).toHaveLength(1);
    expect(found[0]?.ts).toBe(FIXED_NOW + 1); // only the cold second sample

    // And the band is genuinely wider than the swing it absorbs.
    expect(detector.deviation).toBeGreaterThan(1 / 3);
  });

  it("bootstraps from the first reading, which can never be anomalous", () => {
    const detector = new EwmaDetector({ variable: VARIABLE });
    expect(detector.baseline).toBeNull();
    expect(detector.feed(123, FIXED_NOW)).toBeNull();
    expect(detector.baseline).toBe(123);
    expect(detector.deviation).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Event shape & determinism
// ---------------------------------------------------------------------------

describe("events — every detection carries its variable, a reason and the clock", () => {
  it("stamps the injected clock, not the host's", () => {
    const { now } = harness();
    const detector = new ThresholdDetector({ variable: VARIABLE, high: 80 });
    const anomaly = detector.feed(99, now());
    expect(anomaly?.ts).toBe(FIXED_NOW);
  });

  it("pairs each reason with the variable that produced it", () => {
    const detector = new ThresholdDetector({ variable: "pressure", low: 100 });
    expect(detector.feed(50, FIXED_NOW)).toMatchObject({
      variable: "pressure",
      reason: "below_range",
    });
  });

  it("is deterministic: the same readings and clock replay identically", () => {
    // The baseline has real dispersion, then a lone spike: the spike is the one
    // anomaly, and a replay with the same clock reproduces it byte-for-byte.
    const readings = [5, 4, 6, 5, 4, 6, 5, 5, 500, 5, 5];

    const first = drive(new ZScoreDetector({ variable: VARIABLE, sigma: 3, window: 8 }), readings);
    const second = drive(new ZScoreDetector({ variable: VARIABLE, sigma: 3, window: 8 }), readings);

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ variable: VARIABLE, value: 500, reason: "z_score_high" });
    expect(first[0]?.ts).toBe(FIXED_NOW + 8); // the spike is the 9th reading
  });
});

// ---------------------------------------------------------------------------
// Rule factory
// ---------------------------------------------------------------------------

describe("detectorFor — one declared rule becomes one detector", () => {
  it("builds the detector each rule names, carrying its kind and variable", () => {
    const cases: Array<{ rule: Parameters<typeof detectorFor>[0]; kind: DetectorKind }> = [
      { rule: { detector: "threshold", variable: "temp", high: 80 }, kind: "threshold" },
      { rule: { detector: "z_score", variable: "temp", sigma: 3 }, kind: "z_score" },
      { rule: { detector: "ewma", variable: "temp" }, kind: "ewma" },
    ];
    for (const { rule, kind } of cases) {
      const detector = detectorFor(rule);
      expect(detector.kind).toBe(kind);
      expect(detector.variable).toBe("temp");
    }
  });
});

// ---------------------------------------------------------------------------
// Engine wiring
// ---------------------------------------------------------------------------

describe("AnomalyEngine — the emit seam and the warm-up path", () => {
  it("emits one event per anomaly and nothing for a normal reading", () => {
    const { now, emit, emitted } = harness();
    const engine = new AnomalyEngine({
      detectors: [new ThresholdDetector({ variable: VARIABLE, low: 10, high: 80 })],
      emit,
      now,
    });

    expect(engine.observe(VARIABLE, 42)).toEqual([]); // inside -> silent
    expect(emitted).toEqual([]);

    const found = engine.observe(VARIABLE, 95); // outside -> one event
    expect(found).toHaveLength(1);
    expect(emitted).toEqual(found);
    expect(found[0]).toMatchObject({
      variable: VARIABLE,
      value: 95,
      reason: "above_range",
      ts: FIXED_NOW,
    });
  });

  it("runs every detector watching a variable, and ignores unknown ones", () => {
    const { now, emit, emitted } = harness();
    const engine = new AnomalyEngine({
      detectors: [
        new ThresholdDetector({ variable: VARIABLE, high: 80 }),
        new ThresholdDetector({ variable: VARIABLE, low: 10 }),
      ],
      emit,
      now,
    });

    const found = engine.observe(VARIABLE, 99);
    expect(found.map((event) => event.reason)).toEqual(["above_range"]);
    expect(emitted).toHaveLength(1);
    // A variable nobody watches costs nothing and emits nothing.
    expect(engine.observe("unwatched", 99)).toEqual([]);
    expect(emitted).toHaveLength(1);
  });

  it("warms a rolling window from history through the series seam", async () => {
    const { now, emit } = harness();
    // History with real dispersion — a flat history would leave the warmed
    // standard deviation at zero and the detector would (correctly) stay quiet.
    const history: Sample[] = [5, 4, 6, 5, 4, 6, 5, 5].map((value, i) =>
      sample(VARIABLE, value, FIXED_NOW - (8 - i) * 1_000),
    );
    const { series, reads } = seriesOf(history);
    const detector = new ZScoreDetector({ variable: VARIABLE, sigma: 3, window: 8 });
    const engine = new AnomalyEngine({ detectors: [detector], series, emit, now });

    await engine.warm();

    // Exactly the variable was read, over `[now - window, now]`.
    expect(reads).toEqual([
      { variable: VARIABLE, from: FIXED_NOW - DEFAULT_WARM_WINDOW_MS, to: FIXED_NOW },
    ]);
    expect(detector.baseline.n).toBe(8);
    expect(detector.baseline.stddev).toBeGreaterThan(0);

    // A spike against the warm baseline fires without a cold-start gap.
    expect(engine.observe(VARIABLE, 500)).toHaveLength(1);
  });

  it("warms exactly once, and a cold detector still learns from the stream", async () => {
    const { now, emit } = harness();
    const { series, reads } = seriesOf([]);
    const engine = new AnomalyEngine({
      detectors: [
        new ZScoreDetector({ variable: VARIABLE, sigma: 3, window: 8 }),
        new ThresholdDetector({ variable: VARIABLE, high: 80 }), // no history needed
      ],
      series,
      emit,
      now,
    });

    await engine.warm();
    await engine.warm(); // second call is a no-op, not a re-read
    expect(reads).toHaveLength(1);

    // With no warm history the z-score needs its window, but the threshold
    // fires immediately: each detector warms (or not) on its own schedule.
    expect(engine.observe(VARIABLE, 95).map((e) => e.reason)).toEqual(["above_range"]);
  });

  it("warm without a series seam is a no-op rather than an error", async () => {
    const { now, emit } = harness();
    const engine = new AnomalyEngine({
      detectors: [new ZScoreDetector({ variable: VARIABLE, sigma: 3, window: 4 })],
      emit,
      now,
    });
    await expect(engine.warm()).resolves.toBeUndefined();
  });

  it("remembers the most recent anomaly per detector", () => {
    const { now, emit } = harness();
    const engine = new AnomalyEngine({
      detectors: [new ThresholdDetector({ variable: VARIABLE, high: 80 })],
      emit,
      now,
    });
    engine.observe(VARIABLE, 42);
    expect(engine.lastAnomalies().size).toBe(0); // normal readings leave no trace
    engine.observe(VARIABLE, 81);
    expect(engine.lastAnomalies().get(VARIABLE)).toMatchObject({
      variable: VARIABLE,
      value: 81,
      reason: "above_range",
    });
  });
});
