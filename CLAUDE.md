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
cp -r schemas ~/.local/share/gnome-shell/extensions/weather-prime@weather-prime/

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

### Class Structure (`extension.js`)

```
WeatherPrimeExtension          ← ES module default export; enable()/disable() lifecycle
  └── WeatherIndicator         ← GObject.registerClass, extends PanelMenu.Button
        ├── _fetch()           ← coordinates location → weather + AQ + astro + map + alerts → parse → render
        ├── _resolveLocation() ← GeoClue2 auto or reads manual lat/lon from GSettings
        └── WeatherPanel       ← plain JS class, owns all drop-down UI
              └── tabs: current / hourly / daily / airquality / astronomy / map
                        (astronomy hidden unless a WeatherAI.io key is configured;
                         map hidden if RainViewer tile fetch failed)
```

**`WeatherIndicator`** is the top-bar pill button. It owns:
- Three independent cache TTLs:
  - `_cachedParsed`/`_lastFetch` — weather payload (`fetch-interval`)
  - `_cachedAq`/`_lastAqFetch` — air quality (`aq-fetch-interval`)
  - `_cachedMap`/`_lastMapFetch` — RainViewer radar tiles (`map-fetch-interval`, 10 min floor)
- `_cachedLat`/`_cachedLon` — last resolved coords; if these change between `_fetch()` runs, **all three caches are invalidated** so a GeoClue move doesn't serve stale data for the old location.
- A `GLib.timeout_add_seconds` periodic refresh timer whose period is `min(weather, aq, map)`
- GSettings `changed` signal to invalidate cache and re-fetch on any preference change

**`WeatherPanel`** is a plain JS class (not GObject). It receives parsed data via `setData()` and re-renders the active tab. Its `destroy()` must be called explicitly when `WeatherIndicator` is destroyed.

### Data Flow

```
_fetch(force)
  → _resolveLocation()                        (GeoClue2 or manual coords from GSettings)
  → if location moved since last fetch, drop all caches
  → if not fresh: fetch air quality (AirNow → OpenWeatherMap → Open-Meteo, per aq-source)
  → if not fresh: fetch RainViewer radar tile composite over Esri World Imagery base
  → if weather not fresh: Promise.all([
        fetchJSON(buildAirQualityUrl()),       // PM2.5/PM10 backfill
        fetchAlerts(),                          // NWS, US only
        fetchWeatherAi('/astronomy', …)         // only if weatherai-key set
     ])
     then fetchJSON(buildOpenMeteoUrl()) OR fetchWeatherAPI()
     then parseOpenMeteo() / parseWeatherAPI()
  → WeatherPanel.setData({ current, hourly, daily, airquality, astronomy?, map?, alerts })
```

Parsed data shape:
```js
{
  current:    { temp, feelsLike, humidity, wind, pressure, icon, desc,
                windGust?, dewPoint?, visibility?, cloudCover?, sunrise?, sunset? },
  hourly:     [{ time, temp, icon, precip, humidity, wind }, ...],   // next 12 hours
  daily:      [{ day,  hi,   lo, icon, precip, humidity, wind }, ...], // 7 days
  airquality: {
    airnow:      {...} | null,   // US EPA AQI by pollutant when key + nearby station
    openweather: {...} | null,   // global 1–5 AQI + 8 pollutant concentrations
    pm25, pm10,                   // Open-Meteo fallback, always present
  },
  astronomy:  { sunrise, sunset, moonrise, moonset, moonPhase, moonIllum, ... } | undefined,
  map:        { cells, radarPath, frameTime, zoom } | undefined,
  alerts:     [{ event, headline, desc, severity }],
}
```

### Key Technical Details

- **GJS imports** use `gi://` URIs (`gi://GObject`, `gi://St`, `gi://Soup`, etc.). GNOME Shell internal APIs use `resource:///org/gnome/shell/…`.
- **`URLSearchParams` polyfill** — GJS does not have this web API, so both `extension.js` and `prefs.js` define a minimal shim at the top of the file.
- **Signal management** — Every `connect()` call returns a signal ID that must be stored and passed to `disconnect()` in `destroy()`. Leaking signals causes memory leaks and can crash the shell.
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
| `weatherai-key` | string | `''` | When set, powers the Astronomy tab (sunrise/sunset, moon). Tab is hidden if unset. Astronomy-only role — forecast still comes from `api-provider` |
| `airnow-api-key` | string | `''` | US AirNow; per-pollutant AQI when a station is within ~25 mi |
| `openweather-api-key` | string | `''` | OpenWeatherMap Air Pollution; global 1–5 AQI + 8 pollutant concentrations |
| `aq-source` | string | `auto` | `auto` (AirNow → OpenWeatherMap → Open-Meteo), `airnow`, `openweather`, `open-meteo` |
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
| Open-Meteo (`api.open-meteo.com`) | No | Weather forecast (default provider); also backfills wind direction in the 7-day when WeatherAI overlay lacks it |
| Open-Meteo Air Quality (`air-quality-api.open-meteo.com`) | No | PM2.5/PM10 fallback (always fetched alongside weather) |
| WeatherAPI.com | Yes | Alternative weather provider |
| WeatherAI.io | Yes | Astronomy data only (sunrise/sunset, moon phase, illumination). Tab hidden without a key |
| AirNow (`airnowapi.org`) | Yes (free) | US full AQI by pollutant; requires a station within ~25 mi |
| OpenWeatherMap (`api.openweathermap.org/data/2.5/air_pollution`) | Yes (free) | Global air pollution; coarse 1–5 AQI but always returns all 8 pollutants |
| RainViewer (`api.rainviewer.com`) | No | Precipitation radar tiles for the Map tab; 10-minute publish cadence |
| Esri World Imagery | No | Satellite base layer under the radar tiles on the Map tab |
| NWS (`api.weather.gov`) | No | US weather alerts |
| Nominatim / OpenStreetMap | No | Reverse geocoding for auto location display name |
| Open-Meteo Geocoding | No | City search in Preferences |
