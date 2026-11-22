import {
  distance,
  type Point,
  type Ride,
} from "../../../packages/physics/index.ts";
import { analyzeRide, type Streams } from "./streams.ts";

function number(text: string | null | undefined) {
  return text?.trim() ? Number(text) : NaN;
}

export async function importRideGpx(
  file: File,
  bike: string,
  group: boolean,
  choices: Record<string, boolean>,
): Promise<Ride> {
  const xml = new DOMParser().parseFromString(
    await file.text(),
    "application/xml",
  );
  const tracks = xml.getElementsByTagNameNS("*", "trk");
  if (
    xml.getElementsByTagNameNS("*", "parsererror").length ||
    tracks.length !== 1
  )
    throw Error("Choose a GPX containing one recorded ride.");
  const track = tracks[0];
  const time: number[] = [],
    watts: number[] = [],
    altitude: number[] = [],
    latlng: [number, number][] = [],
    distances: number[] = [],
    speeds: number[] = [],
    moving: boolean[] = [];
  let previous: Point | undefined;
  let start = 0;
  for (const segment of track.getElementsByTagNameNS("*", "trkseg")) {
    previous = undefined;
    for (const pt of segment.getElementsByTagNameNS("*", "trkpt")) {
      const field = (name: string) =>
        pt.getElementsByTagNameNS("*", name)[0]?.textContent;
      const lat = number(pt.getAttribute("lat")),
        lon = number(pt.getAttribute("lon"));
      const z = number(field("ele")),
        epoch = Date.parse(field("time") ?? "");
      if (
        ![lat, lon, z, epoch].every(Number.isFinite) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180
      )
        throw Error("Each track point needs GPS, elevation and a timestamp.");
      if (!time.length) start = epoch;
      const t = (epoch - start) / 1000;
      const dt = t - (time.at(-1) ?? 0);
      if (time.length && dt <= 0) throw Error("Ride timestamps must increase.");
      const p = { lat, lon, z, d: distances.at(-1) ?? 0 };
      const ds = previous ? distance(previous, p) : 0;
      p.d += ds;
      const power = number(
        field("power") ?? field("PowerInWatts") ?? field("Watts"),
      );
      const speed = number(field("speed"));
      if (previous && dt <= 8 && !Number.isFinite(speeds.at(-1)))
        speeds[speeds.length - 1] = ds / dt;
      time.push(t);
      distances.push(p.d);
      latlng.push([lat, lon]);
      altitude.push(z);
      watts.push(power);
      speeds.push(speed >= 0 ? speed : dt > 0 && previous ? ds / dt : NaN);
      // Omit segment boundaries and individual samples that lack recorded power.
      moving.push(!!previous && ds > 0 && Number.isFinite(power) && power >= 0);
      previous = p;
    }
  }
  if (!watts.some((v) => v > 0 && Number.isFinite(v)))
    throw Error(
      "This file contains no recorded power. Export a ride recorded with a power meter.",
    );
  const date = new Date(start).toISOString();
  const ride = {
    id: "gpx-" + date,
    date,
    bike,
    group,
    name:
      track.getElementsByTagNameNS("*", "name")[0]?.textContent?.trim() ||
      file.name,
    distance: distances.at(-1) ?? 0,
  };
  const streams: Streams = {
    time: { data: time },
    watts: { data: watts },
    altitude: { data: altitude },
    latlng: { data: latlng },
    distance: { data: distances },
    velocity_smooth: { data: speeds },
    moving: { data: moving },
  };
  const analysis = await analyzeRide(ride, { streams }, choices);
  if (!analysis.windows.length)
    throw Error(analysis.issue || "No usable moving samples.");
  return { ...ride, ...analysis };
}
