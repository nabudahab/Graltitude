import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  calm,
  type Bike,
  type Course,
  type Ride,
  type Weather,
  type Window,
} from "../../../packages/physics/index";
import type { Results } from "./compute";
import PhysicsWorker from "./engine.worker.ts?worker&inline";
import { sampleBikes, sampleRides } from "./sample";
import { api, apiBase, connect, resume } from "./api";
import { importRideGpx } from "./rideGpx";
import { SegmentImport } from "./SegmentImport";
import { TargetPower } from "./TargetPower";
import { weatherAt } from "./weather";
import {
  analyzeRide,
  included,
  previouslyExcluded,
  type RideDetail,
} from "./streams";
import "./style.css";

type Prefs = {
  choices: Record<string, boolean>;
  assign: Record<string, string>;
  mass: Record<string, number>;
  crr: Record<string, number>;
  extra: Bike[];
};
const blank = (): Prefs => ({
  choices: {},
  assign: {},
  mass: {},
  crr: {},
  extra: [],
});
const portable = import.meta.env.MODE === "portable";
const initialOwner = portable ? "local-files" : "sample";
const initialBikes = portable ? [] : sampleBikes;
function readPrefs(owner: string): Prefs {
  try {
    return {
      ...blank(),
      ...JSON.parse(localStorage.getItem("graltitude/" + owner) || "{}"),
    };
  } catch {
    return blank();
  }
}
function duration(s: number) {
  return (
    Math.floor(Math.round(s) / 60) +
    ":" +
    String(Math.round(s) % 60).padStart(2, "0")
  );
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const selected = (r: Window, p: Prefs) => included(r, p.choices);
function Mark() {
  return (
    <svg
      width="32"
      height="26"
      viewBox="0 0 40 30"
      fill="none"
      aria-hidden="true"
    >
      <path d="M2 24 15 5l8 12 5-7 10 14H27L15 9 5 24z" fill="currentColor" />
    </svg>
  );
}
function Profile({ course }: { course: Course }) {
  const points = course.points,
    end = points.at(-1)!,
    low = points.reduce((v, p) => Math.min(v, p.z), Infinity),
    high = points.reduce((v, p) => Math.max(v, p.z), -Infinity);
  const line = points
    .map(
      (p, i) =>
        (i ? "L" : "M") +
        (8 + (284 * p.d) / end.d).toFixed(1) +
        " " +
        (88 - (70 * (p.z - low)) / (high - low || 1)).toFixed(1),
    )
    .join(" ");
  return (
    <svg
      className="profile"
      viewBox="0 0 300 105"
      role="img"
      aria-label={
        course.name +
        " elevation profile, " +
        Math.round(end.z - points[0].z) +
        " metres net gain"
      }
    >
      <defs>
        <pattern id="grid" width="28" height="23" patternUnits="userSpaceOnUse">
          <path d="M28 0H0V23" fill="none" stroke="#376353" strokeWidth=".9" />
        </pattern>
      </defs>
      <rect width="300" height="100" fill="url(#grid)" />
      <path d={line + " L292 97H8Z"} fill="#a3c480" opacity=".18" />
      <path
        d={line}
        fill="none"
        stroke="#d9f5ab"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function NumberSetting({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={() => {
          const n = Number(text);
          if (text.trim() && Number.isFinite(n) && n >= min && n <= max)
            onChange(n);
          else setText(String(value));
        }}
      />
    </label>
  );
}
function App() {
  const [owner, setOwner] = useState(initialOwner),
    [rides, setRides] = useState<Ride[]>(portable ? [] : sampleRides),
    [bikes, setBikes] = useState<Bike[]>(initialBikes);
  const [active, setActive] = useState(initialBikes.map((b) => b.id)),
    [prefs, setPrefs] = useState(() => readPrefs(initialOwner));
  const [fileBike, setFileBike] = useState("My bike"),
    [groupFiles, setGroupFiles] = useState(false);
  const [openRide, setOpenRide] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [live, setLive] = useState(false);
  const [course, setCourse] = useState<Course | null>(null),
    [power, setPower] = useState(220),
    [speed, setSpeed] = useState(30),
    [weather, setWeather] = useState<Weather[]>([calm]),
    [when, setWhen] = useState("");
  const [results, setResults] = useState<Results>([]),
    [newBike, setNewBike] = useState("");
  const [tab, setTab] = useState<"rides" | "plan">("rides"),
    [more, setMore] = useState(false),
    [page, setPage] = useState(1);
  const engine = useRef<Worker | null>(null),
    busyRef = useRef(false),
    ridesWithoutPower = useRef(new Set<string>());
  const allBikes = useMemo(
    () => [...bikes, ...prefs.extra],
    [bikes, prefs.extra],
  );
  const bikeFor = (r: Ride) => prefs.assign[r.id] ?? r.bike;
  const shown = rides.filter((r) => active.includes(bikeFor(r)) || !bikeFor(r));
  const pendingRides = shown.filter((r) => !r.windows.length && !r.issue);
  useEffect(() => {
    try {
      localStorage.setItem("graltitude/" + owner, JSON.stringify(prefs));
    } catch {
      /* storage unavailable in private browsing */
    }
  }, [owner, prefs]);
  useEffect(() => {
    engine.current = new PhysicsWorker();
    engine.current.onmessage = (e) => setResults(e.data);
    engine.current.onerror = () =>
      setStatus("The simulation worker failed. Reload to retry.");
    return () => engine.current?.terminate();
  }, []);
  useEffect(() => {
    const rows = rides.flatMap((r) =>
      r.windows
        .filter((w) => selected(w, prefs))
        .map((w) => ({ bike: bikeFor(r), window: w })),
    );
    engine.current?.postMessage({
      type: "fit",
      bikes: allBikes
        .filter((b) => active.includes(b.id))
        .map((b) => ({
          id: b.id,
          mass: prefs.mass[b.id] ?? b.mass,
          crr: prefs.crr[b.id] ?? 0.005,
          rows: rows.filter((r) => r.bike === b.id).map((r) => r.window),
        })),
    });
  }, [rides, allBikes, prefs, active]);
  useEffect(() => {
    engine.current?.postMessage({
      type: "plan",
      plan: { course, power, speed, weather },
    });
  }, [course, power, speed, weather]);
  async function run(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setStatus("");
    try {
      await fn();
    } catch (e) {
      setStatus(errText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function load(pageNumber = 1) {
    const data = await api<{
      athlete: string;
      more: boolean;
      rides: (Ride & { deviceWatts: boolean })[];
      gear: Record<string, string>;
    }>("/rides?page=" + pageNumber);
    const eligible = data.rides.filter(
      (r) => r.deviceWatts === true && !ridesWithoutPower.current.has(r.id),
    );
    const known = pageNumber === 1 ? [] : bikes;
    const fresh = [
      ...new Set(
        eligible
          .map((r) => r.bike)
          .filter((id) => id && !known.some((b) => b.id === id)),
      ),
    ];
    const added: Bike[] = fresh.map((id) => ({
      id,
      name: data.gear[id] || id,
      mass: 85,
    }));
    const settings = readPrefs(data.athlete);
    setOwner(data.athlete);
    setPrefs(settings);
    setBikes([...known, ...added]);
    setLive(true);
    setActive((old) =>
      pageNumber === 1
        ? [...added, ...settings.extra].map((b) => b.id)
        : [...old, ...added.map((b) => b.id)],
    );
    setRides((old) =>
      pageNumber === 1
        ? eligible
        : [
            ...old,
            ...eligible.filter((r) => !old.some((k) => k.id === r.id)),
          ],
    );
    setMore(data.more && pageNumber < 10);
    setPage(pageNumber);
    setOpenRide("");
  }
  useEffect(() => {
    if (portable && !apiBase) return;
    void run(async () => {
      if (await resume()) {
        try {
          await load();
        } catch (e) {
          sessionStorage.removeItem("graltitude-session");
          throw e;
        }
      }
    });
  }, []);
  async function importFiles(files: File[]) {
    const name = fileBike.trim();
    if (!name || !files.length) return;
    const bikeId = "local:" + name.toLowerCase();
    const added = new Map<string, Ride>();
    const messages: string[] = [];
    for (const file of files) {
      setStatus("Reading " + file.name + "…");
      try {
        const ride = await importRideGpx(
          file,
          bikeId,
          groupFiles,
          prefs.choices,
        );
        if (rides.some((r) => r.id === ride.id) || added.has(ride.id))
          messages.push(file.name + " is already in this workspace.");
        else added.set(ride.id, ride);
      } catch (e) {
        messages.push(file.name + " — " + errText(e));
      }
    }
    if (added.size) {
      if (!bikes.some((b) => b.id === bikeId))
        setBikes((old) => [...old, { id: bikeId, name, mass: 85 }]);
      setActive((old) => (old.includes(bikeId) ? old : [...old, bikeId]));
      setRides((old) => [...old, ...added.values()]);
      setOpenRide(added.values().next().value!.id);
      messages.unshift(
        `Imported ${added.size} ${added.size === 1 ? "ride" : "rides"}. Check the efforts you want to use for calibration.`,
      );
    }
    setStatus(messages.join(" "));
  }
  async function analyze(r: Ride) {
    setStatus("Reviewing " + r.name + "…");
    const data = await api<RideDetail>("/rides/" + r.id);
    if (data.eligible === false) {
      ridesWithoutPower.current.add(r.id);
      setRides((prev) => prev.filter((x) => x.id !== r.id));
      setStatus(r.name + " was excluded because measured power is unavailable.");
      return;
    }
    const analysis = await analyzeRide(r, data, prefs.choices);
    setRides((prev) =>
      prev.map((x) => (x.id === r.id ? { ...x, ...analysis } : x)),
    );
    setStatus("");
  }
  function include(windows: Window[], checked: boolean) {
    setPrefs((p) => ({
      ...p,
      choices: {
        ...p.choices,
        ...Object.fromEntries(windows.map((w) => [w.id, checked])),
      },
    }));
  }
  function chooseCourse(c: Course) {
    setCourse(c);
    setWeather([calm]);
    setStatus("");
  }
  async function forecast() {
    if (!when || !course?.located)
      throw Error("Load a route and choose a departure time first.");
    const time = new Date(when);
    const data = await Promise.all(
      [1 / 6, 1 / 2, 5 / 6].map((f) =>
        weatherAt(
          course.points[Math.floor((course.points.length - 1) * f)],
          time,
          false,
        ),
      ),
    );
    setWeather(data);
  }
  const total = shown.reduce(
    (n, r) => n + r.windows.filter((w) => selected(w, prefs)).length,
    0,
  );
  const gain = course?.points.reduce(
    (n, p, i, a) => n + (i ? Math.max(0, p.z - a[i - 1].z) : 0),
    0,
  ) ?? 0;
  const importer = (
    <SegmentImport live={live} busy={busy} run={run} choose={chooseCourse} />
  );
  return (
    <>
      <header>
        <div className="bar">
          <a className="brand" href={portable ? "#root" : "./"}>
            <Mark /> Graltitude
          </a>
          <span className="mode">
            <i />
            {live
              ? "Strava workspace"
              : portable
                ? "Local ride files"
                : "Sample workspace"}
          </span>
          {(!portable || apiBase) && (
            <button
              className="connect"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (live) {
                    try {
                      await api("/logout", {});
                    } finally {
                      sessionStorage.removeItem("graltitude-session");
                      location.reload();
                    }
                  } else await connect();
                })
              }
            >
              {live ? "Sign out" : "Connect with Strava"} ↗
            </button>
          )}
        </div>
      </header>
      <main>
        <div className="intro">
          <div>
            <div className="kicker">CYCLING PHYSICS</div>
            <h1>
              Ride lab<span>.</span>
            </h1>
            <p>Calibrate your bikes and plan the next climb.</p>
          </div>
          <div className="tabset" aria-label="Workspace view">
            {(
              [
                ["rides", "Calibration"],
                ["plan", "Segment planner"],
              ] as const
            ).map(([id, label]) => (
              <button
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
                key={id}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {status && (
          <div role="status" className="notice">
            {status}
          </div>
        )}
        <div className="layout">
          <div className="work">
            {portable && !live && tab === "rides" && (
              <section className="panel">
                <h2>Import your rides</h2>
                <p>
                  Open a ride on the Strava website and choose{" "}
                  <b>… → Export GPX</b>. Pick files recorded with a power meter
                  on the same bike.
                </p>
                <label className="field">
                  Bike name
                  <input
                    value={fileBike}
                    onChange={(e) => setFileBike(e.target.value)}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={groupFiles}
                    onChange={(e) => setGroupFiles(e.target.checked)}
                  />{" "}
                  Group rides
                </label>
                <div className="actions">
                  <label className="file">
                    Choose ride files
                    <input
                      type="file"
                      accept=".gpx"
                      multiple
                      disabled={busy || !fileBike.trim()}
                      onChange={(e) => {
                        const files = Array.from(e.currentTarget.files ?? []);
                        e.currentTarget.value = "";
                        void run(() => importFiles(files));
                      }}
                    />
                  </label>
                </div>
                <small>
                  Ride files stay on this laptop. Weather lookups use rounded
                  locations and dates. Reopen the files after closing the app.
                </small>
              </section>
            )}
            <section className="panel">
              <div className="head">
                <h2>Your bikes</h2>
                <small>{active.length} selected</small>
              </div>
              <div className="bikes">
                {allBikes.map((b) => (
                  <label
                    className={"bike " + (active.includes(b.id) ? "on" : "")}
                    key={b.id}
                  >
                    <input
                      type="checkbox"
                      checked={active.includes(b.id)}
                      onChange={(e) =>
                        setActive((a) =>
                          e.target.checked
                            ? [...a, b.id]
                            : a.filter((v) => v !== b.id),
                        )
                      }
                    />
                    <span>
                      <strong>{b.name}</strong>
                      <small>
                        {rides.filter((r) => bikeFor(r) === b.id).length} rides
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              {live && (
                <details>
                  <summary>Add a bike</summary>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!newBike.trim()) return;
                      const b = {
                        id: crypto.randomUUID(),
                        name: newBike.trim(),
                        mass: 85,
                      };
                      setPrefs((p) => ({ ...p, extra: [...p.extra, b] }));
                      setActive((a) => [...a, b.id]);
                      setNewBike("");
                    }}
                  >
                    <input
                      aria-label="New bike name"
                      placeholder="Bike name"
                      value={newBike}
                      onChange={(e) => setNewBike(e.target.value)}
                    />
                    <button>Add</button>
                  </form>
                </details>
              )}
            </section>
            {tab === "rides" ? (
              <section className="panel">
                <div className="head">
                  <div>
                    <div className="kicker">RIDE SELECTION</div>
                    <h2>Calibration rides</h2>
                  </div>
                  <small>
                    {total} {total === 1 ? "effort" : "efforts"} in use
                  </small>
                </div>
                {live && (
                  <div className="actions">
                    <button
                      disabled={busy || !pendingRides.length}
                      onClick={() =>
                        run(async () => {
                          for (const ride of pendingRides) await analyze(ride);
                        })
                      }
                    >
                      Analyze selected bikes
                    </button>
                    <button disabled={busy} onClick={() => run(() => load())}>
                      Refresh list
                    </button>
                  </div>
                )}
                {!shown.length && (
                  <p className="empty">
                    {live
                      ? "No rides with measured power for the selected bikes on the loaded pages."
                      : "No rides for the selected bikes."}
                  </p>
                )}
                {shown.map((r) => {
                  const used = r.windows.filter((w) =>
                      selected(w, prefs),
                    ).length,
                    expanded = openRide === r.id,
                    flags = [...new Set(r.windows.flatMap((w) => w.flags))];
                  return (
                    <article className="ride" key={r.id}>
                      <div className="rideRow">
                        <input
                          aria-label={"Include all efforts from " + r.name}
                          type="checkbox"
                          ref={(el) => {
                            if (el)
                              el.indeterminate =
                                used > 0 && used < r.windows.length;
                          }}
                          checked={used > 0 && used === r.windows.length}
                          disabled={!r.windows.length}
                          onChange={(e) => include(r.windows, e.target.checked)}
                        />
                        <button
                          className="rideTitle"
                          onClick={() => setOpenRide(expanded ? "" : r.id)}
                          aria-expanded={expanded}
                        >
                          <strong>{r.name}</strong>
                          <small>
                            {new Date(r.date).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            })}{" "}
                            · {(r.distance / 1000).toFixed(1)} km ·{" "}
                            {allBikes.find((b) => b.id === bikeFor(r))?.name ||
                              "Unassigned"}
                          </small>
                        </button>
                        <span
                          className={
                            "pill " +
                            (r.issue || flags.length || r.group ? "warn" : "")
                          }
                        >
                          {r.issue
                            ? r.windows.length
                              ? "Review"
                              : "Unavailable"
                            : r.group
                              ? "Group ride"
                              : flags.length
                                ? "Review"
                                : r.windows.length
                                  ? "Ready"
                                  : "Unreviewed"}
                        </span>
                      </div>
                      {expanded && (
                        <div className="intervals">
                          {(live || portable) && (
                            <label>
                              Bike{" "}
                              <select
                                value={bikeFor(r)}
                                onChange={(e) =>
                                  setPrefs((p) => ({
                                    ...p,
                                    assign: {
                                      ...p.assign,
                                      [r.id]: e.target.value,
                                    },
                                  }))
                                }
                              >
                                <option value="">Unassigned</option>
                                {allBikes.map((b) => (
                                  <option key={b.id} value={b.id}>
                                    {b.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          {r.issue && <p>{r.issue}</p>}
                          {!r.windows.length && live && (
                            <button
                              disabled={busy}
                              onClick={() => run(() => analyze(r))}
                            >
                              Analyze ride
                            </button>
                          )}
                          {r.windows.map((w) => (
                            <label className="interval" key={w.id}>
                              <input
                                type="checkbox"
                                checked={selected(w, prefs)}
                                onChange={(e) => include([w], e.target.checked)}
                              />
                              <span>
                                {w.label} · {Math.round(w.watts)} W avg ·{" "}
                                {(w.grade * 100).toFixed(1)}% avg grade
                                <small>
                                  {w.flags.length > 0 &&
                                    w.flags.join(" · ") + " · "}
                                  {prefs.choices[w.id] === undefined &&
                                    previouslyExcluded(w, prefs.choices) &&
                                    "Previously excluded effort · "}
                                  {w.duration} s
                                </small>
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}
                {more && (
                  <button
                    disabled={busy}
                    onClick={() => run(() => load(page + 1))}
                  >
                    Load older rides
                  </button>
                )}
              </section>
            ) : (
              <section className="panel">
                {importer}
                {course && (
                  <>
                    <p className="current-segment" role="status">
                      Planning for <strong>{course.name}</strong> ·{" "}
                      <a href="#prediction">View prediction</a>
                    </p>
                    <label className="field">
                      Departure time (local)
                      <input
                        type="datetime-local"
                        value={when}
                        onChange={(e) => {
                          setWhen(e.target.value);
                          setWeather([calm]);
                        }}
                        disabled={busy}
                      />
                    </label>
                    <div className="actions">
                      <button
                        disabled={busy || !course.located || !when}
                        onClick={() => run(forecast)}
                      >
                        Use forecast
                      </button>
                      <button disabled={busy} onClick={() => setWeather([calm])}>
                        Use still air
                      </button>
                    </div>
                    <small>
                      {weather.length > 1
                        ? "Open-Meteo forecast applied at three route locations."
                        : "Still air · 1.225 kg/m³ air density"}
                    </small>
                    <p className="muted">
                      Climb times assume steady crank power and uninterrupted
                      riding. Descents are capped at 60 km/h.
                    </p>
                  </>
                )}
              </section>
            )}
            <section className="panel">
              <div className="head">
                <h2>Bike setup</h2>
                <small>Per selected bike</small>
              </div>
              {allBikes
                .filter((b) => active.includes(b.id))
                .map((b) => (
                  <div className="setup" key={b.id}>
                    <strong>{b.name}</strong>
                    <NumberSetting
                      label="Rider + bike + kit (kg)"
                      value={prefs.mass[b.id] ?? b.mass}
                      min={25}
                      max={250}
                      step={0.1}
                      onChange={(value) =>
                        setPrefs((p) => ({
                          ...p,
                          mass: { ...p.mass, [b.id]: value },
                        }))
                      }
                    />
                    <NumberSetting
                      label="Default rolling resistance (Crr)"
                      value={prefs.crr[b.id] ?? 0.005}
                      min={0.001}
                      max={0.035}
                      step={0.001}
                      onChange={(value) =>
                        setPrefs((p) => ({
                          ...p,
                          crr: { ...p.crr, [b.id]: value },
                        }))
                      }
                    />
                  </div>
                ))}
              <small>
                The model uses the mass you enter. It estimates rolling
                resistance from your rides when it can separate it from air
                drag. Otherwise it uses your default.
              </small>
            </section>
          </div>
          <aside>
            {!course ? (
              <section className="predict" id="prediction">
                <div className="head">
                  <div className="kicker">SEGMENT PREDICTION</div>
                </div>
                {tab === "rides" ? importer : (
                  <a href="#segment-import">
                    Import a segment to predict your time
                  </a>
                )}
              </section>
            ) : <section className="predict" id="prediction">
              <div className="head">
                <div className="kicker">SEGMENT PREDICTION</div>
                <button
                  className="import-shortcut"
                  onClick={() => {
                    setTab("plan");
                    requestAnimationFrame(() =>
                      document.getElementById("segment-import")?.focus(),
                    );
                  }}
                >
                  Import segment
                </button>
              </div>
              <h2>{course.name}</h2>
              <Profile course={course} />
              <div className="stats">
                <span>
                  <b>{(course.points.at(-1)!.d / 1000).toFixed(1)}</b> km
                </span>
                <span>
                  <b>{Math.round(gain)}</b> m gain
                </span>
              </div>
              <TargetPower value={power} onChange={setPower} />
              {results.map((r) => (
                <div className="timing" key={r.id}>
                  <span>{allBikes.find((b) => b.id === r.id)?.name}</span>
                  <strong>{r.seconds != null ? duration(r.seconds) : "—"}</strong>
                  {r.range && (
                    <small>
                      {duration(r.range[0])}–{duration(r.range[1])} ·
                      power-error sensitivity
                    </small>
                  )}
                  {!r.model && (
                    <small>
                      Select more usable laps or rides to fit this bike.
                    </small>
                  )}
                </div>
              ))}
              {!active.length && <p>Select a bike to predict its time.</p>}
            </section>}
            <section className="panel model">
              <div className="kicker">NEUTRAL CONDITIONS</div>
              <h2>Flat-ground power</h2>
              <label className="slider">
                <span>
                  Target speed <b>{speed} km/h</b>
                </span>
                <input
                  type="range"
                  min="15"
                  max="50"
                  value={speed}
                  onChange={(e) => setSpeed(+e.target.value)}
                />
              </label>
              {results.map((r) => (
                <div className="readout" key={r.id}>
                  <small>{allBikes.find((b) => b.id === r.id)?.name}</small>
                  <strong>{r.model ? Math.round(r.flat!) + " W" : "—"}</strong>
                  {r.model && (
                    <small>
                      CdA {r.model.cda.toFixed(3)} m² · Crr{" "}
                      {r.model.crr.toFixed(4)}
                      {r.model.assumedCrr ? " (bike setup default)" : " (from rides)"}
                    </small>
                  )}
                </div>
              ))}
            </section>
            <section className="panel">
              <h2>Calibration and accuracy</h2>
              <p className="check">
                Each bike uses all its selected efforts. To check accuracy, we
                take out one ride at a time and predict it from the other rides.
              </p>
              {results.map((r) => (
                <p className="check" key={r.id}>
                  <b>{allBikes.find((b) => b.id === r.id)?.name}</b>
                  <br />
                  {r.model ? (
                    <>
                      Calibrated with {r.model.calibrationRides}{" "}
                      {r.model.calibrationRides === 1 ? "ride" : "rides"}.
                      <br />
                      {r.model.heldOutRides
                        ? `Average power error of ${r.model.wattsError.toFixed(1)} W across ${r.model.heldOutRides} ${r.model.heldOutRides === 1 ? "ride" : "rides"} checked.`
                        : "Select another usable ride to check accuracy."}
                    </>
                  ) : "Select usable efforts from this bike to calibrate it."}
                  {r.model?.timingErrorPct != null &&
                    " Average time error on steady climbs was " +
                      r.model.timingErrorPct.toFixed(1) +
                      "%."}
                  {r.model?.assumedCrr &&
                    " Add a sheltered loop at several speeds to separate drag from rolling resistance."}
                </p>
              ))}
              <small>
                Segment time ranges show how the estimate changes if your power
                is higher or lower by the average error. Wind and route errors
                can also affect your time.
              </small>
            </section>
          </aside>
        </div>
      </main>
      <footer>
        <span>Graltitude · Ride lab</span>
        {portable && apiBase && <a href="/desktop/settings">Strava settings</a>}
        <span>
          {live
            ? "Powered by Strava"
            : portable
              ? "Local ride files"
              : "Synthetic sample rides"}{" "}
          · <a href="https://open-meteo.com/">Weather by Open-Meteo</a>
        </span>
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
