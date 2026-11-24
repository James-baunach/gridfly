# GridFly

A free, open-source planner for photo-mapping missions flown with **DJI Fly** waypoints (Mavic 3 family, and other DJI Fly drones that support waypoints).
Draw an area, get a lawnmower grid with a photo at every point, adjust the heights for terrain, and install the mission straight onto the remote controller.

## Features

- **Easy mode (default)**: a guided 7-step flow: your drone and controller, where, what you are mapping, quality, site check, get it on your drone, after the flight. The plan is generated automatically as you change things. **Advanced** mode shows every setting at once.
- **Goal presets**: land / field (2D), buildings and 3D models (crossing passes, optional angled passes for walls), single-building orbit, and road / river / fence-line corridors.
- **Quality slider** with eight steps, from *Quickest* (120 m / 394 ft, the fewest photos a map still stitches from) to *Most detail* (35 m). Each step sets height and overlap and says in plain words how fine the detail will be, how many photos, batteries and how long it takes. *Lots of trees or crops* adds 5% overlap so vegetation stitches cleanly. The edge margin and speed are set for you: **automatic speed** is the fastest (up to 12 m/s) that keeps blur under half a pixel at 1/1000 s and photos at least 2.5 s apart.
- **Split by signal range**: areas too big to fly from one spot are cut into overlapping zones lined up with the flight lines, each with a suggested launch point (L1, L2… on the map) so the drone never goes farther than your *max distance from launch point* (default 2000 ft). Drag a launch point to somewhere you can reach; heights are worked out from each launch point, mission file names end in theirs (`-3of8-L2.kmz`), and GridFly warns if any mission goes out of range.
- **Clean turns**: flight-line ends are always exported as *stop* points, even when the path style flies through points, so DJI Fly does not round the corners. With *Keep facing one way* (on by default) the drone flies the return lines backwards instead of spinning round at each line end, so no photos are taken mid-yaw.
- **Plan to a target**: in step 4 type the ground detail you need (cm per pixel, or inches per pixel in feet mode) and GridFly sets the flying height for your camera, or type how many batteries you have and it finds the lowest height (finest detail) whose plan, split into real missions, fits. It says so when a limit is hit or when even the highest flight does not fit. Both just set the height, so the slider shows Custom.
- **One unit switch**: m / ft governs everything shown. Feet mode uses ft, acres, mph (speed boxes, per-waypoint speed, wind in the site check), inches per pixel and the checklist text. Values are stored in metric.
- **Motion blur check**: when photos are taken on the move (fly through points, or timer photos) GridFly works out the shutter that keeps blur under about one pixel, shows it in the checklist (never slower than 1/1000 s) and warns, with a slower speed to use, when it would need to be faster than 1/2000 s.
- **Draw the area** as a polygon, rectangle or circle, import a KML/KMZ from Google Earth, search for a place or use your location.
- **Several areas and keep-out zones** (grid and 3D goals): in step 2, *Add another area* maps more than one area in a project. They are flown one after another, the one nearest your takeoff point first, then the nearest to where the drone ended; missions are still split by waypoint count and battery time across the whole thing. *Add keep-out zone* draws a red dashed shape (pond, neighbour's lot, tower) the drone must not fly over. Flight lines are cut 3 m short of it, and the drone flies round the outline to reach the next piece (including between crosshatch passes, angled passes and between areas); those transit waypoints take no photo. Each shape can be dragged, corners added (small circles) or removed (tap a corner), and a whole shape removed with its label. A keep-out is flat on the map, not a height limit, and the takeoff and Return to Home legs are not planned around it: GridFly warns if the takeoff point or the straight line from it to a mission's first (or last) waypoint crosses one. Areas that overlap are flown twice. With timer photos the camera also shoots while the drone detours round a keep-out. Old projects open as before; project files, KML and GeoJSON include the extra areas and keep-outs.
- **Timer photos**: for big areas GridFly can use DJI Fly's Timed Shot instead of a photo action at every waypoint, and tells you the interval to set.
- **Site check**: weather and best flying windows (Open-Meteo), light, FAA airspace ceilings (US) and nearby obstacles (OpenStreetMap), drawn on the map with warnings when something reaches your flight height.
  - 7-day forecast: today and tomorrow in detail, one line of best windows for each later day.
  - Geomagnetic activity (NOAA Kp index): current and next 24 hours in plain words; Kp 5 or more makes an hour a caution and 7 or more makes it bad, because storms can disturb GPS and the compass.
  - Airspace: when the FAA grid shows any controlled airspace, or a ceiling under your flight height, GridFly says you need authorisation (LAANC) and how to get it. Flags US National Park Service land (OpenStreetMap), where drone launches are prohibited. Temporary flight restrictions (TFRs) are only a link to the FAA's TFR site: the FAA's TFR services send no CORS headers, so a browser app cannot read them.
  - Forecast, Kp, airspace and park results are saved with *Save for offline* and shown with their age when there is no signal.
- **Controller-specific install**: automatic USB install with backup and restore for DJI RC 2 / RC Pro and RC-N phones (Windows helper), a microSD package for the standard DJI RC, and Files-app steps for iPhone. A pre-flight checklist worked out for your mission can be printed or copied.
- **After the flight**: drop the photos in to find blurry shots and coverage gaps, see a coverage overlay on the map and re-fly just the gaps.
- **Open DJI .KMZ files** saved by DJI Fly on your controller. Edit them and save them back. The file's own drone settings are kept.
- **Terrain following**: waypoint heights are adjusted so the drone keeps a constant height above the ground. Heights are relative to the takeoff point, which is how DJI Fly stores them. Extra waypoints are added where a ridge rises between two points. A height profile is shown. Ground data is chosen automatically: Kentucky LiDAR, then USGS 3DEP, then worldwide data.
- **Tree and building warning (Kentucky)**: where the state's first-return surface model exists, GridFly checks the route (waypoints and the lines between them) against the tops of trees and buildings. It warns when the drone would pass less than 15 m above them, and says it will hit them under 5 m. The surface is drawn in green on the height profile.
- **Flight direction**: Auto (fewest flight lines), North-South, East-West or any bearing. The start corner is picked to be nearest your takeoff point.
- **Straighten flight paths**; the Curved option is switched off while waypoints take photos, because DJI Fly ignores photo actions on curved paths.
- **Extra sharp photos** option (pause 1 s at each photo), metres or feet (with acres and mph), "?" help on every setting.
- **Projects**: your work is autosaved in the browser and restored on the next visit; save or open `.gridfly.json` project files; export KMZ, microSD package, KML (Google Earth) or GeoJSON.
- Missions are split automatically by waypoint count (up to 400, default 200) and by battery time.
- Edit single waypoints (drag, delete, insert, height, speed, photo on/off), with undo and redo (Ctrl+Z, Ctrl+Y).
- **Works offline as an installable app (PWA)** on phones, tablets and laptops: save an area's satellite maps, ground heights and site check before you leave, then plan and adjust missions in the field with no signal.

## Use it in the field (offline app)

GridFly is a Progressive Web App. Once it is hosted on an **https** address (GitHub Pages works, see below), open that address on each device and install it:

- **Android (Chrome):** menu ⋮ → *Install app* (or *Add to Home screen*).
- **iPhone / iPad (Safari):** Share → *Add to Home Screen*. Exports open the share sheet, so you can *Save to Files*.
- **Laptop (Chrome / Edge):** the install icon in the address bar. The installed app can also open `.kmz`, `.kml` and `.gridfly.json` files.

The app itself then opens with no signal. Before you head out, while you still have signal:

1. Draw your area (or zoom the map to the site).
2. Tap **Offline** → **Save for offline**. GridFly saves satellite imagery around the area (plus a wider overview for finding your way), the ground heights for terrain following, and the site check (weather forecast, obstacles, airspace).
3. In the field you can draw, plan, follow the ground, check photos and export missions. With no signal the site check shows the saved results and how old they are. A saved area can be found again by typing its name in the search box. GPS (*Use my location*) works without signal.

Notes:
- Place search and fresh forecasts need a connection. Map tiles you have looked at are also kept (the newest 3,000), and zooming past the saved detail enlarges the saved imagery.
- Saved maps use the device's browser storage. The Offline panel shows how much is used and lets you delete saved areas. GridFly asks the browser to keep the data, but a phone that runs very low on space may still clear it.
- Satellite imagery comes from Esri World Imagery. Check that its terms suit your use before you save large areas. Street map tiles from OpenStreetMap are only kept as you view them, never bulk-downloaded, as their tile policy requires.

### Hosting on GitHub Pages

`.github/workflows/pages.yml` runs the tests and publishes `web/` on every push to `main`. One-time setup: in the repository on GitHub, go to **Settings → Pages → Source** and pick **GitHub Actions**. The app is then at `https://<user>.github.io/gridfly/`.

When you change any file in `web/`, bump `VERSION` in `web/sw.js` so installed apps pick up the new version. They show a "new version is ready" note. If you add a file, also list it in `SHELL` there; `npm test` checks the list is complete.

## Running it locally

You need [Python 3](https://www.python.org/downloads/) installed. It uses no extra packages.

- **Windows:** double-click `start.bat`.
- **Any OS:** run `python server.py`, which opens <http://localhost:8765>.

The `web/` folder is also a plain static site. You can host it anywhere (e.g. GitHub Pages) and use it without the helper. Without the helper, you download the KMZ files and copy them to the controller yourself.

## Getting a mission onto the drone

DJI Fly can't import files, so the usual trick is to overwrite a placeholder mission:

1. In DJI Fly, create a waypoint mission with a couple of points and save it. Make one placeholder for each mission GridFly splits your survey into.
2. Close DJI Fly, then connect the controller to your PC by USB. With an RC-N1/RC-N2, connect the phone instead and choose *File transfer*.
3. In GridFly, click **Scan for controller**. Choose which placeholder each mission should replace (the newest ones are picked for you), then click **Install**.
   The original files are saved in `backups/`. After copying, the helper reads the file back from the controller and compares its SHA-256, and GridFly shows whether it was verified.
4. Reopen DJI Fly, open the mission, and check the route, heights and actions before you fly.

Manual install: missions live at `Android/data/dji.go.v5/files/waypoint/<ID>/<ID>.kmz`. Copy your KMZ there and rename it to `<ID>.kmz`, replacing the placeholder.

### Backups and restore

Every install saves the file it replaced in `backups/<date>-<time>-<id>/` (next to `server.py`, or next to `GridFly.exe`). `GET /api/backups` lists them and `POST /api/restore` puts one back onto a placeholder (also verified, and the file being replaced is backed up first).

### Experimental: create a new mission slot

`POST /api/create` makes a new mission folder (`waypoint/<new UUID>/`, same upper/lower case as the template mission) on the controller and copies the KMZ into it, so no placeholder is needed. **This is untested on a real controller.** MTP may refuse to create folders, and DJI Fly may not list a mission it did not create (it might keep its own database). `/api/status` reports `experimentalCreate: true`. If DJI Fly does not show the mission, delete the new folder and use placeholders.

### Single-file Windows build

Run `build_exe.bat` (needs Python and internet once). It creates `.build-venv`, installs PyInstaller and builds `dist\GridFly.exe`, which bundles `web/` and `installer/`. Run it like `start.bat`; `backups/` is created next to the exe. Leaflet and JSZip are vendored in `web/vendor/`, so the app itself works offline (map tiles and elevation still need internet).

## Tips for good maps

- 70–80% front overlap and 60–70% side overlap work for most terrain. Use more for forests and crops.
- *Fly through points, stop at line ends* (default) is fastest; set the camera to 1/1000 s or faster (Pro mode) so photos on the move stay sharp. *Stop at each point* is slower but sharp at any shutter speed. Keep photos at least ~2 s apart (GridFly warns you).
- Put the **H** marker where you will actually take off before applying terrain heights. Every height is measured from there.
- The elevation data (Copernicus DEM, ~30–90 m) does not include trees or buildings, so leave plenty of margin.
- **In Kentucky** GridFly uses the state's KyFromAbove LiDAR ground model (2 ft) instead, whenever it covers the whole mission and the takeoff point. It is far more accurate (on a test site at Frankfort the worldwide data put the drone up to 34 m off its planned height), and *Save for offline* keeps it on the device. It is bare earth: trees and buildings are not in it, so your height above ground must still clear the canopy. A mission that crosses the state line, or runs when the state service is down, uses **USGS 3DEP** (bare earth, detail from about 1 m to 10 m, sampled at about 5 m) for all of it, and only if that fails the worldwide data. Heights never mix two sources. For now 3DEP is used in Kentucky only.
- **Trees and buildings:** in Kentucky GridFly also reads the state's first-return surface model and warns when the planned height is too close to treetops or rooftops. It is sampled about every 3 m across and 5 m along the route, so a thin pole or a single branch can be missed. Outside Kentucky there is no such check and the elevation data has no trees or buildings, so leave plenty of margin.
- Fly split missions from the same takeoff point, or, for a plan split by signal range, from the launch point in each file name.

## How it works

| File | Purpose |
| --- | --- |
| `web/js/wpml.js` | Reads and writes DJI WPML (`wpmz/template.kml` + `wpmz/waylines.wpml`). When editing a DJI Fly file, its first waypoint is cloned as the template for every new one, so fields that depend on the firmware are kept. |
| `web/js/grid.js` | Camera footprint/GSD maths, grid generation, path straightening |
| `web/js/avoid.js` | Keep-out zones: cutting flight lines, shortest route round polygons, path checks, net area |
| `web/js/targets.js`, `web/js/blur.js` | Pure maths for detail and battery targets, and for motion blur and the shutter to use |
| `web/js/terrain.js` | Chooses the ground source (Kentucky LiDAR, then 3DEP, then worldwide) and the clearance check. Worldwide: [Open-Meteo](https://open-meteo.com/en/docs/elevation-api) elevation, sampled on a ~40 m lattice and interpolated |
| `web/js/lidar-ky.js` | Kentucky LiDAR ([KyFromAbove](https://kyfromabove.ky.gov/)) tiles: fetched from the state's elevation image service, kept on the device and sampled locally |
| `web/js/dem-3dep.js` | USGS 3DEP ([National Map elevation service](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer)) tiles, stored and sampled like the Kentucky ones. `covers3dep()` is the one place that decides where 3DEP is used |
| `web/js/dsm-ky.js` | Kentucky first-return surface model (KyFromAbove DSM): tile decoding and the clearance check / warning wording |
| `web/js/app.js` | Map UI (Leaflet) |
| `web/sw.js` | Service worker: keeps the app and map tiles available offline |
| `web/js/offline.js`, `web/js/ui-offline.js`, `web/js/store.js` | Tile maths, the Offline panel (saving areas, install, updates) and the IndexedDB store for saved elevations and site checks |
| `server.py` | Local helper that serves the app and runs the installer (install, verify, backups/restore, experimental create). It only listens on 127.0.0.1 and requires a custom header, so other websites can't drive it. |
| `installer/mtp.ps1` | Copies files to and from the controller over MTP through the Windows Shell |

## Disclaimer

GridFly is not affiliated with DJI. Always check missions on the controller before you fly, keep the drone in visual line of sight, and follow your local regulations. You use it at your own risk.

## License

MIT — see [LICENSE](LICENSE).
