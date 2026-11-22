import { useEffect, useRef, useState } from "react";
import type { Ride, Weather } from "../../../packages/physics/index.ts";
import { api } from "./api";
import type { PlannedCourse } from "./course";
import { courseWeather } from "./weather";

type SegmentEffort = {
  segment: string;
  watts: number;
  seconds: number;
  date: string;
  start: number;
  end: number;
};
export type SegmentObservation = SegmentEffort & {
  weather: Weather[];
  ride: string;
};
type Search = {
  course: PlannedCourse;
  checked: number;
  missingWeather: number;
  observations: SegmentObservation[];
  error?: string;
};

export function useSegmentHistory(
  course: PlannedCourse | null,
  rides: Ride[],
  enabled: boolean,
) {
  const cache = useRef(new Map<string, Promise<SegmentEffort[]>>());
  const [search, setSearch] = useState<Search>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !course?.stravaId) return;
    let cancelled = false;
    const planned = course;
    const observations: SegmentObservation[] = [];
    let checked = 0;
    let missingWeather = 0;

    function loadEfforts(id: string) {
      const cached = cache.current.get(id);
      if (cached) return cached;
      const request = api<{ efforts: SegmentEffort[] }>(
        "/rides/" + id + "/segment-efforts",
      )
        .then(({ efforts }) => {
          if (!Array.isArray(efforts)) throw Error("Segment history is unavailable.");
          return efforts;
        })
        .catch((error: unknown) => {
          cache.current.delete(id);
          throw error;
        });
      cache.current.set(id, request);
      return request;
    }

    async function scan() {
      setSearch({ course: planned, checked, missingWeather, observations: [] });
      // Limit parallel work and stop on upstream errors so a retry can resume
      // from cached rides without repeating their Strava requests.
      for (let offset = 0; offset < rides.length; offset += 4) {
        const batch = await Promise.allSettled(
          rides.slice(offset, offset + 4).map(async (ride) => {
            const efforts = await loadEfforts(ride.id);
            if (cancelled) return;
            const matches = efforts.filter(
              (effort) => effort.segment === planned.stravaId,
            );
            for (const effort of matches) {
              try {
                const weather = await courseWeather(
                  planned,
                  new Date(effort.date),
                  true,
                  effort.seconds,
                );
                if (cancelled) return;
                observations.push({ ...effort, ride: ride.id, weather });
              } catch {
                missingWeather++;
              }
              if (cancelled) return;
            }
            checked++;
          }),
        );
        if (cancelled) return;
        const failure = batch.find((result) => result.status === "rejected");
        const error = failure
          ? failure.reason instanceof Error
            ? failure.reason.message
            : "Could not search segment history."
          : undefined;
        setSearch({
          course: planned,
          checked,
          missingWeather,
          observations: [...observations],
          error,
        });
        if (failure) return;
      }
    }

    void scan();
    return () => {
      cancelled = true;
    };
  }, [course, rides, enabled, attempt]);

  return {
    search: enabled && search?.course === course ? search : undefined,
    retry: () => setAttempt((previous) => previous + 1),
  };
}
