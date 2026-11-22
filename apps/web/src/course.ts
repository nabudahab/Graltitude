import {
  distance,
  type Point,
  type Course,
} from "../../../packages/physics/index.ts";
export function makeCourse(name: string, points: Point[]): Course {
  const kept: Point[] = [];
  let previousDistance = -1;
  for (const [i, p] of points.entries()) {
    if (
      ![p.lat, p.lon, p.z, p.d].every(Number.isFinite) ||
      Math.abs(p.lat) > 90 ||
      Math.abs(p.lon) > 180 ||
      p.d < 0 ||
      p.d < previousDistance
    )
      throw Error("Invalid segment coordinates, distance or elevation.");
    previousDistance = p.d;
    const point = { ...p, d: p.d - points[0].d };
    const last = kept.at(-1);
    if (
      !last ||
      point.d - last.d >= 50 ||
      (i === points.length - 1 && point.d > last.d)
    )
      kept.push(point);
  }
  if (kept.length < 2)
    throw Error(
      "The segment needs a positive distance and an elevation profile.",
    );
  return { name, points: kept, located: true };
}

export function segmentId(input: string): string {
  const value = input.trim();
  const match = value.match(
    /^(?:(?:https?:\/\/)?(?:www\.)?strava\.com\/segments\/)?([1-9]\d*)\/?(?:[?#].*)?$/i,
  );
  if (!match)
    throw Error(
      "Enter a numeric segment ID or a strava.com/segments/ link. You can also choose a starred segment.",
    );
  return match[1];
}

type SegmentStreams = {
  distance?: { data: number[] };
  altitude?: { data: number[] };
  latlng?: { data: [number, number][] };
};
export function stravaCourse(name: string, streams: SegmentStreams): Course {
  const coords = streams.latlng?.data,
    dist = streams.distance?.data,
    alt = streams.altitude?.data;
  if (
    !Array.isArray(coords) ||
    !Array.isArray(dist) ||
    !Array.isArray(alt) ||
    coords.length !== dist.length ||
    coords.length !== alt.length
  )
    throw Error(
      "Strava returned an incomplete segment profile. Try a GPX with elevation.",
    );
  return makeCourse(
    name,
    coords.map((coord, i) => ({
      lat: coord?.[0],
      lon: coord?.[1],
      d: dist[i],
      z: alt[i],
    })),
  );
}
export function parseGpx(xml: string, name: string) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw Error("Invalid GPX document.");
  const tracks = doc.querySelectorAll("trkseg");
  if (tracks.length > 1) throw Error("Choose a single continuous GPX track.");
  const nodes = doc.querySelectorAll("trkpt, rtept"),
    points: Point[] = [];
  for (const node of nodes) {
    const elevation = node.querySelector("ele")?.textContent?.trim();
    if (!elevation || !node.hasAttribute("lat") || !node.hasAttribute("lon"))
      throw Error("This GPX needs coordinates and elevation for every point.");
    const p = {
      lat: Number(node.getAttribute("lat")),
      lon: Number(node.getAttribute("lon")),
      z: Number(elevation),
      d: 0,
    };
    const prev = points.at(-1);
    if (prev) p.d = prev.d + distance(prev, p);
    points.push(p);
  }
  return makeCourse(name.replace(/\.gpx$/i, ""), points);
}
