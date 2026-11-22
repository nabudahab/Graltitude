// Only a public origin is distributed. The Worker holds the Strava app secret.
export function syncOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    /* report the setup instruction below */
  }
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[a-z\d.-]+$/i.test(url.hostname)
  )
    throw Error(
      "Use the HTTPS origin of your Graltitude Worker, for example https://graltitude.account.workers.dev",
    );
  return url.origin;
}
