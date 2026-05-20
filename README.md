# Weather Prime

A clean, feature-rich weather extension for GNOME Shell 50+.

## Features

- **Current conditions** — temperature, feels like, humidity, wind speed/direction, and barometric pressure with trend indicator (↑ → ↓)
- **Hourly forecast** — 12-hour outlook with weather icon, temperature, precipitation chance, humidity, and wind
- **7-day forecast** — daily high/low temperatures, weather icon, precipitation chance, humidity, and wind
- **Air quality** — three sources with automatic fallback:
  - **AirNow** — US EPA AQI (0–500) per pollutant, when a monitoring station is within ~25 mi
  - **OpenWeatherMap** — global 1–5 AQI plus concentrations for all 8 pollutants
  - **Open-Meteo** — PM 2.5 / PM 10, no key required
- **Astronomy tab** — sunrise/sunset, moonrise/moonset, moon phase, illumination (requires a free WeatherAI.io key; the tab is hidden if no key is set)
- **Weather Map** — static RainViewer radar over Esri World Imagery; click to open a fully interactive map on Windy, Zoom Earth, Ventusky, RainViewer, Weather.com, Wunderground, or NWS Radar
- **Weather alerts** — active NWS alerts (US only, no key required)
- **Dark and light mode** — auto-follows system theme or can be set manually
- **Flexible units** — Fahrenheit/Celsius, mph/km/h/m/s, hPa/inHg/mmHg
- **Panel position and size** — place the pill on the left, center, or right of the top bar; choose original or large (1.5×) drop-down panel
- **Two weather providers** — Open-Meteo (free, no key) or WeatherAPI.com (free key required)
- **Auto or manual location** — uses GeoClue2 for automatic detection (the Preferences page updates live when the location changes), or set any city manually

## Requirements

- GNOME Shell 50
- Fedora 44 (or any distro running GNOME 50)

## Installation

### From extensions.gnome.org
Search for **Weather Prime** and install directly from the browser extension.

### Manual
```bash
git clone https://github.com/catalyx-prime/weather-prime.git
cd weather-prime
mkdir -p ~/.local/share/gnome-shell/extensions/weather-prime@weather-prime
cp extension.js stylesheet.css metadata.json prefs.js \
   ~/.local/share/gnome-shell/extensions/weather-prime@weather-prime/
cp -r schemas ~/.local/share/gnome-shell/extensions/weather-prime@weather-prime/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/weather-prime@weather-prime/schemas/
gnome-extensions enable weather-prime@weather-prime
```

## Configuration

Open **Preferences** via the ⚙ button in the weather panel or through GNOME Extensions.

### Location

* **Auto** — detects your location via GeoClue2 (requires location services enabled)  
* **Manual** — search by city name or enter latitude/longitude directly

### Weather API

| Provider | Cost | Key Required |
| :---- | :---- | :---- |
| Open-Meteo | Free | No |
| WeatherAPI.com | Free tier available | Yes — register at weatherapi.com |

### Astronomy

* **WeatherAI.io** — free key powers the Astronomy tab (sunrise/sunset, moonrise/moonset, moon phase and illumination). Without a key the tab is hidden; forecast data still comes from your chosen weather provider above.

### Air Quality

| Source | Coverage | Key Required | Notes |
| :---- | :---- | :---- | :---- |
| Open-Meteo | Global | No | Basic PM 2.5 and PM 10; default fallback |
| AirNow | US | Yes — airnowapi.org | Full EPA AQI 0–500 with per-pollutant breakdown; needs a monitoring station within ~25 mi |
| OpenWeatherMap | Global | Yes — openweathermap.org | Coarser 1–5 AQI but always returns all 8 pollutant concentrations |

The **Air quality source** dropdown chooses which provider runs when its key is configured. **Automatic** prefers AirNow, then OpenWeatherMap, then Open-Meteo.

### Appearance

* **Color scheme** — Auto (follows system), Dark, or Light
* **Panel position** — Left, Center, or Right
* **Panel size** — Original or Large (1.5×)
* **Map tab destination** — pick which external site (Windy, Zoom Earth, Ventusky, RainViewer, Weather.com, Wunderground, or NWS Radar) opens when you click the Map tab

### API Call Frequency

Each data source has its own refresh interval:

* **Weather** — current conditions, hourly, 7-day, alerts
* **Air quality** — whichever air-quality source is active
* **Radar overlay** — RainViewer tiles for the Map tab (10-minute minimum — that's RainViewer's own publish cadence)

### Units

* **Temperature** — Fahrenheit or Celsius  
* **Wind speed** — mph, km/h, or m/s  
* **Pressure** — hPa, inHg, or mmHg

## Data Sources

* Open-Meteo — weather forecasts and PM 2.5 / PM 10
* WeatherAPI.com — alternative weather provider
* WeatherAI.io — astronomy (sunrise/sunset, moon phase, illumination)
* AirNow / US EPA — US air quality index
* OpenWeatherMap — global air pollution (1–5 AQI + 8 pollutants)
* RainViewer — precipitation radar tiles for the Map tab
* Esri World Imagery — satellite base layer under the radar
* NWS / weather.gov — US weather alerts
* Open-Meteo Geocoding — city search
* Nominatim / OpenStreetMap — reverse geocoding
