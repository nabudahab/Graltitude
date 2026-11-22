import {
  type Model,
  simulate,
  watts,
  type Window,
  type Course,
  type Weather,
} from "../../../packages/physics/index";
export type FitInput = {
  id: string;
  mass: number;
  crr: number;
  rows: Window[];
};
export type Plan = {
  course: Course;
  power: number;
  speed: number;
  weather: Weather[];
};
export type Fitted = { id: string; model: Model | null };
export type Job =
  { type: "fit"; bikes: FitInput[] } | { type: "plan"; plan: Plan };
export function calculate(bikes: Fitted[], job: Plan) {
  return bikes.map(({ id, model }) => {
    if (!model) return { id, model: null };
    const time = (p: number) => simulate(job.course, model, p, job.weather);
    const range =
      model.heldOutRides >= 2
        ? [
            time(job.power + model.wattsError),
            time(Math.max(10, job.power - model.wattsError)),
          ]
        : null;
    return {
      id,
      model,
      seconds: time(job.power),
      range,
      flat: watts(job.speed / 3.6, 0, model.mass, model.cda, model.crr),
    };
  });
}
export type Results = ReturnType<typeof calculate>;
