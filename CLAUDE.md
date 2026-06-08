# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Weather Prime is a GNOME Shell extension (GNOME 50+) written in GJS (GNOME JavaScript). There is no build step — files are loaded directly by GNOME Shell. No npm, no bundler, no transpiler.

## Installation / Development Workflow

```bash
# Install extension files
mkdir -p ~/.local/share/gnome-shell/extensions/weather-prime@weather-prime
cp extension.js stylesheet.css prefs.js \
   ~/.local/share/gnome-shell/extensions/weather-prime@weather-prime/
cp -r schemas icons ~/.local/share/gnome-shell/extensions/weather-prime@weather-prime/

# Compile GSettings schema (required after any schema changes)
glib-compile-schemas ~/.local/share/gnome-shell/extensions/weather-prime@weather-prime/schemas/

# Enable
gnome-extensions enable weather-prime@weather-prime
```

To reload after code changes:

- **Wayland:** the disable/enable cycle does **not** reliably reload extension code. The user must log out and log back in for changes to take effect. Ask them to do this — do not attempt to restart the shell yourself.
  ```bash
  # Will not pick up code changes on Wayland; included only for completeness.
  gnome-extensions disable weather-prime@weather-prime && gnome-extensions enable weather-prime@weather-prime
  ```
- **X11:** `Alt+F2` → type `r` → Enter restarts the shell in-place.

View extension logs:
```bash
journalctl -f -o cat /usr/bin/gnome-shell 2>&1 | grep -i weather
```

## Architecture

### Files

| File | Purpose |
|------|---------|
| `extension.js` | Extension entry point + all runtime UI and data-fetching logic |
| `prefs.js` | Preferences window (runs in a separate process from the shell) |
| `stylesheet.css` | All CSS for the drop-down panel; dark mode is default, light mode via `.wp-light` class |
| `schemas/org.gnome.shell.extensions.weather-prime.gschema.xml` | GSettings schema — must be recompiled after changes |
| `icons/` | Bundled [Meteocons](https://github.com/basmilius/weather-icons) static-fill weather SVGs (one per condition, day/night variants), rendered as colour `St.Icon`s. `icons/LICENSE.meteocons` is the MIT license that must ship with them (attribution requirement) |

### Class Structure (`extension.js`)

```
WeatherPrimeExtension          ← ES module default export; enable()/disable() lifecycle
  └── WeatherIndicator         ← GObject.registerClass, extends PanelMenu.Button
        ├── _fetch()           ← coordinates location → weather + AQ + astro + map + alerts → parse → render
        ├── _resolveLocation() ← GeoClue2 auto or reads manual lat/lon from GSettings
        └── WeatherPanel       ← plain JS class, owns all drop-down UI
              └── tabs: current / hourly / daily / airquality / astronomy / map
                        (astronomy hidden only if no source supplies any astro data;
                         sun times come from the active weather provider, moon detail
                         from WeatherAPI or a WeatherAI.io key, solar noon + next
                         new/full moon dates from USNO (keyless); optional tide
                         line from WeatherAPI.com Marine or NOAA, hidden inland;
                         map hidden if RainViewer tile fetch failed)
```

**`WeatherIndicator`** is the top-bar pill button. It owns:
- Three independent cache TTLs:
  - `_cachedParsed`/`_lastFetch` — weather payload (`fetch-interval`)
  - `_cachedAq`/`_lastAqFetch` — air quality (`aq-fetch-interval`)
  - `_cachedMap`/`_lastMapFetch` — RainViewer radar tiles (`map-fetch-interval`, 10 min floor)
- `_cachedUsno`/`_lastUsnoDay` — USNO astronomy on its own **once-per-calendar-day** cadence (not a TTL, not configurable; gated by `usnoDayKey()`). A manual refresh (`force`) bypasses the day gate; the `_busy` guard still blocks overlapping fetches. A failed fetch leaves the cache untouched so the next `_fetch` retries instead of waiting out the day.
- `_cachedLat`/`_cachedLon` — last resolved coords; if these change between `_fetch()` runs, **all caches (including USNO, since solar noon is location-specific) are invalidated** so a GeoClue move doesn't serve stale data for the old location.
- A `GLib.timeout_add_seconds` periodic refresh timer whose period is `min(weather, aq, map)`
- GSettings `changed` signal to invalidate cache and re-fetch on any preference change

**`WeatherPanel`** is a plain JS class (not GObject). It receives parsed data via `setData()` and re-renders the active tab. Its `destroy()` must be called explicitly when `WeatherIndicator` is destroyed.

### Data Flow

```
_fetch(force)
  → _resolveLocation()                        (GeoClue2 or manual coords from GSettings)
  → if location moved since last fetch, drop all caches
  → if not fresh: fetch air quality (AirNow → OpenWeatherMap → Open-Meteo, per aq-source)
  → if not fresh: fetch RainViewer radar frames (past + nowcast) over an Esri World Imagery base; the Map tab loops them
  → if USNO stale (new calendar day, or force): kick off fetchUsnoAstronomy() in parallel  // keyless; own daily cadence, not the weather TTL
  → if weather not fresh: Promise.all([
        fetchJSON(buildAirQualityUrl()),       // PM2.5/PM10 backfill
        fetchAlerts(),                          // NWS, US only
        fetchWeatherAi('/astronomy', …),        // only if weatherai-key set; overlays moon detail
        fetchJSON(buildOpenMeteoPrecip24hUrl()), // last-24h precip series+total, keyless, both providers
        fetchTides(tide-source, …),             // only if tide-source != off; WeatherAPI.com Marine or NOAA CO-OPS
        fetchNwsNarrative(),                     // NWS plain-language daily narrative, US only, keyless (null elsewhere)
     ])
     then fetchJSON(buildOpenMeteoUrl()) OR fetchWeatherAPI()
     then parseOpenMeteo() / parseWeatherAPI()   // each emits astronomy (sun times always; moon from WeatherAPI)
     then if NWS narrative present, overwrite each daily[].desc (keyed by date) // US only; provider short label stands elsewhere
     then merge WeatherAI overlay
  → await the USNO fetch and merge it (additive: solarNoon, nextNewMoon, nextFullMoon) into
     parsed.astronomy — runs on both the fresh and rebuilt paths, since USNO has its own schedule
  → WeatherPanel.setData({ current, hourly, daily, airquality, astronomy?, map?, alerts })
```

Parsed data shape:
```js
{
  current:    { temp, feelsLike, humidity, wind, pressure, icon, desc,
                windGust?, dewPoint?, visibility?, cloudCover?,
                precip24h?, precip24hSeries?,
                precip24hImperial?, snow24h?, snow24hSeries? },
                                 // last-24h precip, always from Open-Meteo (keyless). precip24h is the
                                 // formatted liquid-equivalent total "X in"/"X mm" (0 shown, null hides the block);
                                 // precip24hSeries is the raw per-hour max-across-models liquid-equiv array
                                 // (oldest→newest, same unit) the Current tab draws as a sparkline.
                                 // snow24h is the formatted snow-DEPTH total "X in"/"X cm" (null = no
                                 // measurable snow / no line; note metric snow is cm while precip is mm),
                                 // snow24hSeries the aligned per-hour snow-depth array (used to tint snow
                                 // hours in the sparkline); precip24hImperial flags inch vs mm for bar labels
  hourly:     [{ time, temp, icon, precip, humidity, wind }, ...],   // next 12 hours
  daily:      [{ day, date, hi, lo, icon, precip, humidity, wind, desc }, ...], // 7 days.
                                 // date is 'YYYY-MM-DD' (keys the NWS narrative merge; not displayed).
                                 // desc is the per-day description shown under each row: the provider's
                                 // short WMO/condition label, replaced by the richer NWS plain-language
                                 // narrative for US locations (see fetchNwsNarrative).
  airquality: {
    airnow:      {...} | null,   // US EPA AQI by pollutant when key + nearby station
    openweather: {...} | null,   // global 1–5 AQI + 8 pollutant concentrations
    pm25, pm10,                   // Open-Meteo fallback, always present
  },
  astronomy:  { sunrise, sunset, moonrise, moonset, moonPhase, moonIllumination,
                solarNoon, nextNewMoon, nextFullMoon, tides? }, // any field may be null; tab hidden if all sun/moon time/phase fields are.
                                                        // solarNoon + next moon dates come from USNO (keyless); the latter two are "Mon D" date strings.
                                                        // tides is an opt-in array of today's high/low events ([{time:'3:45a', type:'H'|'L'}, …]),
                                                        // rendered as detail-grid cells on the Astronomy tab (which grows its scroll height when present);
                                                        // null when the tide source is off or the location is inland (see tide-source)
  
  map:        { cells, frames: [{ path, time, kind }], zoom } | undefined,
              // frames are radar tiles oldest→newest (past then nowcast);
              // WeatherPanel loops them, holding on the most recent
  alerts:     [{ event, headline, desc, severity }],
}
```

### Key Technical Details

- **GJS imports** use `gi://` URIs (`gi://GObject`, `gi://St`, `gi://Soup`, etc.). GNOME Shell internal APIs use `resource:///org/gnome/shell/…`.
- **`URLSearchParams` polyfill** — GJS does not have this web API, so both `extension.js` and `prefs.js` define a minimal shim at the top of the file.
- **Signal management** — Every `connect()` call returns a signal ID that must be stored and passed to `disconnect()` in `destroy()`. Leaking signals causes memory leaks and can crash the shell.
- **Weather icons** — Sky-condition glyphs are Meteocons static-fill SVGs bundled in `icons/`, **not emoji**. `WMO[code]`/`wApiIcon()` emit a Meteocons *slug* (a file basename); `weatherIcon(slug, cssClass)` builds a colour `St.Icon` via `Gio.FileIcon`, and `iconGicon(slug)` swaps the top-bar pill icon in place (`set_gicon`). Size is driven by the CSS **`icon-size`** property (with `wp-medium`/`wp-large` overrides), not `font-size`. `ICON_DIR` is set once in `enable()` from the install path. Meteocons ships day/night art for sky-dominant codes (clear, clouds, fog, showers), so `WMO` entries carry `{day, night}` for those and there is no separate night-override table. Unknown codes fall back to `not-available`. Decorative inline emoji elsewhere (💧 hourly precip, ❄️ snowfall label, ⚠️ error/alert) are not weather icons and are untouched.
- **CSS class prefix** — All stylesheet classes use the `wp-` prefix (e.g., `.wp-panel`, `.wp-tab`).
- **Light mode** — Applied by toggling the `wp-light` CSS class on `.wp-panel`; all light-mode rules are `.wp-panel.wp-light` descendant selectors.
- **Pressure trend** — Compares `surface_pressure` now vs. 3 hours ago; threshold 2 hPa triggers ↑/↓ arrows.
- **`prefs.js` runs in a separate process** — It cannot import from `extension.js` and has no access to shell internals. It uses `Adw`/`Gtk` instead of `St`/`Clutter`.

### GSettings Keys

Defined in `schemas/org.gnome.shell.extensions.weather-prime.gschema.xml`. Key ones:

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `api-provider` | string | `open-meteo` | `open-meteo` or `weatherapi` |
| `weatherapi-key` | string | `''` | Required when provider is `weatherapi` |
| `weatherai-key` | string | `''` | Optional astronomy overlay. The Astronomy tab works without it (sun times from the active provider, moon detail from WeatherAPI); when set, WeatherAI.io values take precedence and add moon data Open-Meteo lacks. Astronomy-only role — forecast still comes from `api-provider` |
| `airnow-api-key` | string | `''` | US AirNow; per-pollutant AQI when a station is within ~25 mi |
| `openweather-api-key` | string | `''` | OpenWeatherMap Air Pollution; global 1–5 AQI + 8 pollutant concentrations |
| `aq-source` | string | `auto` | `auto` (AirNow → OpenWeatherMap → Open-Meteo), `airnow`, `openweather`, `open-meteo` |
| `tide-source` | string | `off` | `off`, `weatherapi` (global, reuses `weatherapi-key`), or `noaa` (US only, keyless). Adds the Astronomy-tab tide line; hidden when off or inland |
| `location-auto` | bool | `true` | Uses GeoClue2 when true |
| `location-latitude/longitude` | double | `0.0` | Used for manual location; also cached from GeoClue2 |
| `location-name` | string | `''` | Display name; cached from Nominatim or chosen from prefs city search |
| `fetch-interval` | int | `1440` | Weather refresh in minutes |
| `aq-fetch-interval` | int | `60` | Air quality refresh in minutes |
| `map-fetch-interval` | int | `10` | Radar overlay refresh in minutes (10 is the floor — RainViewer's publish cadence) |
| `color-scheme` | string | `auto` | `auto`, `dark`, or `light` |
| `panel-position` | string | `right` | `left`, `center`, or `right` |
| `panel-size` | string | `original` | `original`, `medium` (1.25×), or `large` (1.5× drop-down content) |
| `map-website` | string | `windy` | Which external site the Map tab opens on click: `windy`, `zoom-earth`, `ventusky`, `rainviewer`, `weather-com`, `wunderground`, `nws` |

After editing the schema XML, always recompile: `glib-compile-schemas <path>/schemas/`.

## External APIs

| API | Key needed | Used for |
|-----|-----------|---------|
| Open-Meteo (`api.open-meteo.com`) | No | Weather forecast (default provider); also backfills the 7-day dominant wind direction when the selected provider lacks it (WeatherAPI's daily forecast has no wind direction), and always supplies the Current tab's last-24h precipitation (a dedicated `past_hours=24` request, since neither provider's main response carries a prior-day precip sum). This request asks for multiple models (`ecmwf_ifs025,icon_seamless,gfs_seamless`) and `precip24hSeries` takes the per-hour max across them (the displayed total is that series summed; the series itself is drawn as the Current tab's sparkline), because the default `best_match` (GFS in the US) routinely reports 0 for convective rain that ECMWF/ICON captured. The same call also pulls `snowfall` (max-across-models), so the Current tab can break out a snow-depth total and tint snow hours in the sparkline — `precipitation` is liquid-water equivalent and would otherwise hide that it was snow. Units differ: `precipitation_unit=inch` gives inches for both, but the metric default gives precipitation in mm and snowfall in cm |
| Open-Meteo Air Quality (`air-quality-api.open-meteo.com`) | No | PM2.5/PM10 fallback (always fetched alongside weather) |
| WeatherAPI.com | Yes | Alternative weather provider |
| WeatherAI.io | Yes | Astronomy data only (sunrise/sunset, moon phase, illumination). Tab hidden without a key |
| AirNow (`airnowapi.org`) | Yes (free) | US full AQI by pollutant; requires a station within ~25 mi |
| OpenWeatherMap (`api.openweathermap.org/data/2.5/air_pollution`) | Yes (free) | Global air pollution; coarse 1–5 AQI but always returns all 8 pollutants |
| USNO (`aa.usno.navy.mil/api`) | No | Solar noon (sun upper transit) + dates of the next new & full moon for the Astronomy tab; keyless, refreshed at most once per calendar day (own schedule, not the weather TTL; manual refresh bypasses the day gate), degrades silently |
| WeatherAPI.com Marine (`marine.json`) | Yes (reuses `weatherapi-key`) | Opt-in tide line (`tide-source=weatherapi`); global coastal, returns an error/no tides inland so the line hides |
| NOAA CO-OPS (`tidesandcurrents.noaa.gov`) | No | Opt-in tide line (`tide-source=noaa`); US only. Nearest tide-prediction station within ~50 km (else treated as inland and hidden); keyless |
| RainViewer (`api.rainviewer.com`) | No | Precipitation radar tiles for the Map tab; 10-minute publish cadence |
| Esri World Imagery | No | Satellite base layer under the radar tiles on the Map tab |
| NWS (`api.weather.gov`) | No | US weather alerts; also the plain-language daily narrative on the Daily tab (`/points` → forecast URL → daytime `detailedForecast` per day). US only — non-US points 404, so the provider's short WMO/condition label stands |
| Nominatim / OpenStreetMap | No | Reverse geocoding for auto location display name |
| Open-Meteo Geocoding | No | City search in Preferences |
