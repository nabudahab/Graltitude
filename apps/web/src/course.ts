import {
  distance,
  type Point,
  type Course,
} from "../../../packages/physics/index";
export function makeCourse(name: string, points: Point[]): Course {
  const kept: Point[] = [];
  for (const p of points) {
    if (
      !Object.values(p).every(Number.isFinite) ||
      Math.abs(p.lat) > 90 ||
      Math.abs(p.lon) > 180
    )
      throw Error("Invalid route coordinates or elevation.");
    if (!kept.length || p.d - kept[kept.length - 1].d >= 50) kept.push(p);
  }
  const end = points.at(-1);
  if (end && kept.length && end.d - kept.at(-1)!.d > 1) kept.push(end);
  if (kept.length < 2)
    throw Error("The route needs at least two distinct points with elevation.");
  return { name, points: kept, located: true };
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
