import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentId, stravaCourse } from "../apps/web/src/course.ts";
import { calculate } from "../apps/web/src/compute.ts";
import { excludedFromHistory } from "../apps/web/src/streams.ts";
import { calm, simulate, watts, type Model } from "../packages/physics/index.ts";
test("segment links and numeric IDs identify a segment independently of rider history", () => {
  for (const s of [
    "123",
    "strava.com/segments/123",
    "https://www.strava.com/segments/123/?share=1#overview",
  ])
    assert.equal(segmentId(s), "123");
  for (const s of [
    "",
    "0",
    "https://strava.com/activities/123",
    "https://example.org/segments/123",
  ])
    assert.throws(() => segmentId(s));
});
const profile = {
  latlng: {
    data: [
      [45, 7],
      [45.009, 7],
    ] as [number, number][],
  },
  distance: { data: [450, 1450] },
  altitude: { data: [100, 160] },
};
const model: Model = {
  mass: 80,
  cda: 0.32,
  crr: 0.005,
  assumedCrr: false,
  wattsError: 8,
  calibrationRides: 2,
  heldOutRides: 2,
  timingErrorPct: null,
};
test("flat-ground power is available before segment import and persists after it", () => {
  const bikes = [{ id: "road", model }];
  const plan = { course: null, power: 220, speed: 30, weather: [calm] };
  const [before] = calculate(bikes, plan);
  assert.equal(
    before.flat,
    watts(plan.speed / 3.6, 0, model.mass, model.cda, model.crr),
  );
  assert.equal(before.seconds, null);
  assert.equal(before.range, null);

  const course = stravaCourse("North climb", profile);
  const [after] = calculate(bikes, { ...plan, course });
  assert.equal(after.flat, before.flat);
  assert.equal(after.seconds, simulate(course, model, plan.power, plan.weather));
  assert.ok(after.range);
  assert.ok(after.range[0] < after.seconds && after.seconds < after.range[1]);
});
test("imported profile starts at zero and its gradient changes predicted time", () => {
  const steep = stravaCourse("North climb", profile),
    flat = stravaCourse("Flat", { ...profile, altitude: { data: [100, 100] } });
  assert.deepEqual(
    steep.points.map((p) => p.d),
    [0, 1000],
  );
  assert.equal(steep.name, "North climb");
  assert.ok(simulate(steep, model, 220) > simulate(flat, model, 220));
});
test("incomplete or reversed segment streams cannot replace the current course", () => {
  for (const bad of [
    {},
    { ...profile, altitude: { data: [100] } },
    { ...profile, distance: { data: [20, 10] } },
    { ...profile, altitude: { data: [100, NaN] } },
  ])
    assert.throws(() => stravaCourse("Invalid", bad));
});

test("exact efforts on the selected bike dominate in similar weather", () => {
  const course = stravaCourse("North climb", profile, "123");
  const north = { ...calm, wind: 8, gust: 10, direction: 359 };
  const south = { ...north, direction: 180 };
  const effort = {
    segment: "123",
    ride: "12",
    watts: 260,
    date: "2026-11-01T08:00:00Z",
    start: 100,
    end: 350,
    seconds: simulate(course, model, 260, [north]) * 0.85,
    weather: [north, north, north],
  };
  const plan = {
    course,
    power: 220,
    speed: 30,
    weather: [{ ...north, direction: 1 }],
    segmentHistory: {
      road: [
        effort,
        { ...effort, ride: "34", weather: [south], seconds: simulate(course, model, 260, [south]) * 1.1 },
        { ...effort, segment: "456" },
      ],
    },
  };
  const bikes = [{ id: "road", model }, { id: "gravel", model }];
  const [road, gravel] = calculate(bikes, plan);
  assert.equal(road.historyEfforts, 1);
  assert.equal(gravel.historyEfforts, 0);
  assert.ok(Math.abs(road.seconds! / gravel.seconds! - 0.88) < 0.001);
  assert.equal(road.flat, gravel.flat);
  assert.ok(road.range![0] < road.seconds! && road.range![1] > road.seconds!);

  const [tailwind] = calculate(bikes, { ...plan, weather: [south] });
  assert.equal(tailwind.historyEfforts, 1);
  assert.ok(Math.abs(tailwind.seconds! / simulate(course, model, 220, [south]) - 1.08) < 0.001);

  for (const fallback of [
    { ...plan, segmentHistory: undefined },
    { ...plan, weather: [calm] },
    { ...plan, course: stravaCourse("GPX course", profile) },
  ]) {
    const [result] = calculate(bikes, fallback);
    assert.equal(result.historyEfforts, 0);
    assert.equal(result.seconds, simulate(fallback.course, model, fallback.power, fallback.weather));
  }
});

test("segment history respects explicit overlapping exclusions", () => {
  const effort = { start: 100, end: 350 };
  const ride = { id: "12", windows: [] };
  assert.equal(excludedFromHistory(effort, ride, { "12:whole": false }), true);
  assert.equal(excludedFromHistory(effort, ride, { "12:lap:300-401": false }), true);
  assert.equal(excludedFromHistory(effort, ride, { "12:lap:350-401": false }), false);
  assert.equal(excludedFromHistory(effort, ride, { "34:lap:300-401": false }), false);
});
