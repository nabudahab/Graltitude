import { type Point, type Weather } from "../../../packages/physics/index";
type Hourly = {
  time: string[];
  wind_speed_10m: number[];
  wind_direction_10m: number[];
  wind_gusts_10m: number[];
  temperature_2m: number[];
  surface_pressure: number[];
  precipitation: number[];
};
const cache = new Map<string, { data: Promise<Hourly>; expires: number }>();
export async function weatherAt(
  p: Point,
  when: Date,
  historical: boolean,
): Promise<Weather> {
  const day = when.toISOString().slice(0, 10);
  const host = historical ? "historical-forecast-api" : "api";
  const url = new URL("https://" + host + ".open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: p.lat.toFixed(1),
    longitude: p.lon.toFixed(1),
    start_date: day,
    end_date: day,
    timezone: "GMT",
    wind_speed_unit: "ms",
    hourly:
      "wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,surface_pressure,precipitation",
  }).toString();
  const key = url.href;
  if (!cache.has(key) || cache.get(key)!.expires < Date.now())
    cache.set(key, {
      expires: Date.now() + (historical ? 86400000 : 900000),
      data: fetch(url, { signal: AbortSignal.timeout(12000) })
        .then(async (r) => {
          if (!r.ok)
            throw Error("Weather data unavailable for the selected date.");
          return ((await r.json()) as { hourly: Hourly }).hourly;
        })
        .catch((err) => {
          const entry = cache.get(key);
          if (entry) entry.expires = Date.now() + 60000;
          throw err;
        }),
    });
  const data = await cache.get(key)!.data;
  const i = data.time.indexOf(when.toISOString().slice(0, 13) + ":00");
  if (i < 0 || Object.values(data).some((v) => v[i] == null))
    throw Error("Missing hourly weather.");
  return {
    wind: data.wind_speed_10m[i],
    gust: data.wind_gusts_10m[i],
    direction: data.wind_direction_10m[i],
    density:
      (data.surface_pressure[i] * 100) /
      (287.05 * (273.15 + data.temperature_2m[i])),
    wet: data.precipitation[i] > 0.1,
  };
}
