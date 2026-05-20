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

To reload after code changes (Wayland — only full session restart works reliably):
```bash
gnome-extensions disable weather-prime@weather-prime && gnome-extensions enable weather-prime@weather-prime
```

On X11, `Alt+F2` → type `r` → Enter restarts the shell in-place.

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
        ├── _fetch()           ← coordinates location → weather + AQ + alerts → parse → render
        ├── _resolveLocation() ← GeoClue2 auto or reads manual lat/lon from GSettings
        └── WeatherPanel       ← plain JS class, owns all drop-down UI
              └── tabs: current / hourly / daily / airquality
```

**`WeatherIndicator`** is the top-bar pill button. It owns:
- Two independent cache TTLs: `_cachedParsed`/`_lastFetch` (weather) and `_cachedAq`/`_lastAqFetch` (AirNow)
- A `GLib.timeout_add_seconds` periodic refresh timer
- GSettings `changed` signal to invalidate cache and re-fetch on any preference change

**`WeatherPanel`** is a plain JS class (not GObject). It receives parsed data via `setData()` and re-renders the active tab. Its `destroy()` must be called explicitly when `WeatherIndicator` is destroyed.

### Data Flow

```
_fetch(force)
  → _resolveLocation()           (GeoClue2 or manual coords from GSettings)
  → fetchAlerts() + fetchJSON(buildAirQualityUrl())   [parallel via Promise.all]
  → fetchJSON(buildOpenMeteoUrl()) OR fetchWeatherAPI()
  → parseOpenMeteo() / parseWeatherAPI()
  → WeatherPanel.setData({ current, hourly, daily, airquality, alerts })
```

Parsed data shape:
```js
{
  current:    { temp, feelsLike, humidity, wind, pressure, icon, desc },
  hourly:     [{ time, temp, icon, precip, humidity }, ...],   // next 12 hours
  daily:      [{ day, hi, lo, icon, precip, humidity }, ...],  // 7 days
  airquality: { airnow: {...} | null, pm25, pm10 },
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
| `airnow-api-key` | string | `''` | US only; without it, falls back to Open-Meteo PM2.5/PM10 |
| `location-auto` | bool | `true` | Uses GeoClue2 when true |
| `location-latitude/longitude` | double | `0.0` | Used for manual location; also cached from GeoClue2 |
| `fetch-interval` | int | `1440` | Weather refresh in minutes |
| `aq-fetch-interval` | int | `60` | AirNow refresh in minutes |
| `color-scheme` | string | `auto` | `auto`, `dark`, or `light` |
| `panel-position` | string | (none) | `left`, `center`, or `right` |

After editing the schema XML, always recompile: `glib-compile-schemas <path>/schemas/`.

## External APIs

| API | Key needed | Used for |
|-----|-----------|---------|
| Open-Meteo (`api.open-meteo.com`) | No | Weather forecast (default provider) |
| Open-Meteo Air Quality (`air-quality-api.open-meteo.com`) | No | PM2.5/PM10 (always fetched alongside weather) |
| WeatherAPI.com | Yes | Alternative weather provider |
| AirNow (`airnowapi.org`) | Yes (free) | US full AQI by pollutant |
| NWS (`api.weather.gov`) | No | US weather alerts |
| Nominatim / OpenStreetMap | No | Reverse geocoding for auto location display name |
| Open-Meteo Geocoding | No | City search in Preferences |
