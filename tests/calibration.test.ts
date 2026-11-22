import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeRide,
  included,
  type Streams,
} from "../apps/web/src/streams.ts";
import { calm, efficiency, fit, watts } from "../packages/physics/index.ts";

const ride = { id: "12", date: "2026-06-01T10:00:00Z", group: false };
const still = async () => calm;
function recorded(n = 305, speed = 7) {
  const data = <T>(f: (i: number) => T) => ({
    data: Array.from({ length: n + 1 }, (_, i) => f(i)),
  });
  return {
    time: data((i) => i),
    distance: data((i) => i * speed),
    altitude: data((i) => 100 + i * speed * 0.03),
    watts: data(() => 220),
    latlng: data((i): [number, number] => [45 + i * 0.00005, 7]),
    velocity_smooth: data(() => speed),
    moving: data(() => true),
  } satisfies Streams;
}

test("one whole ride without laps, including saved exclusions from old intervals", async () => {
  const detail = { streams: recorded(), laps: [] };
  const choices = { "12-120": false };
  const { windows, issue } = await analyzeRide(ride, detail, choices, still);
  assert.equal(issue, undefined);
  assert.equal(windows.length, 1);
  const [unit] = windows;
  assert.equal(unit.label, "Whole ride");
  assert.equal(unit.duration, 305);
  assert.equal(unit.watts, 220);
  assert.deepEqual(unit.flags, []);
  assert.equal(included(unit, choices), false);
  assert.equal(included(unit, { ...choices, [unit.id]: true }), true);
});

test("Strava lap boundaries assign each step once and preserve overlapping exclusions", async () => {
  const laps = [
    { start: 0, end: 75, number: 1, name: "Warm-up" },
    { start: 76, end: 154, number: 2, name: "Lap 2" },
    { start: 154, end: 305, number: 3 },
  ];
  const streams = recorded();
  streams.watts.data.fill(310, 76, 155);
  const choices = { "12-60": false, "123-180": false };
  const { windows, issue } = await analyzeRide(
    ride,
    { streams, laps },
    choices,
    still,
  );
  assert.equal(issue, undefined);
  assert.deepEqual(
    windows.map((w) => [w.label, w.duration, w.watts, included(w, choices)]),
    [
      ["Lap 1 · Warm-up", 75, 220, false],
      ["Lap 2", 79, 310, false],
      ["Lap 3", 151, 220, true],
    ],
  );
  assert.equal(new Set(windows.map((w) => w.id)).size, 3);
  assert.equal(new Set(windows.map((w) => w.ride)).size, 1);
});

test("reports incomplete lap coverage, invalid boundaries and unmeasured laps", async () => {
  const laps = [
    { start: 20, end: 85 },
    { start: 70, end: 100 },
    { start: 90, end: 150, measured: false },
    { start: 151, end: 800 },
  ];
  const { windows, issue } = await analyzeRide(
    ride,
    { streams: recorded(), laps },
    {},
    still,
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0].duration, 65);
  assert.match(issue!, /outside lap boundaries/);
  assert.match(issue!, /Lap 2 has invalid or overlapping/);
  assert.match(issue!, /Lap 3 has no measured power/);
  assert.match(issue!, /Lap 4 has invalid/);
});

test("reports missing power and misaligned streams; gaps and absent weather require review", async () => {
  const streams = recorded();
  const result = (s: Streams) => analyzeRide(ride, { streams: s }, {}, still);
  assert.match(
    (await result({ ...streams, watts: undefined })).issue!,
    /power stream missing/,
  );
  assert.match(
    (await result({ ...streams, altitude: { data: [1] } })).issue!,
    /does not align/,
  );
  const missing = await result({
    ...streams,
    watts: { data: streams.watts.data.map((w, i) => (i === 90 ? NaN : w)) },
  });
  assert.equal(missing.windows.length, 0);
  assert.match(missing.issue!, /incomplete power/);
  streams.moving.data[2] = false;
  streams.time.data = streams.time.data.map((t) => (t > 150 ? t + 30 : t));
  const {
    windows: [w],
  } = await analyzeRide({ ...ride, group: true }, { streams }, {}, async () => {
    throw Error();
  });
  assert.equal(w.duration, 303);
  assert.ok(w.flags.includes("303 of 335 s modeled (stops or gaps)"));
  assert.ok(w.flags.includes("Possible drafting"));
  assert.ok(w.flags.includes("Weather unknown"));
  assert.equal(included(w, {}), false);
});

test("fits integrated work on varied laps and whole rides, holding out all laps of each ride together", async () => {
  const mass = 84,
    cda = 0.32,
    crr = 0.006;
  const wind = { ...calm, wind: 4, direction: 0 };
  const rows = [];
  for (const baseSpeed of [5, 7, 9, 11]) {
    const streams = recorded(300);
    let d = 0,
      z = 100,
      lat = 45;
    for (let i = 0; i <= 300; i++) {
      const v1 = baseSpeed + 2 * Math.sin(i / 35);
      streams.velocity_smooth.data[i] = v1;
      if (i > 0) {
        const v0 = streams.velocity_smooth.data[i - 1];
        const speed = (v1 + v0) / 2;
        const north = i % 100 < 45;
        const grade = north ? 0.007 : 0.065;
        streams.watts.data[i] =
          watts(speed, grade, mass, cda, crr, north ? 0 : 180, wind) +
          (mass * (v1 ** 2 - v0 ** 2)) / (2 * efficiency);
        d += speed;
        z += speed * grade;
        lat += north ? 0.00005 : -0.00005;
      }
      streams.distance.data[i] = d;
      streams.altitude.data[i] = z;
      streams.latlng.data[i] = [lat, 7];
    }
    const laps =
      baseSpeed === 5
        ? []
        : [
            { start: 0, end: 155 },
            { start: 156, end: 300 },
          ];
    const result = await analyzeRide(
      { ...ride, id: String(baseSpeed) },
      { streams, laps },
      {},
      async () => wind,
    );
    assert.equal(result.issue, undefined);
    rows.push(...result.windows);
  }
  assert.equal(rows.length, 7);
  const model = fit(rows, mass, 0.004)!;
  assert.equal(model.calibrationRides, 4);
  assert.equal(model.heldOutRides, 4);
  assert.ok(Math.abs(model.cda - cda) < 1e-8);
  assert.ok(Math.abs(model.crr - crr) < 1e-8);
  assert.ok(model.wattsError < 1e-7);
  assert.equal(model.timingErrorPct, null);
});

test("weights irregular samples by elapsed time and updates weather across UTC hours", async () => {
  const streams = recorded(4);
  streams.time.data = [0, 1, 4, 8, 10];
  streams.watts.data = [0, 100, 200, 150, 300];
  const queries: number[] = [];
  const {
    windows: [unit],
  } = await analyzeRide(
    { ...ride, date: "2026-06-01T10:59:55Z" },
    { streams },
    {},
    async (_, when) => {
      queries.push(when.getUTCHours());
      return { ...calm, wind: 2, gust: 8, wet: when.getUTCHours() === 11 };
    },
  );
  assert.deepEqual(queries, [10, 11]);
  assert.equal(unit.duration, 10);
  assert.equal(unit.watts, 190);
  assert.ok(unit.flags.includes("Gusty"));
  assert.ok(unit.flags.includes("Wet surface"));
});
