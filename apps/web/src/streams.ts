import {
  bearing,
  calm,
  powerTerms,
  type Point,
  type Ride,
  type Weather,
  type Window,
} from "../../../packages/physics/index.ts";
import { weatherAt } from "./weather.ts";

type Stream<T> = { data: T[]; original_size?: number };
export type Streams = Partial<
  Record<
    "time" | "distance" | "altitude" | "watts" | "velocity_smooth",
    Stream<number>
  >
> & {
  moving?: Stream<boolean>;
  latlng?: Stream<[number, number]>;
};
export type Lap = {
  name?: string;
  number?: number;
  start: number;
  end: number;
  measured?: boolean;
};
export type RideDetail = { eligible?: boolean; streams?: Streams; laps?: Lap[]; issue?: string };
type Analysis = Pick<Ride, "windows" | "issue">;

export function previouslyExcluded(
  unit: Window,
  choices: Record<string, boolean>,
) {
  return unit.legacyChoiceIds?.some((id) => choices[id] === false) ?? false;
}

export function included(unit: Window, choices: Record<string, boolean>) {
  return (
    choices[unit.id] ??
    (!unit.flags.length && !previouslyExcluded(unit, choices))
  );
}

function legacyExclusions(
  ride: string,
  choices: Record<string, boolean>,
  time: number[],
) {
  const prefix = ride + "-";
  return Object.entries(choices).flatMap(([key, included]) => {
    if (
      included ||
      !key.startsWith(prefix) ||
      !/^\d+$/.test(key.slice(prefix.length))
    )
      return [];
    // Old choices were keyed by starting stream index. Reconstruct only an
    // explicitly excluded range, including its last (possibly irregular) step.
    const start = Number(key.slice(prefix.length));
    let end = start;
    while (end < time.length - 1 && time[end] - time[start] < 60) end++;
    return [{ start, end, key }];
  });
}

export async function analyzeRide(
  ride: Pick<Ride, "id" | "date" | "group">,
  detail: RideDetail,
  choices: Record<string, boolean>,
  lookupWeather = weatherAt,
): Promise<Analysis> {
  const windows: Window[] = [];
  const streams = detail.streams;
  if (detail.issue || !streams)
    return { windows, issue: detail.issue || "Ride streams are missing." };
  const time = streams.time?.data;
  if (
    !time ||
    time.length < 2 ||
    time.some((t, i) => !Number.isFinite(t) || (i > 0 && t <= time[i - 1]))
  )
    return { windows, issue: "Ride timestamps are missing or out of order." };
  for (const key of ["watts", "distance", "altitude", "latlng"] as const) {
    if (!streams[key]?.data?.length)
      return {
        windows,
        issue:
          key === "watts"
            ? "Measured power stream missing."
            : "Missing " + key + " stream.",
      };
  }
  // Lap indices refer to the original stream. Independently sampled or
  // cropped streams cannot be paired sample by sample.
  for (const [key, stream] of Object.entries(streams)) {
    if (!stream) continue;
    if (
      stream.data.length !== time.length ||
      (stream.original_size != null && stream.original_size !== time.length)
    )
      return {
        windows,
        issue:
          "The " + key + " stream does not align with the recorded samples.",
      };
  }
  const last = time.length - 1;
  const hasLaps = !!detail.laps?.length;
  const ranges = hasLaps ? detail.laps! : [{ start: 0, end: last }];
  const excluded = legacyExclusions(ride.id, choices, time);
  const notes = new Set<string>();
  let previousEnd = -1;
  for (const [index, lap] of ranges.entries()) {
    const lapLabel = "Lap " + (lap.number ?? index + 1);
    const label = !hasLaps
      ? "Whole ride"
      : lap.name && lap.name !== lapLabel
        ? lapLabel + " · " + lap.name
        : lapLabel;
    if (
      !Number.isInteger(lap.start) ||
      !Number.isInteger(lap.end) ||
      lap.start < 0 ||
      lap.end > last ||
      lap.end < lap.start ||
      lap.start < previousEnd
    ) {
      notes.add(label + " has invalid or overlapping stream boundaries.");
      continue;
    }
    // Power at sample i belongs to the step ending there. Adjacent inclusive
    // Strava ranges therefore assign the connecting step to the second lap.
    const start =
      previousEnd >= 0 && lap.start === previousEnd + 1
        ? previousEnd
        : lap.start;
    if (start > Math.max(0, previousEnd))
      notes.add("Recorded time outside lap boundaries was omitted.");
    previousEnd = lap.end;
    if (lap.measured === false) {
      notes.add(label + " has no measured power.");
      continue;
    }
    const id = hasLaps
      ? ride.id + ":lap:" + lap.start + "-" + lap.end
      : ride.id + ":whole";
    const result = await summarizeUnit(
      ride,
      streams,
      time,
      start,
      lap.end,
      lookupWeather,
    );
    if (typeof result === "string") {
      notes.add(label + " — " + result);
      continue;
    }
    windows.push({
      ...result,
      ride: ride.id,
      id,
      label,
      legacyChoiceIds: excluded
        .filter((old) => old.start < lap.end && old.end > start)
        .map((old) => old.key),
    });
  }
  if (hasLaps && previousEnd < last)
    notes.add("Recorded time outside lap boundaries was omitted.");
  return { windows, issue: [...notes].join(" ") || undefined };
}

async function summarizeUnit(
  ride: Pick<Ride, "date" | "group">,
  s: Streams,
  time: number[],
  start: number,
  end: number,
  lookupWeather: typeof weatherAt,
) {
  const flags = new Set<string>(ride.group ? ["Possible drafting"] : []);
  const terms = { aero: 0, rolling: 0, load: 0 };
  if (!s.moving) flags.add("Moving status missing");
  const speeds = s.velocity_smooth?.data;
  const position = (i: number): Point => ({
    lat: s.latlng!.data[i]?.[0],
    lon: s.latlng!.data[i]?.[1],
    d: s.distance!.data[i],
    z: s.altitude!.data[i],
  });
  let duration = 0,
    distance = 0,
    elevation = 0,
    energy = 0,
    squaredWatts = 0;
  let kinetic = 0,
    acceleratingSeconds = 0,
    firstHeading: number | undefined;
  let minGrade = Infinity,
    maxGrade = -Infinity;
  let weather: Weather = calm,
    firstWeather: Weather | undefined;
  let weatherKey = "";
  let singleWeatherCell = true;
  const epoch = Date.parse(ride.date);
  for (let i = start + 1; i <= end; i++) {
    const dt = time[i] - time[i - 1];
    const a = position(i - 1),
      b = position(i);
    const ds = b.d - a.d,
      dz = b.z - a.z,
      power = s.watts!.data[i];
    if (dt > 8 || s.moving?.data[i] === false) continue;
    if (
      ![power, a.d, b.d, a.z, b.z, a.lat, a.lon, b.lat, b.lon].every(
        Number.isFinite,
      ) ||
      ds < 0 ||
      power < 0
    )
      return "incomplete power, elevation, distance or GPS samples.";
    if (ds === 0) continue;
    const speed = ds / dt,
      grade = dz / ds,
      heading = bearing(a, b);
    firstHeading ??= heading;
    if (Math.abs(((heading - firstHeading + 540) % 360) - 180) > 45)
      flags.add("Changing direction");
    if (a.lat === b.lat && a.lon === b.lon) flags.add("Uncertain heading");
    const when = new Date(epoch + time[i] * 1000);
    const key = [
      b.lat.toFixed(1),
      b.lon.toFixed(1),
      Math.floor(when.getTime() / 3600000),
    ].join("/");
    if (key !== weatherKey) {
      if (weatherKey) singleWeatherCell = false;
      weatherKey = key;
      try {
        weather = await lookupWeather(b, when, true);
        if (weather.gust > 7 || weather.gust - weather.wind > 4)
          flags.add("Gusty");
        if (weather.wet) flags.add("Wet surface");
      } catch {
        weather = calm;
        flags.add("Weather unknown");
      }
    }
    firstWeather ??= weather;
    const v0 = speeds?.[i - 1],
      v1 = speeds?.[i];
    let kineticChange = 0;
    if (
      v0 != null &&
      v1 != null &&
      Number.isFinite(v0) &&
      Number.isFinite(v1) &&
      v0 >= 0 &&
      v1 >= 0
    ) {
      kineticChange = (v1 * v1 - v0 * v0) / 2;
      if (Math.abs(kineticChange / ds) > 0.15) acceleratingSeconds += dt;
    } else flags.add("Speed endpoints missing");
    const step = powerTerms(speed, grade, heading, weather, kineticChange / dt);
    terms.aero += step.aero * dt;
    terms.rolling += step.rolling * dt;
    terms.load += step.load * dt;
    duration += dt;
    distance += ds;
    elevation += dz;
    energy += power * dt;
    squaredWatts += power * power * dt;
    kinetic += kineticChange;
    minGrade = Math.min(minGrade, grade);
    maxGrade = Math.max(maxGrade, grade);
  }
  if (!duration || !energy)
    return "no usable moving samples with measured power.";
  const elapsed = time[end] - time[start];
  if (duration < elapsed)
    flags.add(duration + " of " + elapsed + " s modeled (stops or gaps)");
  const watts = energy / duration,
    speed = distance / duration,
    grade = elevation / distance;
  if (duration < 45) flags.add("Short effort");
  if (speed < 2 || watts <= 25) flags.add("Low speed or power");
  if (Math.abs(grade) >= 0.22) flags.add("Steep grade");
  if (
    Math.sqrt(Math.max(0, squaredWatts / duration - watts ** 2)) >
    0.3 * watts
  )
    flags.add("Variable power");
  const accel = kinetic / distance;
  if (Math.abs(accel) > 0.04 || acceleratingSeconds > duration * 0.1)
    flags.add("Acceleration");
  return {
    speed,
    grade,
    watts,
    accel,
    duration,
    flags: [...flags],
    terms: {
      aero: terms.aero / duration,
      rolling: terms.rolling / duration,
      load: terms.load / duration,
    },
    heading: firstHeading!,
    weather: firstWeather!,
    steadyClimb:
      minGrade >= 0.02 && maxGrade - minGrade < 0.01 && singleWeatherCell,
  };
}
