# Weather Prime

A clean, feature-rich weather extension for GNOME Shell 50+.

## Features

- **Current conditions** — temperature, feels like, humidity, wind speed/direction, and barometric pressure with trend indicator (↑ → ↓)
- **Hourly forecast** — 12-hour outlook with weather icon, temperature, and precipitation chance
- **7-day forecast** — daily high/low temperatures, weather icon, and precipitation chance
- **Air quality** — PM 2.5 and PM 10 from Open-Meteo, or full AQI by pollutant via AirNow (US only)
- **Weather alerts** — active NWS alerts (US only, no key required)
- **Dark and light mode** — auto-follows system theme or can be set manually
- **Flexible units** — Fahrenheit/Celsius, mph/km/h/m/s, hPa/inHg/mmHg
- **Panel position** — place the weather pill on the left, center, or right of the top bar
- **Two weather providers** — Open-Meteo (free, no key) or WeatherAPI.com (free key required)
- **Auto or manual location** — uses GeoClue2 for automatic detection, or set any city manually

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

### Air Quality

* **Open-Meteo** — basic PM 2.5 and PM 10 shown by default, no key needed  
* **AirNow** — full AQI by pollutant (O3, PM 2.5, PM 10, CO, SO2, NO2) for US locations. Free — register at airnowapi.org. Requires a monitoring station within 25 mi / 40 km of your location.

### Appearance

* **Color scheme** — Auto (follows system), Dark, or Light  
* **Panel position** — Left, Center, or Right

### Units

* **Temperature** — Fahrenheit or Celsius  
* **Wind speed** — mph, km/h, or m/s  
* **Pressure** — hPa, inHg, or mmHg

## Data Sources

* Open-Meteo — weather forecasts and air quality  
* WeatherAPI.com — alternative weather provider  
* AirNow / US EPA — US air quality index  
* NWS / weather.gov — US weather alerts  
* Open-Meteo Geocoding — city search  
* Nominatim / OpenStreetMap — reverse geocoding
