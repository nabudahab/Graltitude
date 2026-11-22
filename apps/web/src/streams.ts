import {
  bearing,
  calm,
  type Point,
  type Window,
} from "../../../packages/physics/index";
import { weatherAt } from "./weather";
export type Streams = Partial<
  Record<
    "time" | "distance" | "altitude" | "watts" | "velocity_smooth",
    { data: number[] }
  >
> & {
  moving?: { data: boolean[] };
  latlng?: { data: [number, number][] };
};
export async function summarize(
  id: string,
  start: string,
  s: Streams,
  group: boolean,
): Promise<Window[]> {
  const t = s.time?.data,
    d = s.distance?.data,
    h = s.altitude?.data,
    p = s.watts?.data,
    coords = s.latlng?.data;
  if (!t || !d || !h || !p || !coords) return [];
  const result: Window[] = [];
  let a = 0;
  while (a < t.length - 1) {
    let b = a + 1;
    while (b < t.length - 1 && t[b] - t[a] < 60) b++;
    const dt = t[b] - t[a],
      ds = d[b] - d[a],
      speed = ds / dt;
    const pos = (i: number): Point => ({
      lat: coords[i]?.[0],
      lon: coords[i]?.[1],
      d: d[i],
      z: h[i],
    });
    const mid = Math.floor((a + b) / 2),
      flags: string[] = group ? ["Possible drafting"] : [];
    let energy = 0,
      sumSq = 0,
      valid = true;
    for (let i = a + 1; i <= b; i++) {
      const step = t[i] - t[i - 1],
        w = p[i];
      if (
        step <= 0 ||
        step > 8 ||
        !Number.isFinite(w) ||
        (s.moving && !s.moving.data[i])
      )
        valid = false;
      energy += w * step;
      sumSq += w * w * step;
    }
    if (
      dt >= 45 &&
      valid &&
      speed >= 2 &&
      Number.isFinite(h[b] - h[a]) &&
      coords[a] &&
      coords[b] &&
      coords[mid]
    ) {
      const w = energy / dt,
        grade = (h[b] - h[a]) / ds;
      if (w > 25 && Math.abs(grade) < 0.22) {
        if (Math.sqrt(Math.max(0, sumSq / dt - w * w)) / w > 0.3)
          flags.push("Variable power");
        const v = s.velocity_smooth?.data;
        const accel = v ? (v[b] ** 2 - v[a] ** 2) / (2 * ds) : 0;
        if (!Number.isFinite(accel)) {
          a = b;
          continue;
        }
        if (Math.abs(accel) > 0.04) flags.push("Acceleration");
        if (!v) flags.push("Speed endpoints missing");
        const turn = bearing(pos(a), pos(mid)) - bearing(pos(mid), pos(b));
        if (Math.abs(((turn + 540) % 360) - 180) > 45)
          flags.push("Changing direction");
        let weather = calm;
        try {
          weather = await weatherAt(
            pos(mid),
            new Date(Date.parse(start) + t[mid] * 1000),
            true,
          );
          if (weather.gust > 7 || weather.gust - weather.wind > 4)
            flags.push("Gusty");
          if (weather.wet) flags.push("Wet surface");
        } catch {
          flags.push("Weather unknown");
        }
        result.push({
          id: id + "-" + a,
          ride: id,
          speed,
          grade,
          watts: w,
          duration: dt,
          accel,
          heading: bearing(pos(a), pos(b)),
          weather,
          flags,
        });
      }
    }
    a = b;
  }
  return result;
}
