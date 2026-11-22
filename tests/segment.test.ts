import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentId, stravaCourse } from "../apps/web/src/course.ts";
import { simulate, type Model } from "../packages/physics/index.ts";
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
test("imported profile starts at zero and its gradient changes predicted time", () => {
  const steep = stravaCourse("North climb", profile),
    flat = stravaCourse("Flat", { ...profile, altitude: { data: [100, 100] } });
  const model: Model = {
    mass: 80,
    cda: 0.32,
    crr: 0.005,
    assumedCrr: false,
    wattsError: 0,
    heldOutRides: 0,
    timingErrorPct: null,
  };
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
