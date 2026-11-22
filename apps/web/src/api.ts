const configuredApi = import.meta.env.VITE_API_URL as string | undefined;
// The desktop server adds this tag when it serves the standalone file.
const desktopApi =
  import.meta.env.MODE === "portable" && location.protocol !== "file:"
    ? document.querySelector<HTMLMetaElement>('meta[name="graltitude-api"]')
        ?.content
    : undefined;
export const apiBase = (configuredApi || desktopApi)?.replace(/\/$/, "");
export async function api<T>(path: string, post?: unknown): Promise<T> {
  if (!apiBase)
    throw Error(
      "Live sync needs a configured Strava Worker. The sample workspace is ready to use.",
    );
  const session = sessionStorage.getItem("graltitude-session");
  const r = await fetch(apiBase + path, {
    method: post === undefined ? "GET" : "POST",
    headers: {
      ...(session ? { Authorization: "Bearer " + session } : {}),
      ...(post === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: post === undefined ? undefined : JSON.stringify(post),
    signal: AbortSignal.timeout(30000),
  });
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok) throw Error(data.error || "Request failed.");
  return data as T;
}
export async function connect() {
  if (!apiBase)
    throw Error(
      "Live sync needs a configured Strava Worker. See the setup steps in the repository.",
    );
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  sessionStorage.setItem("graltitude-verifier", verifier);
  location.assign(apiBase + "/auth/start?challenge=" + challenge);
}
export async function resume() {
  const frag = new URLSearchParams(location.hash.slice(1)),
    code = frag.get("handoff");
  if (code || frag.has("auth"))
    history.replaceState(null, "", location.pathname + location.search);
  if (frag.get("auth") === "declined")
    throw Error("Strava access was declined.");
  if (code) {
    const verifier = sessionStorage.getItem("graltitude-verifier");
    const data = await api<{ session: string }>("/auth/exchange", {
      code,
      verifier,
    });
    sessionStorage.removeItem("graltitude-verifier");
    sessionStorage.setItem("graltitude-session", data.session);
  }
  return !!sessionStorage.getItem("graltitude-session");
}
