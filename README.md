# GridFly

A free, open-source planner for photo-mapping missions flown with **DJI Fly** waypoints (Mavic 3 family, and other DJI Fly drones that support waypoints).
Draw an area, get a lawnmower grid with a photo at every point, adjust the heights for terrain, and install the mission straight onto the remote controller.

## Features

- **Easy mode (default)**: a guided 7-step flow: your drone and controller, where, what you are mapping, quality, site check, get it on your drone, after the flight. The plan is generated automatically as you change things. **Advanced** mode shows every setting at once.
- **Goal presets**: land / field (2D), buildings and 3D models (crossing passes, optional angled passes for walls), single-building orbit, and road / river / fence-line corridors.
- **Quality slider** (Fast / Balanced / Detailed) that sets height and overlap and says in plain words how fine the detail will be, how many photos, batteries and how long it takes. The edge margin is added for you.
- **Draw the area** as a polygon, rectangle or circle, import a KML/KMZ from Google Earth, search for a place or use your location.
- **Timer photos**: for big areas GridFly can use DJI Fly's Timed Shot instead of a photo action at every waypoint, and tells you the interval to set.
- **Site check**: weather and best flying windows (Open-Meteo), light, FAA airspace ceilings (US) and nearby obstacles (OpenStreetMap), drawn on the map with warnings when something reaches your flight height.
- **Controller-specific install**: automatic USB install with backup and restore for DJI RC 2 / RC Pro and RC-N phones (Windows helper), a microSD package for the standard DJI RC, and Files-app steps for iPhone. A pre-flight checklist worked out for your mission can be printed or copied.
- **After the flight**: drop the photos in to find blurry shots and coverage gaps, see a coverage overlay on the map and re-fly just the gaps.
- **Open DJI .KMZ files** saved by DJI Fly on your controller. Edit them and save them back. The file's own drone settings are kept.
- **Terrain following**: waypoint heights are adjusted so the drone keeps a constant height above the ground. Heights are relative to the takeoff point, which is how DJI Fly stores them. Extra waypoints are added where a ridge rises between two points. A height profile is shown.
- **Flight direction**: Auto (fewest flight lines), North-South, East-West or any bearing. The start corner is picked to be nearest your takeoff point.
- **Straighten flight paths**; the Curved option is switched off while waypoints take photos, because DJI Fly ignores photo actions on curved paths.
- **Extra sharp photos** option (pause 1 s at each photo), metres or feet, "?" help on every setting.
- **Projects**: your work is autosaved in the browser and restored on the next visit; save or open `.gridfly.json` project files; export KMZ, microSD package, KML (Google Earth) or GeoJSON.
- Missions are split automatically by waypoint count (up to 400, default 200) and by battery time.
- Edit single waypoints (drag, delete, insert, height, speed, photo on/off), with undo and redo (Ctrl+Z, Ctrl+Y).

## Running it

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
- *Straight lines, stop at each point* gives the sharpest photos. *Fly through points* is faster, but keep photos at least ~2 s apart (GridFly warns you).
- Put the **H** marker where you will actually take off before applying terrain heights. Every height is measured from there.
- The elevation data (Copernicus DEM, ~30–90 m) does not include trees or buildings, so leave plenty of margin.
- Fly split missions from the same takeoff point.

## How it works

| File | Purpose |
| --- | --- |
| `web/js/wpml.js` | Reads and writes DJI WPML (`wpmz/template.kml` + `wpmz/waylines.wpml`). When editing a DJI Fly file, its first waypoint is cloned as the template for every new one, so fields that depend on the firmware are kept. |
| `web/js/grid.js` | Camera footprint/GSD maths, grid generation, path straightening |
| `web/js/terrain.js` | Elevation from the [Open-Meteo](https://open-meteo.com/en/docs/elevation-api) API, sampled on a ~40 m lattice and interpolated |
| `web/js/app.js` | Map UI (Leaflet) |
| `server.py` | Local helper that serves the app and runs the installer (install, verify, backups/restore, experimental create). It only listens on 127.0.0.1 and requires a custom header, so other websites can't drive it. |
| `installer/mtp.ps1` | Copies files to and from the controller over MTP through the Windows Shell |

## Disclaimer

GridFly is not affiliated with DJI. Always check missions on the controller before you fly, keep the drone in visual line of sight, and follow your local regulations. You use it at your own risk.

## License

MIT — see [LICENSE](LICENSE).
