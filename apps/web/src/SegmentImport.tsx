import { useState } from "react";
import { api, apiBase, connect } from "./api";
import { parseGpx, segmentId, stravaCourse, type PlannedCourse } from "./course";
import type { Streams } from "./streams";

type Starred = { id: string; name: string };
type Props = {
  live: boolean;
  busy: boolean;
  choose: (course: PlannedCourse) => void;
  run: (fn: () => Promise<void>) => Promise<void>;
};
export function SegmentImport({ live, busy, choose, run }: Props) {
  const [input, setInput] = useState("");
  const [stars, setStars] = useState<Starred[]>([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState("");
  function submit(fn: () => Promise<void>) {
    return run(async () => {
      setError("");
      try {
        await fn();
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : "Segment import failed.",
        );
      }
    });
  }
  async function load(id: string) {
    const streams = await api<Streams & { name?: string }>("/segments/" + id);
    choose(stravaCourse(streams.name || "Strava segment " + id, streams, id));
  }
  async function browse() {
    const next = page + 1;
    const list = await api<{ segments: Starred[]; more: boolean }>(
      "/segments/starred?page=" + next,
    );
    setStars((previous) => [
      ...previous,
      ...list.segments.filter((s) => !previous.some((p) => p.id === s.id)),
    ]);
    setMore(list.more);
    setPage(next);
  }
  return (
    <div className="importer">
      <h2 tabIndex={-1} id="segment-import">
        Import segment
      </h2>
      {live ? (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(() => load(segmentId(input)));
            }}
          >
            <input
              placeholder="Strava segment URL or ID"
              aria-label="Strava segment URL or ID"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button disabled={busy || !input.trim()}>Import from Strava</button>
          </form>
          {stars.length > 0 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit(() => load(chosen));
              }}
            >
              <select
                value={chosen}
                aria-label="Starred cycling segments"
                onChange={(e) => setChosen(e.target.value)}
              >
                <option value="">Choose a starred segment</option>
                {stars.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button disabled={!chosen || busy}>Use selected segment</button>
            </form>
          )}
          {page > 0 && !stars.length && (
            <small>No starred cycling segments on the pages loaded.</small>
          )}
        </>
      ) : (
        <p className="muted">
          {apiBase
            ? "Connect Strava to import by link or choose a starred segment."
            : "Import a GPX with elevation here. Strava links and starred segments require a configured Strava connection."}
        </p>
      )}
      <div className="actions">
        {live && (page === 0 || more) && (
          <button disabled={busy} onClick={() => void submit(browse)}>
            {page ? "Load more starred segments" : "Browse starred segments"}
          </button>
        )}
        {!live && apiBase && (
          <button disabled={busy} onClick={() => void submit(connect)}>
            Connect Strava
          </button>
        )}
        <label className="file">
          Import GPX
          <input
            type="file"
            accept=".gpx,application/gpx+xml"
            disabled={busy}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file)
                void submit(async () =>
                  choose(parseGpx(await file.text(), file.name)),
                );
            }}
          />
        </label>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
