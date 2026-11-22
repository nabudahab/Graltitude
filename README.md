# Graltitude

A mobile-friendly cycling calibration and climb planner. Select several bikes, review laps and whole rides with measured power, and compare flat-ground power and climb times. The sample workspace runs immediately with two bikes and synthetic rides. Live activities enter through Strava OAuth.

## Open Ride Lab on Windows, macOS or Linux

Download the repository ZIP and extract it, or clone the repository. Both versions below open in your desktop browser. [Download Graltitude](https://github.com/nabudahab/Graltitude/archive/refs/heads/main.zip)

**To try your rides with zero setup**, double-click **Graltitude.html** in the top folder.

1. On the Strava website, open one of your own outdoor power-meter rides. Choose **… → Export GPX**. Repeat for a few rides on the same bike. Strava includes recorded power in its GPX export. [Strava export instructions](https://support.strava.com/en-us/articles/15401919-how-do-i-export-my-strava-data)
2. In Ride Lab, enter the bike name and choose the ride files together. Mark group rides when importing them. Use a different bike name when importing rides for another bike.
3. Enter your combined rider, bike and kit mass under **Bike setup**. Review the flagged rides and check the efforts you want to use. **Flat-ground power** shows the fitted predictions. To estimate a segment time, import a segment GPX with elevation and type your target watts.

The portable file uses whole rides from GPX and runs the fit on your laptop. With an internet connection it can also look up weather. Offline rides are marked **Weather unknown** so you can decide whether to include them. Reopen your ride files after closing the app.

**To sync directly with Strava**, open **Strava for Windows.cmd**, **Strava for Mac.command** or **Strava for Linux.sh** from the extracted folder. Linux file managers may call this **Run as a Program**. The launcher opens Ride Lab in your browser. The first launch downloads a verified runtime if one is needed. Keep the launcher window open while using the app.

Click **Connect with Strava**. The first time, the app walks you through entering your own Strava Client ID and Client Secret and setting the callback domain to `127.0.0.1`. Strava requires a subscription to create an API application. Use **Strava settings** at the foot of the app to update these credentials. The app stores them in your user folder and keeps ride sessions in memory until you close the launcher. The sync imports your bike assignments, recorded laps and starred segments. [Strava API settings](https://www.strava.com/settings/api) · [Strava developer guide](https://developers.strava.com/docs/getting-started/)

## Run the development version

Use Node 24 and npm.

```sh
npm ci
npm run dev
```

Open the local URL Vite prints. Use the ride title to review its laps or whole-ride effort. Enter the combined mass of rider, bike and kit for each bike. The model uses the default rolling resistance only when it cannot estimate it from the selected rides. Flat-ground power is available as soon as a bike has a fitted model. To predict a segment time, import a GPX with elevation in the prediction panel or segment planner. With Strava connected, you can also paste a segment URL or ID or choose a starred cycling segment. The planner uses the imported distance, grade and heading for every selected bike, including on segments the rider has never ridden. Each imported segment starts in still air. Choose a departure time and select **Use forecast** to apply local weather.

```sh
npm test
npm run build
```

To regenerate the checked-in portable file after changing the app, run `npm run build:portable`.

## Run live Strava sync with the development tools

Graltitude runs the web app, API and session database on your computer. The browser runs the physics model. You need an internet connection for Strava and weather data.

1. Install Node.js 24, download and extract the Graltitude source, and open a terminal in the folder containing `package.json`. [Node.js downloads](https://nodejs.org/en/download)
2. Sign in to Strava and open **My API Application**. Use your own app or register one. Set **Authorization Callback Domain** to `127.0.0.1`. Strava requires a subscription to create an API app. Its initial single-athlete capacity is enough to test your own rides. [Strava API settings](https://www.strava.com/settings/api) · [Strava developer guide](https://developers.strava.com/docs/getting-started/)
3. Run these two commands.

   ```sh
   npm ci
   npm run ride-lab
   ```

4. On first run the launcher creates `apps/api/.dev.vars` with a local encryption key and prints its full path. Open the file in a text editor, paste your own **Client ID** and **Client Secret** into the matching lines, save, and run `npm run ride-lab` again. Keep this file on your laptop.
5. When Wrangler says **Ready**, open **http://127.0.0.1:4176/** in a browser on the same computer, select **Connect with Strava** and authorize activity access. Keep the terminal open while testing. Ctrl+C stops the app. Run `npm run ride-lab` to start it again.

**A first test with real rides**

Pick one bike and enter the combined mass of you, the bike and your kit. Open a few solo outdoor rides from the last 90 days that recorded power, choose **Analyze ride**, and keep the laps or whole rides you trust checked. Look at **Flat-ground power** and **Calibration and accuracy** for that bike.

To test a prediction, leave one separate ride unchecked. Choose a steady climb from that ride on a calm day, paste its Strava segment URL under **Import segment**, and enter your recorded average watts for that segment. Compare the prediction in still air with your actual segment time. To share feedback, send the segment watts, predicted time and actual time.

## Deploy the web app

When you're ready to publish, select **Settings → Pages → Source → GitHub Actions**, then **Actions → Deploy Graltitude to Pages → Run workflow**. This manual workflow tests, builds, and publishes the app.

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

Sync lists the last 90 days in pages of 50 activities. Open a ride and choose **Analyze ride**, or analyze the selected bikes together. Ride lists refresh on demand. Calibration uses the recorded Strava laps, or one whole-ride effort when there are no laps. Stops and long recording gaps are omitted and the effort shows how much time was modeled. Group participation, power variability, acceleration, gusts, and wet surfaces flag efforts for review. Missing measured power prevents powered calibration. Missing weather is flagged and defaults to still air only if the rider includes the effort. Weather requests use rounded coordinates and UTC times. Per-rider preferences and choices stay in the current browser. An effort overlapping a previously excluded interval stays deselected until the rider includes it. Stream data, model fits, and loaded routes live in memory.

The TypeScript engine under `packages/physics` runs inside a browser Web Worker. Each bike model uses every selected effort assigned to that bike, weighted by duration. The engine sums aerodynamic, rolling, climbing and kinetic work over the recorded samples. It uses the mass you entered and assumes 97.5% crank-to-wheel efficiency. When the data cannot separate rolling resistance from drag, the engine uses the bike's default Crr. An implausible CdA makes the model unavailable. To measure error, the engine temporarily leaves out each ride, fits the other rides and predicts the omitted ride's watts. The accuracy count includes each ride it could check this way. It also compares predicted and observed times on qualifying steady climbs.

Segment simulation uses quasi-steady speeds over distance, a 60 km/h descent ceiling, and a forecast sampled near the start, middle and end at departure time. It suits uninterrupted climbs. Displayed time ranges measure sensitivity to the average **power** error from the ride checks. Probabilistic prediction intervals, stopwatch validation on real climbs, automatic mass fitting, and corner/braking dynamics need further work.

[Strava API documentation](https://developers.strava.com/docs/) · [Strava API Policy](https://www.strava.com/legal/api_policy) · [Open-Meteo historical weather forecasts](https://open-meteo.com/en/docs/historical-forecast-api) · [Open-Meteo forecasts](https://open-meteo.com/en/docs)
