// A simulated rider, for testing the app the way it is actually used: moving.
//
// Playwright's setGeolocation only carries lat/lon/accuracy, so the app would
// have to guess speed from wall-clock deltas — which breaks as soon as the
// simulation runs faster than real time, and the turn calls are timed off
// speed. Instead this installs its own geolocation source that emits full
// fixes (speed, heading, accuracy) and records spoken guidance, so a ride can
// be compressed in wall-clock time and still be faithful to what the app sees.
//
// Fidelity caveat: the app's own wall-clock timers (reroute cooldown ~10 s,
// auto-refollow ~10 s) do NOT compress. Scenarios that depend on those should
// run at timeScale 1.
import type { Page } from "@playwright/test";

export interface Fix {
  lon: number;
  lat: number;
  accuracy?: number;
  speed?: number | null;
  heading?: number | null;
}

export interface RideOptions {
  /** Rider pace. 8 km/h ≈ young kids, 11 ≈ older kids, 16 ≈ solo adult. */
  speedKmh?: number;
  /** Simulated fixes per simulated second (real phones: ~1). */
  fixHz?: number;
  /** GPS wander, metres of random offset per fix (real bike GPS: 5-15 m). */
  jitterM?: number;
  accuracyM?: number;
  /** Wall-clock compression: 10 means a 10-minute ride takes a minute. */
  timeScale?: number;
  /** Stop feeding fixes after this far along (default: the whole path). */
  untilM?: number;
  /** Ride off the route from here, on `divertBearing`, for `divertM`. */
  divertAtM?: number;
  divertBearingDeg?: number;
  divertM?: number;
  /** Sit still at this distance for this many simulated seconds (a red light). */
  pauseAtM?: number;
  pauseSeconds?: number;
  /** Report useless accuracy between these distances (a tunnel / urban canyon). */
  degradeFromM?: number;
  degradeToM?: number;
  degradedAccuracyM?: number;
  /** Called after each emitted fix — for mid-ride assertions. */
  onFix?: (state: { i: number; alongM: number; lon: number; lat: number }) => Promise<void> | void;
}

const M_PER_DEG_LAT = 110_540;
const mPerDegLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Install the fake location source + voice recorder. Call before page.goto. */
export async function installRider(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface RiderFix {
      lon: number;
      lat: number;
      accuracy?: number;
      speed?: number | null;
      heading?: number | null;
    }
    const watchers = new Map<number, { cb: PositionCallback; err?: PositionErrorCallback }>();
    let nextId = 1;
    let last: RiderFix | null = null;

    const toPosition = (f: RiderFix): GeolocationPosition =>
      ({
        coords: {
          latitude: f.lat,
          longitude: f.lon,
          accuracy: f.accuracy ?? 8,
          altitude: null,
          altitudeAccuracy: null,
          heading: f.heading ?? null,
          speed: f.speed ?? null,
        },
        timestamp: Date.now(),
      }) as unknown as GeolocationPosition;

    const rider = {
      spoken: [] as string[],
      fixCount: 0,
      setFix(f: RiderFix): void {
        last = f;
        rider.fixCount++;
        for (const w of watchers.values()) w.cb(toPosition(f));
      },
      /** Simulate the OS reporting a location failure. */
      failFix(code: number, message: string): void {
        for (const w of watchers.values()) {
          w.err?.({ code, message } as unknown as GeolocationPositionError);
        }
      },
    };
    Object.defineProperty(window, "__rider", { value: rider, configurable: true });

    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition(cb: PositionCallback, err?: PositionErrorCallback): void {
          if (last) cb(toPosition(last));
          else err?.({ code: 2, message: "no fix yet" } as unknown as GeolocationPositionError);
        },
        watchPosition(cb: PositionCallback, err?: PositionErrorCallback): number {
          const id = nextId++;
          watchers.set(id, { cb, err });
          if (last) cb(toPosition(last));
          return id;
        },
        clearWatch(id: number): void {
          watchers.delete(id);
        },
      },
    });

    // record spoken guidance instead of trying to synthesise it
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak: (u: { text?: string; onend?: () => void }) => {
          rider.spoken.push(String(u?.text ?? u));
          // complete the utterance so the app's speech queue drains: the app
          // waits for onend, and a stub that never fires it made the queue lag
          // far behind a time-compressed ride
          setTimeout(() => u?.onend?.(), 5);
        },
        cancel: () => undefined,
      },
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: class {
        text: string;
        rate = 1;
        constructor(t: string) {
          this.text = t;
        }
      },
    });
  });
}

/** Cumulative metres along a polyline. */
function cumulative(path: [number, number][]): number[] {
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as [number, number];
    const b = path[i] as [number, number];
    const dx = (b[0] - a[0]) * mPerDegLon(a[1]);
    const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
    cum.push((cum[i - 1] as number) + Math.hypot(dx, dy));
  }
  return cum;
}

function at(path: [number, number][], cum: number[], m: number): [number, number] {
  const total = cum[cum.length - 1] as number;
  const d = Math.max(0, Math.min(total, m));
  let i = 1;
  while (i < cum.length - 1 && (cum[i] as number) < d) i++;
  const a = path[i - 1] as [number, number];
  const b = path[i] as [number, number];
  const seg = (cum[i] as number) - (cum[i - 1] as number);
  const t = seg > 0 ? (d - (cum[i - 1] as number)) / seg : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function bearing(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * mPerDegLon(a[1]);
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return (((Math.atan2(dx, dy) * 180) / Math.PI) + 360) % 360;
}

/** Deterministic jitter so a failing ride can be replayed exactly. */
function makeNoise(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
}

export interface RideLog {
  fixes: number;
  metres: number;
  spoken: string[];
}

/** Ride the given path, feeding the app fixes as a phone would. */
export async function ride(
  page: Page,
  path: [number, number][],
  opts: RideOptions = {},
): Promise<RideLog> {
  const {
    speedKmh = 11,
    fixHz = 1,
    jitterM = 6,
    accuracyM = 8,
    timeScale = 8,
    divertAtM,
    divertBearingDeg = 90,
    divertM = 120,
    pauseAtM,
    pauseSeconds = 0,
    degradeFromM,
    degradeToM,
    degradedAccuracyM = 90,
    onFix,
  } = opts;

  const cum = cumulative(path);
  const total = cum[cum.length - 1] as number;
  const untilM = Math.min(opts.untilM ?? total, total);
  const speed = (speedKmh * 1000) / 3600;
  const dt = 1 / fixHz;
  const stepM = speed * dt;
  const waitMs = Math.max(1, Math.round((dt * 1000) / timeScale));
  const noise = makeNoise(1337);

  let alongM = 0;
  let i = 0;
  let paused = false;
  let divertedM = 0;

  while (alongM <= untilM) {
    const onPath = at(path, cum, alongM);
    const ahead = at(path, cum, Math.min(total, alongM + 12));
    let lon = onPath[0];
    let lat = onPath[1];
    let heading = bearing(onPath, ahead);
    let movingSpeed = speed;

    // a red light: same spot, zero speed, for a while
    if (pauseAtM !== undefined && !paused && alongM >= pauseAtM) {
      paused = true;
      for (let s = 0; s < pauseSeconds * fixHz; s++) {
        await page.evaluate(
          (f) => window.__rider.setFix(f),
          { lon, lat, accuracy: accuracyM, speed: 0, heading },
        );
        await page.waitForTimeout(waitMs);
        i++;
      }
    }

    // a wrong turn: leave the route on a bearing
    if (divertAtM !== undefined && alongM >= divertAtM && divertedM < divertM) {
      divertedM += stepM;
      const rad = (divertBearingDeg * Math.PI) / 180;
      const base = at(path, cum, divertAtM);
      lon = base[0] + (Math.sin(rad) * divertedM) / mPerDegLon(base[1]);
      lat = base[1] + (Math.cos(rad) * divertedM) / M_PER_DEG_LAT;
      heading = divertBearingDeg;
    } else {
      alongM += stepM;
    }

    const degraded =
      degradeFromM !== undefined &&
      degradeToM !== undefined &&
      alongM >= degradeFromM &&
      alongM <= degradeToM;
    const wander = degraded ? degradedAccuracyM / 2 : jitterM;
    lon += (noise() * wander) / mPerDegLon(lat);
    lat += (noise() * wander) / M_PER_DEG_LAT;

    await page.evaluate((f) => window.__rider.setFix(f), {
      lon,
      lat,
      accuracy: degraded ? degradedAccuracyM : accuracyM,
      speed: movingSpeed,
      heading,
    });
    await page.waitForTimeout(waitMs);
    i++;
    await onFix?.({ i, alongM, lon, lat });
    if (i > 5000) break; // never spin forever on a bad path
  }

  return {
    fixes: i,
    metres: alongM,
    spoken: await page.evaluate(() => window.__rider.spoken),
  };
}
