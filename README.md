# Graltitude

A mobile-friendly cycling calibration and climb planner. Select several bikes, review measured-power intervals for each one, and compare flat-ground power and climb times. The sample workspace runs immediately with two bikes and synthetic rides. Live activities enter through Strava OAuth.

## Run locally

Use Node 24 and npm.

```sh
npm ci
npm run dev
```

Open the local URL Vite prints. Use the ride title to expand its intervals. Each bike has an editable total mass and fallback rolling resistance. Select **Import segment** in the prediction panel. Import a GPX with elevation, paste a Strava segment page link or ID, or choose a starred cycling segment from the connected account. The planner uses the imported distance, grade and heading for every selected bike, including on segments the rider has never ridden. Choose a departure time for forecast weather. The sample course uses still air.

```sh
npm test
npm run build
```

## Deploy the web app

In the repository settings, select **Pages → Source → GitHub Actions**. The Pages workflow tests and builds on pushes to main and can also run manually. The relative asset base supports a project URL such as `https://nabudahab.github.io/Graltitude/`. The Pages build works in sample mode without a backend.

## Enable live Strava access

1. Register a Strava API application. Set its authorization callback domain to the hostname of your Cloudflare Worker. To connect a small group, enable the ten-athlete capacity in your Strava dashboard.
2. Authenticate Wrangler with `npx wrangler login`. Create the database with `npx wrangler d1 create graltitude` and put the returned database ID in `apps/api/wrangler.jsonc`. Set `APP_URL` to the full Pages URL with its trailing slash.
3. Apply the schema with `npx wrangler d1 migrations apply graltitude --remote --config apps/api/wrangler.jsonc`.
4. Set each Worker secret using `npx wrangler secret put NAME --config apps/api/wrangler.jsonc`. Use `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `TOKEN_KEY` (a base64-encoded 32-byte AES key, e.g. generated with `openssl rand -base64 32`), and `WEBHOOK_SECRET` (a random URL-safe verification token). Keep all four on the Worker.
5. Run `npm run api:deploy`. Set the GitHub repository **Actions variable** `VITE_API_URL` to the Worker HTTPS origin and rerun the Pages workflow. Only this public URL belongs in the frontend build.
6. Register the Strava webhook subscription using the callback `https://YOUR-WORKER/events/YOUR-WEBHOOK-SECRET` and the same value for its verify token. The Worker clears the server session on deauthorization. Each rider can also revoke access at Strava under **My Apps**.

For local integration use the same bindings in an ignored `apps/api/.dev.vars`, the local Vite URL for `APP_URL`, and `npx wrangler d1 migrations apply graltitude --local --config apps/api/wrangler.jsonc` before `npm run api:dev`. Set the shell variable `VITE_API_URL` to the local Worker origin when launching Vite. Strava must accept your callback host for the OAuth round trip.

## Data flow

GitHub Pages serves the UI. The Cloudflare Worker performs OAuth and fetches the signed-in athlete's activity list, gear, and detailed ride streams. The login handoff is short-lived, single-use, and bound to a verifier in the originating tab. D1 holds encrypted Strava tokens and hashed session identifiers. The browser keeps an opaque app session in session storage.

Sync lists the last 90 days in pages of 50 activities. Open a ride and choose **Analyze ride**, or analyze the selected bikes together. Ride lists refresh on demand. Group participation, power variability, acceleration, gusts, and wet surfaces flag intervals for review. Missing measured power prevents powered calibration. Missing weather is flagged and defaults to still air only if the rider includes the interval. Weather requests use rounded coordinates and UTC times. Per-rider preferences and interval choices stay on the current browser. Stream data, model fits, and loaded routes live in memory.

The TypeScript engine under `packages/physics` runs inside a browser Web Worker. It fits CdA and Crr to duration-weighted intervals using entered system mass, gravity, air density, relative wind, and a crank-to-wheel efficiency of 97.5%. An ill-conditioned fit falls back to the configured Crr; implausible CdA yields an unavailable model. The engine compares predicted and observed watts on whole held-out rides. For steady climbing intervals on those rides it also compares predicted and observed interval time, summarized per ride.

Segment simulation uses quasi-steady speeds over distance, a 60 km/h descent ceiling, and a forecast sampled near the start, middle and end at departure time. It suits uninterrupted climbs. Displayed time ranges measure sensitivity to held-out **power** error. Probabilistic prediction intervals, stopwatch validation on real climbs, automatic mass fitting, and corner/braking dynamics need further work.

[Strava API documentation](https://developers.strava.com/docs/) · [Strava API Policy](https://www.strava.com/legal/api_policy) · [Open-Meteo historical weather forecasts](https://open-meteo.com/en/docs/historical-forecast-api) · [Open-Meteo forecasts](https://open-meteo.com/en/docs)
