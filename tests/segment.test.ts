import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentId, stravaCourse } from "../apps/web/src/course.ts";
import { calculate } from "../apps/web/src/compute.ts";
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
