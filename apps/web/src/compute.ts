import {
  type Model,
  simulate,
  watts,
  type Window,
  type Weather,
} from "../../../packages/physics/index.ts";
import type { PlannedCourse } from "./course.ts";
import type { SegmentObservation } from "./useSegmentHistory.ts";
export type FitInput = {
  id: string;
  mass: number;
  crr: number;
  rows: Window[];
};
export type Plan = {
  course: PlannedCourse | null;
  power: number;
  speed: number;
  weather: Weather[];
  segmentHistory?: Record<string, SegmentObservation[]>;
};
export type Fitted = { id: string; model: Model | null };
export type Job =
  { type: "fit"; bikes: FitInput[] } | { type: "plan"; plan: Plan };

function weatherWeight(current: Weather[], historical: Weather[]) {
  if (!current.length || !historical.length) return 0;
  const difference = historical.reduce((sum, past, i) => {
    const at = Math.floor(((i + 0.5) * current.length) / historical.length);
    const now = current[at];
    const angle = ((now.direction - past.direction) * Math.PI) / 180;
    const windSquared =
      (now.wind - past.wind) ** 2 +
      2 * now.wind * past.wind * (1 - Math.cos(angle));
    const gustDifference = (now.gust - now.wind) - (past.gust - past.wind);
    return sum + windSquared / 9 + (gustDifference / 4) ** 2 +
      (now.wet === past.wet ? 0 : 6);
  }, 0) / historical.length;
  const similarity = Math.exp(-difference / 2);
  // Taper to zero so many distant efforts cannot overwhelm a comparable one.
  return 4 * Math.max(0, (similarity - 0.05) / 0.95);
}

function segmentAdjustment(
  course: PlannedCourse,
  model: Model,
  weather: Weather[],
  observations: SegmentObservation[],
) {
  // A comparable effort has four times the weight of the unadjusted model.
  // Compare each observed time at its own watts and weather before transferring
  // the remaining error to the planned conditions.
  let totalWeight = 1;
  let weightedRatio = 1;
  let historyEfforts = 0;
  for (const effort of observations) {
    if (effort.segment !== course.stravaId) continue;
    const weight = weatherWeight(weather, effort.weather);
    if (!(weight > 0)) continue;
    const predicted = simulate(course, model, effort.watts, effort.weather);
    const ratio = effort.seconds / predicted;
    // Discard large discrepancies that can come from braking, pacing or GPS.
    if (!(ratio >= 0.65 && ratio <= 1.5)) continue;
    weightedRatio += ratio * weight;
    totalWeight += weight;
    historyEfforts++;
  }
  return { factor: weightedRatio / totalWeight, historyEfforts };
}

export function calculate(bikes: Fitted[], job: Plan) {
  return bikes.map(({ id, model }) => {
    if (!model) return { id, model: null };
    const flat = watts(job.speed / 3.6, 0, model.mass, model.cda, model.crr);
    const { course } = job;
    if (!course) return { id, model, flat, seconds: null, range: null };
    const { factor, historyEfforts } = segmentAdjustment(
      course,
      model,
      job.weather,
      job.segmentHistory?.[id] ?? [],
    );
    const time = (p: number) => simulate(course, model, p, job.weather) * factor;
    const range =
      model.heldOutRides >= 2
        ? [
            time(job.power + model.wattsError),
            time(Math.max(1, job.power - model.wattsError)),
          ]
        : null;
    return {
      id,
      model,
      seconds: time(job.power),
      historyEfforts,
      range,
      flat,
    };
  });
}
export type Results = ReturnType<typeof calculate>;
