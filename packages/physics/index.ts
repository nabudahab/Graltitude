// SI units throughout. Wind is the meteorological direction it comes FROM.
export type Weather = {
  wind: number;
  gust: number;
  direction: number;
  density: number;
  wet: boolean;
};
export const calm: Weather = {
  wind: 0,
  gust: 0,
  direction: 0,
  density: 1.225,
  wet: false,
};
export type Point = { lat: number; lon: number; z: number; d: number };
export type Course = { name: string; points: Point[]; located: boolean };
export type Window = {
  id: string;
  ride: string;
  label: string;
  // Mean wheel-power terms over modeled samples. Rolling and load are per kg.
  terms?: { aero: number; rolling: number; load: number };
  legacyChoiceIds?: string[];
  steadyClimb?: boolean;
  speed: number;
  grade: number;
  watts: number;
  duration: number;
  accel: number;
  heading: number;
  weather: Weather;
  flags: string[];
};
export type Ride = {
  id: string;
  name: string;
  bike: string;
  date: string;
  distance: number;
  group: boolean;
  windows: Window[];
  issue?: string;
};
export type Bike = { id: string; name: string; mass: number };
export type Model = {
  cda: number;
  crr: number;
  mass: number;
  assumedCrr: boolean;
  wattsError: number;
  heldOutRides: number;
  timingErrorPct: number | null;
};
export const gravity = 9.80665,
  efficiency = 0.975;
const radians = Math.PI / 180;
export function bearing(a: Point, b: Point) {
  const dl = (b.lon - a.lon) * radians,
    p = a.lat * radians,
    q = b.lat * radians;
  return (
    Math.atan2(
      Math.sin(dl) * Math.cos(q),
      Math.cos(p) * Math.sin(q) - Math.sin(p) * Math.cos(q) * Math.cos(dl),
    ) / radians
  );
}
export function distance(a: Point, b: Point) {
  const h =
    Math.sin(((b.lat - a.lat) * radians) / 2) ** 2 +
    Math.cos(a.lat * radians) *
      Math.cos(b.lat * radians) *
      Math.sin(((b.lon - a.lon) * radians) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}
function aero(v: number, heading: number, w: Weather) {
  const angle = (heading - w.direction) * radians;
  const along = v + w.wind * Math.cos(angle);
  return (
    0.5 * w.density * Math.hypot(along, w.wind * Math.sin(angle)) * along * v
  );
}
export function watts(
  v: number,
  grade: number,
  mass: number,
  cda: number,
  crr: number,
  heading = 0,
  w = calm,
) {
  const normal = (mass * gravity * v) / Math.hypot(1, grade);
  return (normal * (grade + crr) + cda * aero(v, heading, w)) / efficiency;
}
export function powerTerms(
  speed: number,
  grade: number,
  heading: number,
  weather: Weather,
  kineticPowerPerKg: number,
) {
  const rolling = (gravity * speed) / Math.hypot(1, grade);
  return {
    aero: aero(speed, heading, weather),
    rolling,
    load: rolling * grade + kineticPowerPerKg,
  };
}
function unitTerms(r: Window) {
  return (
    r.terms ??
    powerTerms(r.speed, r.grade, r.heading, r.weather, r.accel * r.speed)
  );
}
// Fit interval work with duration weights. If rolling and aero terms cannot be
// separated, fix rolling resistance to the rider's assumption and fit CdA.
function coefficients(rows: Window[], mass: number, fixedCrr: number) {
  if (!rows.length) return null;
  let aa = 0,
    ab = 0,
    bb = 0,
    ay = 0,
    by = 0;
  for (const r of rows) {
    const terms = unitTerms(r);
    const a = terms.aero,
      b = mass * terms.rolling;
    const y = r.watts * efficiency - mass * terms.load;
    aa += a * a * r.duration;
    ab += a * b * r.duration;
    bb += b * b * r.duration;
    ay += a * y * r.duration;
    by += b * y * r.duration;
  }
  const det = aa * bb - ab * ab;
  let crr = (by * aa - ay * ab) / det,
    cda = (ay * bb - by * ab) / det;
  const assumedCrr =
    rows.length < 3 ||
    det <= 0.015 * aa * bb ||
    !(crr >= 0.001 && crr <= 0.035 && cda >= 0.12 && cda <= 0.9);
  if (assumedCrr) {
    crr = fixedCrr;
    cda = (ay - crr * ab) / aa;
  }
  if (!(cda >= 0.12 && cda <= 0.9)) return null;
  return { cda, crr, assumedCrr, mass };
}
// Solve steady speed with the same descent ceiling in validation and planning.
function steadySpeed(
  mass: number,
  cda: number,
  crr: number,
  power: number,
  grade: number,
  heading: number,
  weather: Weather,
) {
  let lo = 0.1,
    hi = 60 / 3.6;
  for (let k = 0; k < 24; k++) {
    const v = (lo + hi) / 2;
    if (watts(v, grade, mass, cda, crr, heading, weather) > power) hi = v;
    else lo = v;
  }
  return (lo + hi) / 2;
}
export function fit(
  rows: Window[],
  mass: number,
  fixedCrr: number,
): Model | null {
  const model = coefficients(rows, mass, fixedCrr);
  if (!model) return null;
  const errors: number[] = [],
    timingErrors: number[] = [];
  for (const id of new Set(rows.map((r) => r.ride))) {
    const other = coefficients(
      rows.filter((r) => r.ride !== id),
      mass,
      fixedCrr,
    );
    if (!other) continue;
    const held = rows.filter((r) => r.ride === id);
    let joules = 0,
      seconds = 0,
      actualClimbing = 0,
      predictedClimbing = 0;
    for (const r of held) {
      const terms = unitTerms(r);
      const predicted =
        (other.cda * terms.aero +
          mass * (other.crr * terms.rolling + terms.load)) /
        efficiency;
      joules += Math.abs(r.watts - predicted) * r.duration;
      seconds += r.duration;
      if (
        r.steadyClimb !== false &&
        r.grade >= 0.02 &&
        Math.abs(r.accel) < 0.015 &&
        !r.flags.length
      ) {
        actualClimbing += r.duration;
        const v = steadySpeed(
          mass,
          other.cda,
          other.crr,
          r.watts,
          r.grade,
          r.heading,
          r.weather,
        );
        predictedClimbing += (r.speed * r.duration) / v;
      }
    }
    errors.push(joules / seconds);
    if (actualClimbing > 0)
      timingErrors.push(Math.abs(predictedClimbing / actualClimbing - 1) * 100);
  }
  return {
    ...model,
    wattsError: errors.length
      ? errors.reduce((a, b) => a + b, 0) / errors.length
      : 0,
    heldOutRides: errors.length,
    timingErrorPct: timingErrors.length
      ? timingErrors.reduce((a, b) => a + b, 0) / timingErrors.length
      : null,
  };
}
export function simulate(
  course: Course,
  model: Model,
  power: number,
  weather: Weather[] = [calm],
) {
  let seconds = 0;
  for (let i = 1; i < course.points.length; i++) {
    const a = course.points[i - 1],
      b = course.points[i],
      ds = b.d - a.d;
    if (ds <= 0) continue;
    const slope = (b.z - a.z) / ds,
      heading = bearing(a, b);
    const w =
      weather[
        Math.min(
          weather.length - 1,
          Math.floor(((i - 1) * weather.length) / (course.points.length - 1)),
        )
      ];
    seconds +=
      ds /
      steadySpeed(model.mass, model.cda, model.crr, power, slope, heading, w);
  }
  return seconds;
}
