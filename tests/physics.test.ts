import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calm,
  fit,
  watts,
  simulate,
  type Window,
  type Model,
} from "../packages/physics/index.ts";
const mass = 84,
  cda = 0.32,
  crr = 0.006;
function row(speed: number, id: string, grade = 0.035): Window {
  const weather = { ...calm, wind: 1.3, direction: 45 };
  return {
    id,
    ride: id,
    label: "Whole ride",
    accel: 0,
    heading: 25,
    duration: 90,
    watts: watts(speed, grade, mass, cda, crr, 25, weather),
    flags: [],
    grade,
    speed,
    weather,
  };
}
test("recovers known coefficients with separate ride holdouts", () => {
  const result = fit(
    [4, 6, 8, 10, 12].map((v, i) => row(v, String(i))),
    mass,
    0.005,
  )!;
  assert.ok(Math.abs(result.cda - cda) < 1e-8);
  assert.ok(Math.abs(result.crr - crr) < 1e-8);
  assert.equal(result.assumedCrr, false);
  assert.equal(result.heldOutRides, 5);
  assert.ok(result.wattsError < 1e-7);
  assert.ok(result.timingErrorPct !== null && result.timingErrorPct < 0.001);
});
test("one-speed data uses the declared Crr and no empty selection produces a fit", () => {
  assert.equal(fit([], mass, crr), null);
  const result = fit([row(6, "r"), row(6, "r")], mass, crr)!;
  assert.equal(result.assumedCrr, true);
  assert.equal(result.heldOutRides, 0);
  assert.ok(Math.abs(result.cda - cda) < 1e-8);
});
test("prediction inverts measured power and responds to wind direction", () => {
  const model: Model = {
    mass,
    cda,
    crr,
    wattsError: 0,
    heldOutRides: 0,
    timingErrorPct: null,
    assumedCrr: false,
  };
  const route = {
    name: "North",
    located: true,
    points: [
      { lat: 45, lon: 7, z: 100, d: 0 },
      { lat: 45.01, lon: 7, z: 160, d: 1000 },
    ],
  };
  const power = watts(5, 0.06, mass, cda, crr);
  const sec = simulate(route, model, power);
  assert.ok(Math.abs(sec - 200) < 0.001);
  assert.ok(simulate(route, model, power, [{ ...calm, wind: 4 }]) > sec);
  assert.ok(
    simulate(route, model, power, [{ ...calm, wind: 4, direction: 180 }]) < sec,
  );
});
