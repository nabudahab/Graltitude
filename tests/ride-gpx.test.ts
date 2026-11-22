import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { importRideGpx } from "../apps/web/src/rideGpx.ts";

Object.defineProperty(globalThis, "DOMParser", { value: DOMParser });

function rideFile(segments: (number | null)[][]) {
  let index = 0;
  const tracks = segments.map((samples, s) => {
    const points = samples.map((power) => {
      // Move the next track far away. Its first point must start a new leg.
      const latitude = 45 + s + index * 0.00007;
      const date = new Date(Date.UTC(2026, 0, 3, 9, 0, index++)).toISOString();
      const extension =
        power === null
          ? ""
          : `<extensions><p:power>${power}</p:power></extensions>`;
      return `<trkpt lat="${latitude}" lon="7"><time>${date}</time><ele>100</ele>${extension}</trkpt>`;
    });
    return "<trkseg>" + points.join("") + "</trkseg>";
  });
  return new File(
    [
      '<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:p="urn:power"><trk><name>Home loop</name>',
      ...tracks,
      "</trk></gpx>",
    ],
    "ride.gpx",
  );
}

test("portable GPX import keeps measured zero watts and omits missing power and track gaps", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("offline");
  });
  const ride = await importRideGpx(
    rideFile([
      [110, 0, null, 150],
      [250, 210],
    ]),
    "road",
    true,
    {},
  );
  assert.equal(ride.name, "Home loop");
  assert.equal(ride.bike, "road");
  assert.ok(ride.distance > 25 && ride.distance < 33);
  assert.equal(ride.windows.length, 1);
  const effort = ride.windows[0];
  assert.equal(effort.label, "Whole ride");
  assert.equal(effort.duration, 3);
  assert.equal(effort.watts, 120);
  assert.ok(effort.flags.includes("Possible drafting"));
  assert.ok(effort.flags.includes("Weather unknown"));
});

test("route-only files cannot enter the list of calibration rides", async () => {
  await assert.rejects(
    importRideGpx(rideFile([[null, null]]), "road", false, {}),
    /no recorded power/,
  );
});
