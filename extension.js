import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import Geoclue from 'gi://Geoclue';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

if (typeof URLSearchParams === 'undefined') {
    globalThis.URLSearchParams = class {
        constructor(o = {}) {
            this._e = Object.entries(o).map(([k, v]) => [k, String(v)]);
        }
        toString() {
            return this._e.map(([k, v]) =>
                encodeURIComponent(k) + '=' + encodeURIComponent(v)
            ).join('&');
        }
    };
}

// ── WMO weather code table ────────────────────────────────────────────────

const WMO = {
    0:  {icon: '☀️',  desc: 'Clear sky'},
    1:  {icon: '🌤️', desc: 'Mainly clear'},
    2:  {icon: '⛅',  desc: 'Partly cloudy'},
    3:  {icon: '☁️',  desc: 'Overcast'},
    45: {icon: '🌫️', desc: 'Fog'},
    48: {icon: '🌫️', desc: 'Rime fog'},
    51: {icon: '🌦️', desc: 'Light drizzle'},
    53: {icon: '🌦️', desc: 'Drizzle'},
    55: {icon: '🌦️', desc: 'Dense drizzle'},
    56: {icon: '🌨️', desc: 'Light freezing drizzle'},
    57: {icon: '🌨️', desc: 'Freezing drizzle'},
    61: {icon: '🌧️', desc: 'Slight rain'},
    63: {icon: '🌧️', desc: 'Rain'},
    65: {icon: '🌧️', desc: 'Heavy rain'},
    66: {icon: '🌨️', desc: 'Light freezing rain'},
    67: {icon: '🌨️', desc: 'Freezing rain'},
    71: {icon: '❄️',  desc: 'Slight snow'},
    73: {icon: '❄️',  desc: 'Snowfall'},
    75: {icon: '❄️',  desc: 'Heavy snow'},
    77: {icon: '🌨️', desc: 'Snow grains'},
    80: {icon: '🌦️', desc: 'Slight showers'},
    81: {icon: '🌦️', desc: 'Showers'},
    82: {icon: '🌧️', desc: 'Violent showers'},
    85: {icon: '🌨️', desc: 'Slight snow showers'},
    86: {icon: '🌨️', desc: 'Heavy snow showers'},
    95: {icon: '⛈️', desc: 'Thunderstorm'},
    96: {icon: '⛈️', desc: 'Thunderstorm w/ hail'},
    99: {icon: '⛈️', desc: 'Thunderstorm w/ heavy hail'},
};

function wmo(code) {
    return WMO[code] ?? {icon: '🌡️', desc: 'Unknown'};
}

function moonPhaseIcon(phaseName) {
    if (!phaseName) return '🌙';
    const p = phaseName.toLowerCase();
    if (p.includes('new'))                                return '🌑';
    if (p.includes('waxing')  && p.includes('crescent'))  return '🌒';
    if (p.includes('first')   && p.includes('quarter'))   return '🌓';
    if (p.includes('waxing')  && p.includes('gibbous'))   return '🌔';
    if (p.includes('full'))                               return '🌕';
    if (p.includes('waning')  && p.includes('gibbous'))   return '🌖';
    if ((p.includes('last') || p.includes('third')) && p.includes('quarter')) return '🌗';
    if (p.includes('waning')  && p.includes('crescent'))  return '🌘';
    return '🌙';
}

// ── Utility / formatting ──────────────────────────────────────────────────

function pm25Level(v) {
    if (v == null) return {text: 'N/A', color: null};
    if (v < 12)    return {text: 'Good',          color: '#4CAF50'};
    if (v < 35.4)  return {text: 'Moderate',      color: '#FFC107'};
    if (v < 55.4)  return {text: 'USG',           color: '#FF9800'};
    if (v < 150.4) return {text: 'Unhealthy',     color: '#FF5722'};
    return               {text: 'Very Unhealthy', color: '#EF5350'};
}

const AQ_COLORS = {
    1: '#4CAF50',
    2: '#FFC107',
    3: '#FF9800',
    4: '#FF5722',
    5: '#9C27B0',
    6: '#B71C1C',
};

const PARAM_LABELS = {
    'O3':    'Ozone',
    'PM2.5': 'PM 2.5',
    'PM10':  'PM 10',
    'CO':    'Carbon Monoxide',
    'SO2':   'Sulfur Dioxide',
    'NO2':   'Nitrogen Dioxide',
};

function windDir(deg) {
    if (deg == null) return '';
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
}

// Arrow points in the direction the wind is moving toward
// (0° = wind from N, blowing south → ↓).
function windArrow(deg) {
    if (deg == null) return '';
    const arrows = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];
    return arrows[Math.round(deg / 45) % 8];
}

const CARDINAL_DEG = {
    N: 0,   NNE: 22.5,  NE: 45,   ENE: 67.5,
    E: 90,  ESE: 112.5, SE: 135,  SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225,  WSW: 247.5,
    W: 270, WNW: 292.5, NW: 315,  NNW: 337.5,
};

function cardinalToDeg(s) {
    if (!s) return null;
    return CARDINAL_DEG[String(s).toUpperCase().trim()] ?? null;
}

function fmt(val, unit) {
    if (val == null) return '--';
    const sym = unit === 'fahrenheit' ? '°F' : '°C';
    return `${Math.round(val)}${sym}`;
}

function fmtWind(mph, dir, windUnit) {
    if (mph == null) return '--';
    let val, sym;
    if (windUnit === 'kmh')     { val = Math.round(mph * 1.60934); sym = 'km/h'; }
    else if (windUnit === 'ms') { val = (mph * 0.44704).toFixed(1); sym = 'm/s'; }
    else                        { val = Math.round(mph); sym = 'mph'; }
    return dir ? `${val} ${sym} ${dir}` : `${val} ${sym}`;
}

// Compact "<speed> <arrow>" for hourly/daily rows. Arrow is omitted when
// direction is unknown so the field still shows speed alone.
function fmtWindShort(mph, deg, windUnit) {
    if (mph == null) return '--';
    let val;
    if (windUnit === 'kmh')     val = Math.round(mph * 1.60934);
    else if (windUnit === 'ms') val = Math.round(mph * 0.44704);
    else                        val = Math.round(mph);
    const arrow = windArrow(deg);
    return arrow ? `${val} ${arrow}` : `${val}`;
}

function fmtPressure(hpa, pressureUnit, trend = '') {
    if (hpa == null) return '--';
    const pre = trend ? `${trend.trim()} ` : '';
    if (pressureUnit === 'inhg') return `${pre}${(hpa * 0.02953).toFixed(2)} inHg`;
    if (pressureUnit === 'mmhg') return `${pre}${Math.round(hpa * 0.75006)} mmHg`;
    return `${pre}${Math.round(hpa)} hPa`;
}

// Compare pressure now vs 3 hours ago; threshold 2 hPa = meaningful change
function pressureTrend(pressureArray, currentIdx) {
    if (!pressureArray || currentIdx < 3) return '';
    const curr = pressureArray[currentIdx];
    const prev = pressureArray[currentIdx - 3];
    if (curr == null || prev == null) return '';
    const diff = curr - prev;
    if (diff > 2)  return ' ↑';
    if (diff < -2) return ' ↓';
    return ' →';
}

function shortHour(isoString) {
    const d = new Date(isoString);
    let h = d.getHours();
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return `${h}${ampm}`;
}

function shortDay(s) {
    const d = new Date(s.length === 10 ? s + 'T12:00:00' : s);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
}

// Format an ISO-ish "YYYY-MM-DDTHH:MM[...]" string as "h:mm AM/PM" using
// the literal HH:MM in the string. Avoids timezone surprises from `new Date`
// when Open-Meteo returns localized timestamps without a UTC offset.
function formatTime(iso) {
    if (!iso) return null;
    const m = String(iso).match(/T?(\d{1,2}):(\d{2})/);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const mm = m[2];
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${mm} ${ampm}`;
}

// ── HTTP helper ───────────────────────────────────────────────────────────

let _session = null;
function getSession() {
    if (!_session)
        _session = new Soup.Session({user_agent: 'WeatherPrime/1.0'});
    return _session;
}

function fetchJSON(url, headers = null) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', url);
        if (!msg) { reject(new Error(`Bad URL: ${url}`)); return; }
        if (headers) {
            for (const [k, v] of Object.entries(headers))
                msg.request_headers.append(k, v);
        }
        getSession().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
            try {
                const bytes  = sess.send_and_read_finish(result);
                const status = msg.get_status();
                if (status !== Soup.Status.OK)
                    throw new Error(`HTTP ${status}`);
                resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// ── Open-Meteo ────────────────────────────────────────────────────────────

function buildOpenMeteoUrl(lat, lon, unit) {
    const tu = unit === 'fahrenheit' ? 'fahrenheit' : 'celsius';
    const params = new URLSearchParams({
        latitude:  lat,
        longitude: lon,
        current: [
            'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
            'wind_speed_10m', 'wind_direction_10m', 'weather_code', 'surface_pressure',
        ].join(','),
        hourly:           'temperature_2m,relative_humidity_2m,weather_code,surface_pressure,precipitation_probability,wind_speed_10m,wind_direction_10m',
        daily:            'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant,sunrise,sunset',
        temperature_unit: tu,
        wind_speed_unit:  'mph',
        timezone:         'auto',
        forecast_days:    7,
    });
    return `https://api.open-meteo.com/v1/forecast?${params}`;
}

function buildAirQualityUrl(lat, lon) {
    const params = new URLSearchParams({
        latitude:      lat,
        longitude:     lon,
        hourly:        'pm2_5,pm10',
        timezone:      'auto',
        forecast_days: 1,
    });
    return `https://air-quality-api.open-meteo.com/v1/air-quality?${params}`;
}

function parseOpenMeteo(data, aqData, windUnit, pressureUnit, unit) {
    const c = data.current;
    const h = data.hourly;
    const d = data.daily;

    const now = new Date();
    let hi = 0;
    for (let i = 0; i < h.time.length; i++) {
        if (new Date(h.time[i]) <= now) hi = i;
        else break;
    }
    const hourly = h.time.slice(hi, hi + 12).map((t, idx) => ({
        time:     shortHour(t),
        temp:     fmt(h.temperature_2m[hi + idx], unit),
        icon:     wmo(h.weather_code[hi + idx]).icon,
        precip:   `${h.precipitation_probability[hi + idx] ?? 0}%`,
        humidity: `${Math.round(h.relative_humidity_2m?.[hi + idx] ?? 0)}%`,
        wind:     fmtWindShort(h.wind_speed_10m?.[hi + idx], h.wind_direction_10m?.[hi + idx], windUnit),
    }));

    const dailyHumidity = d.time.map(dayStr => {
        const prefix = dayStr.substring(0, 10);
        let sum = 0, count = 0;
        for (let i = 0; i < h.time.length; i++) {
            if (h.time[i].startsWith(prefix) && h.relative_humidity_2m?.[i] != null) {
                sum += h.relative_humidity_2m[i];
                count++;
            }
        }
        return count > 0 ? Math.round(sum / count) : null;
    });

    const daily = d.time.map((t, i) => ({
        day:      shortDay(t),
        hi:       fmt(d.temperature_2m_max[i], unit),
        lo:       fmt(d.temperature_2m_min[i], unit),
        icon:     wmo(d.weather_code[i]).icon,
        precip:   `${d.precipitation_probability_max[i] ?? 0}%`,
        humidity: dailyHumidity[i] != null ? `${dailyHumidity[i]}%` : '--',
        wind:     fmtWindShort(d.wind_speed_10m_max?.[i], d.wind_direction_10m_dominant?.[i], windUnit),
    }));

    const aqH = aqData?.hourly;
    let aqIdx = aqH ? aqH.time.findIndex(t => new Date(t) >= now) : -1;
    if (aqIdx < 0) aqIdx = 0;
    const aq = key => aqH?.[key]?.[aqIdx] ?? null;

    const trend = pressureTrend(h.surface_pressure, hi);

    return {
        current: {
            temp:      fmt(c.temperature_2m, unit),
            feelsLike: fmt(c.apparent_temperature, unit),
            humidity:  `${c.relative_humidity_2m ?? '--'}%`,
            wind:      fmtWind(c.wind_speed_10m, windDir(c.wind_direction_10m), windUnit),
            pressure:  fmtPressure(c.surface_pressure, pressureUnit, trend),
            icon:      wmo(c.weather_code).icon,
            desc:      wmo(c.weather_code).desc,
        },
        hourly,
        daily,
        airquality: {
            airnow:      null,
            openweather: null,
            pm25:        aq('pm2_5'),
            pm10:        aq('pm10'),
        },
    };
}

// ── WeatherAPI.com ────────────────────────────────────────────────────────

function fetchWeatherAPI(lat, lon, key) {
    const params = new URLSearchParams({
        key, q: `${lat},${lon}`, days: 7, aqi: 'no', alerts: 'no',
    });
    return fetchJSON(`https://api.weatherapi.com/v1/forecast.json?${params}`);
}

function wApiIcon(condText, isDay) {
    const t = condText.toLowerCase();
    if (t.includes('thunder'))                        return '⛈️';
    if (t.includes('snow') || t.includes('blizzard')) return '❄️';
    if (t.includes('sleet') || t.includes('ice'))     return '🌨️';
    if (t.includes('rain') || t.includes('drizzle'))  return '🌧️';
    if (t.includes('mist') || t.includes('fog'))      return '🌫️';
    if (t.includes('overcast'))                       return '☁️';
    if (t.includes('cloud'))                          return '⛅';
    return isDay ? '☀️' : '🌙';
}

function parseWeatherAPI(data, aqData, windUnit, pressureUnit, unit) {
    const c   = data.current;
    const isF = unit === 'fahrenheit';

    const now = new Date();
    const allHours = data.forecast.forecastday.flatMap(day => day.hour);
    let hi = 0;
    for (let i = 0; i < allHours.length; i++) {
        if (new Date(allHours[i].time) <= now) hi = i;
        else break;
    }
    const hourly = allHours.slice(hi, hi + 12).map(h => ({
        time:     shortHour(h.time),
        temp:     `${Math.round(isF ? h.temp_f : h.temp_c)}°${isF ? 'F' : 'C'}`,
        icon:     wApiIcon(h.condition.text, h.is_day),
        precip:   `${h.chance_of_rain ?? 0}%`,
        humidity: `${Math.round(h.humidity ?? 0)}%`,
        wind:     fmtWindShort(h.wind_mph, cardinalToDeg(h.wind_dir), windUnit),
    }));

    const daily = data.forecast.forecastday.map(day => ({
        day:      shortDay(day.date),
        hi:       `${Math.round(isF ? day.day.maxtemp_f : day.day.maxtemp_c)}°${isF ? 'F' : 'C'}`,
        lo:       `${Math.round(isF ? day.day.mintemp_f : day.day.mintemp_c)}°${isF ? 'F' : 'C'}`,
        icon:     wApiIcon(day.day.condition.text, 1),
        precip:   `${day.day.daily_chance_of_rain ?? 0}%`,
        humidity: day.day.avghumidity != null ? `${Math.round(day.day.avghumidity)}%` : '--',
        wind:     fmtWindShort(day.day.maxwind_mph, null, windUnit),
    }));

    const aqH = aqData?.hourly;
    let aqIdx = aqH ? aqH.time.findIndex(t => new Date(t) >= now) : -1;
    if (aqIdx < 0) aqIdx = 0;
    const aq = key => aqH?.[key]?.[aqIdx] ?? null;

    const trend = pressureTrend(allHours.map(h => h.pressure_mb), hi);

    return {
        current: {
            temp:      `${Math.round(isF ? c.temp_f : c.temp_c)}°${isF ? 'F' : 'C'}`,
            feelsLike: `${Math.round(isF ? c.feelslike_f : c.feelslike_c)}°${isF ? 'F' : 'C'}`,
            humidity:  `${c.humidity}%`,
            wind:      fmtWind(c.wind_mph, c.wind_dir, windUnit),
            pressure:  fmtPressure(c.pressure_mb, pressureUnit, trend),
            icon:      wApiIcon(c.condition.text, c.is_day),
            desc:      c.condition.text,
        },
        hourly,
        daily,
        airquality: {
            airnow:      null,
            openweather: null,
            pm25:        aq('pm2_5'),
            pm10:        aq('pm10'),
        },
    };
}

// ── WeatherAI.io ──────────────────────────────────────────────────────────

const WEATHERAI_BASE = 'https://api.weatherai.io/v1';

function fetchWeatherAi(path, params, key) {
    const qs = new URLSearchParams(params);
    return fetchJSON(`${WEATHERAI_BASE}${path}?${qs}`, {'X-API-Key': key});
}

function fetchWeatherAiAstronomy(lat, lon, key) {
    return fetchWeatherAi('/astronomy', {q: `${lat},${lon}`}, key);
}

function parseWeatherAiAstronomy(data) {
    const a = data?.astronomy ?? data ?? {};
    return {
        sunrise:          a.sunrise          ?? null,
        sunset:           a.sunset           ?? null,
        moonrise:         a.moonrise         ?? null,
        moonset:          a.moonset          ?? null,
        moonPhase:        a.moonPhase        ?? a.moon_phase ?? null,
        moonIllumination: a.moonIllumination ?? a.moon_illumination ?? null,
    };
}

// ── AirNow (US EPA, free with registration) ───────────────────────────────

async function fetchAirNow(lat, lon, key) {
    if (!key) return null;
    try {
        const params = new URLSearchParams({
            format:    'application/json',
            latitude:  lat.toFixed(4),
            longitude: lon.toFixed(4),
            distance:  25,
            API_KEY:   key,
        });
        const data = await fetchJSON(
            `https://www.airnowapi.org/aq/observation/latLong/current/?${params}`
        );
        if (!Array.isArray(data) || data.length === 0) return null;
        const result = {};
        data.forEach(obs => {
            if (obs.AQI >= 0) {
                result[obs.ParameterName] = {
                    aqi:         obs.AQI,
                    category:    obs.Category.Name,
                    categoryNum: obs.Category.Number,
                };
            }
        });
        return Object.keys(result).length > 0 ? result : null;
    } catch (e) {
        console.error('[WeatherPrime] AirNow error:', e.message);
        return null;
    }
}

// ── OpenWeatherMap Air Pollution (global, free with registration) ────────

const OWM_AQI_CATEGORIES = {
    1: 'Good',
    2: 'Fair',
    3: 'Moderate',
    4: 'Poor',
    5: 'Very Poor',
};

const OWM_COMPONENT_LABELS = {
    pm2_5: 'PM 2.5',
    pm10:  'PM 10',
    o3:    'Ozone',
    no2:   'Nitrogen Dioxide',
    so2:   'Sulfur Dioxide',
    co:    'Carbon Monoxide',
    no:    'Nitric Oxide',
    nh3:   'Ammonia',
};

// Per-pollutant breakpoints (µg/m³) from the OpenWeatherMap Air Pollution
// API docs. Index 0..4 maps to {Good, Fair, Moderate, Poor, Very Poor}
// using AQ_COLORS 1..5. No published thresholds for `no` and `nh3`.
const OWM_POLLUTANT_BREAKS = {
    so2:   [20,   80,   250,   350],
    no2:   [40,   70,   150,   200],
    pm10:  [20,   50,   100,   200],
    pm2_5: [10,   25,   50,    75],
    o3:    [60,   100,  140,   180],
    co:    [4400, 9400, 12400, 15400],
};

const OWM_LEVEL_LABELS = ['Good', 'Fair', 'Moderate', 'Poor', 'Very Poor'];

function owmPollutantLevel(component, v) {
    if (v == null) return null;
    const breaks = OWM_POLLUTANT_BREAKS[component];
    if (!breaks) return null;
    let i = 0;
    while (i < breaks.length && v >= breaks[i]) i++;
    return {
        text:  OWM_LEVEL_LABELS[i],
        color: AQ_COLORS[i + 1],
    };
}

async function fetchOpenWeatherAirPollution(lat, lon, key) {
    if (!key) return null;
    try {
        const params = new URLSearchParams({
            lat:   lat.toFixed(4),
            lon:   lon.toFixed(4),
            appid: key,
        });
        const data = await fetchJSON(
            `https://api.openweathermap.org/data/2.5/air_pollution?${params}`
        );
        const entry = data?.list?.[0];
        if (!entry?.main || !entry.components) return null;
        const aqi = entry.main.aqi;
        return {
            aqi,
            category:    OWM_AQI_CATEGORIES[aqi] ?? 'Unknown',
            categoryNum: aqi,
            components:  entry.components,
        };
    } catch (e) {
        console.error('[WeatherPrime] OpenWeatherMap air pollution error:', e.message);
        return null;
    }
}

// ── NWS weather alerts (US, free, no key) ────────────────────────────────

async function fetchAlerts(lat, lon) {
    try {
        const data = await fetchJSON(
            `https://api.weather.gov/alerts/active?point=${lat},${lon}`
        );
        return (data.features ?? []).map(f => ({
            event:    f.properties.event    ?? 'Alert',
            headline: f.properties.headline ?? '',
            desc:     f.properties.description ?? '',
            severity: f.properties.severity ?? 'Unknown',
        }));
    } catch {
        return [];
    }
}

// ── Reverse geocoding ─────────────────────────────────────────────────────

async function reverseGeocode(lat, lon) {
    try {
        const params = new URLSearchParams({lat, lon, format: 'json', zoom: 10});
        const data = await fetchJSON(
            `https://nominatim.openstreetmap.org/reverse?${params}`
        );
        const a = data.address;
        return a.city ?? a.town ?? a.village ?? a.county ?? data.display_name ?? 'Current location';
    } catch {
        return 'Current location';
    }
}

// ── St widget helpers ─────────────────────────────────────────────────────

function label(text, styleClass = '') {
    return new St.Label({text: String(text), style_class: styleClass});
}

function hbox(styleClass = '') {
    return new St.BoxLayout({style_class: styleClass, x_expand: true});
}

function vbox(styleClass = '') {
    return new St.BoxLayout({vertical: true, style_class: styleClass, x_expand: true});
}

function spacer() {
    return new St.Widget({x_expand: true});
}

// ── WeatherPanel ──────────────────────────────────────────────────────────

class WeatherPanel {
    constructor() {
        this._data       = null;
        this._tab        = 'current';
        this._refreshCb  = null;
        this._settingsCb = null;

        this.actor = vbox('wp-panel');
        this._build();
    }

    _build() {
        // ── Header ────────────────────────────────────────────────────────
        const header = hbox('wp-header');
        this._locationLbl = label('Loading…', 'wp-location');

        this._refreshBtn = new St.Button({
            label:       '↻',
            style_class: 'wp-icon-btn',
            reactive:    true,
        });
        this._refreshSignalId = this._refreshBtn.connect('clicked', () => this._refreshCb?.());

        this._settingsBtn = new St.Button({
            label:       '⚙',
            style_class: 'wp-icon-btn wp-settings-btn',
            reactive:    true,
        });
        this._settingsSignalId = this._settingsBtn.connect('clicked', () => this._settingsCb?.());

        header.add_child(this._locationLbl);
        header.add_child(spacer());
        header.add_child(this._refreshBtn);
        header.add_child(this._settingsBtn);
        this.actor.add_child(header);

        // ── Alerts banner ─────────────────────────────────────────────────
        this._alertsBanner = vbox('wp-alerts-banner');
        this._alertsBanner.hide();
        this.actor.add_child(this._alertsBanner);

        // ── Tab bar ───────────────────────────────────────────────────────
        const tabBar = hbox('wp-tab-bar');
        this._tabBtns      = {};
        this._tabSignalIds = {};
        [
            ['current',    'Now'],
            ['hourly',     'Hourly'],
            ['daily',      '7-Day'],
            ['airquality', '🌬️ Air'],
            ['astronomy',  '🌙 Astro'],
        ].forEach(([id, lbl]) => {
            const btn = new St.Button({
                label:       lbl,
                style_class: 'wp-tab',
                x_expand:    true,
                reactive:    true,
                can_focus:   true,
            });
            this._tabSignalIds[id] = btn.connect('clicked', () => this._selectTab(id));
            this._tabBtns[id] = btn;
            tabBar.add_child(btn);
        });
        this._tabBtns.astronomy.hide();
        this.actor.add_child(tabBar);

        // ── Scrollable content area ───────────────────────────────────────
        this._scroll = new St.ScrollView({
            style_class:        'wp-scroll',
            x_expand:           true,
            overlay_scrollbars: true,
        });
        this._content = vbox('wp-content');
        this._scroll.set_child(this._content);
        this.actor.add_child(this._scroll);

        this._selectTab('current');
    }

    _selectTab(id) {
        this._tab = id;
        Object.entries(this._tabBtns).forEach(([tid, btn]) => {
            if (tid === id) btn.add_style_class_name('active');
            else            btn.remove_style_class_name('active');
        });
        this._render();
    }

    destroy() {
        if (this._refreshSignalId) {
            this._refreshBtn.disconnect(this._refreshSignalId);
            this._refreshSignalId = null;
        }
        if (this._settingsSignalId) {
            this._settingsBtn.disconnect(this._settingsSignalId);
            this._settingsSignalId = null;
        }
        Object.entries(this._tabSignalIds ?? {}).forEach(([id, sid]) => {
            this._tabBtns[id]?.disconnect(sid);
        });
        this._tabSignalIds = null;
        this._tabBtns      = null;
        this._refreshBtn?.destroy();
        this._refreshBtn   = null;
        this._settingsBtn?.destroy();
        this._settingsBtn  = null;
        this._scroll?.destroy();
        this._scroll       = null;
        this._locationLbl  = null;
        this._alertsBanner = null;
        this._content      = null;
        this.actor.destroy();
        this.actor = null;
    }

    onRefresh(cb)  { this._refreshCb  = cb; }
    onSettings(cb) { this._settingsCb = cb; }

    setLocation(name) { this._locationLbl.set_text(name || 'Unknown'); }

    setLoading() {
        this._content.destroy_all_children();
        this._content.add_child(label('Fetching weather…', 'wp-status'));
    }

    setError(msg) {
        this._content.destroy_all_children();
        const box = vbox('wp-error');
        box.add_child(label('⚠️', 'wp-error-icon'));
        box.add_child(label(msg, 'wp-error-msg'));
        this._content.add_child(box);
    }

    setData(data) {
        this._data = data;
        this._renderAlertsBanner(data.alerts ?? []);
        if (data.astronomy) {
            this._tabBtns.astronomy?.show();
        } else {
            this._tabBtns.astronomy?.hide();
            if (this._tab === 'astronomy') this._selectTab('current');
        }
        this._render();
    }

    _renderAlertsBanner(alerts) {
        this._alertsBanner.destroy_all_children();
        if (!alerts.length) { this._alertsBanner.hide(); return; }
        this._alertsBanner.show();
        alerts.forEach(a => {
            const item = vbox('wp-alert-item');
            const titleRow = hbox('wp-alert-title-row');
            titleRow.add_child(label('⚠', 'wp-alert-badge'));
            const eventLbl = label(a.event, 'wp-alert-event');
            eventLbl.clutter_text.line_wrap = true;
            titleRow.add_child(eventLbl);
            item.add_child(titleRow);
            if (a.headline) {
                const hlLbl = label(a.headline, 'wp-alert-headline');
                hlLbl.clutter_text.line_wrap = true;
                item.add_child(hlLbl);
            }
            this._alertsBanner.add_child(item);
        });
    }

    _render() {
        this._content.destroy_all_children();
        if (!this._data) return;
        switch (this._tab) {
        case 'current':    this._renderCurrent();    break;
        case 'hourly':     this._renderHourly();     break;
        case 'daily':      this._renderDaily();      break;
        case 'airquality': this._renderAirQuality(); break;
        case 'astronomy':  this._renderAstronomy();  break;
        }
    }

    _renderCurrent() {
        const c   = this._data.current;
        const box = vbox('wp-current');

        const top = hbox('wp-current-top');
        top.add_child(label(c.icon, 'wp-cur-icon'));
        const right = vbox('wp-cur-right');
        right.add_child(label(c.temp, 'wp-cur-temp'));
        const descLbl = label(c.desc, 'wp-cur-desc');
        descLbl.clutter_text.line_wrap = true;
        descLbl.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        descLbl.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        right.add_child(descLbl);
        top.add_child(right);
        box.add_child(top);

        const grid = hbox('wp-detail-grid');
        [
            ['Feels like', c.feelsLike],
            ['Humidity',   c.humidity],
            ['Wind',       c.wind],
            ['Pressure',   c.pressure],
        ].forEach(([k, v]) => {
            const cell = vbox('wp-detail-cell');
            cell.add_child(label(k, 'wp-detail-key'));
            cell.add_child(label(v, 'wp-detail-val'));
            grid.add_child(cell);
        });
        box.add_child(grid);
        this._content.add_child(box);
    }

    _renderHourly() {
        const box = vbox('wp-hourly');

        const header = hbox('wp-hour-header-row');
        header.add_child(label('Time',     'wp-hour-time wp-col-header'));
        header.add_child(label('Sky',      'wp-hour-icon wp-col-header'));
        header.add_child(spacer());
        header.add_child(label('Humidity', 'wp-hour-humidity wp-col-header'));
        header.add_child(spacer());
        header.add_child(label('Temp',     'wp-hour-temp wp-col-header'));
        header.add_child(label('Precip',   'wp-hour-precip wp-col-header'));
        header.add_child(label('Wind',     'wp-hour-wind wp-col-header'));
        box.add_child(header);

        this._data.hourly.forEach(h => {
            const row = hbox('wp-hour-row');
            row.add_child(label(h.time,          'wp-hour-time'));
            row.add_child(label(h.icon,          'wp-hour-icon'));
            row.add_child(spacer());
            row.add_child(label(h.humidity,      'wp-hour-humidity'));
            row.add_child(spacer());
            row.add_child(label(h.temp,          'wp-hour-temp'));
            row.add_child(label(`💧${h.precip}`, 'wp-hour-precip'));
            row.add_child(label(h.wind ?? '--',  'wp-hour-wind'));
            box.add_child(row);
        });
        this._content.add_child(box);
    }

    _renderDaily() {
        const box = vbox('wp-daily');

        const header = hbox('wp-day-header-row');
        header.add_child(label('Day',      'wp-day-name wp-col-header'));
        header.add_child(label('Sky',      'wp-day-icon wp-col-header'));
        header.add_child(spacer());
        header.add_child(label('Humidity', 'wp-day-humidity wp-col-header'));
        header.add_child(spacer());
        header.add_child(label('Hi',       'wp-day-hi wp-col-header'));
        header.add_child(label(' / ',      'wp-day-sep wp-col-header'));
        header.add_child(label('Lo',       'wp-day-lo wp-col-header'));
        header.add_child(label('Precip',   'wp-day-precip wp-col-header'));
        header.add_child(label('Wind',     'wp-day-wind wp-col-header'));
        box.add_child(header);

        this._data.daily.forEach(d => {
            const row = hbox('wp-day-row');
            row.add_child(label(d.day,           'wp-day-name'));
            row.add_child(label(d.icon,          'wp-day-icon'));
            row.add_child(spacer());
            row.add_child(label(d.humidity,      'wp-day-humidity'));
            row.add_child(spacer());
            row.add_child(label(d.hi,            'wp-day-hi'));
            row.add_child(label(' / ',           'wp-day-sep'));
            row.add_child(label(d.lo,            'wp-day-lo'));
            row.add_child(label(`💧${d.precip}`, 'wp-day-precip'));
            row.add_child(label(d.wind ?? '--',  'wp-day-wind'));
            box.add_child(row);
        });
        this._content.add_child(box);
    }

    _renderAirQuality() {
        const aq  = this._data.airquality;
        const box = vbox('wp-allergens');

        if (aq.airnow && Object.keys(aq.airnow).length > 0) {
            const entries = Object.entries(aq.airnow);
            const worst   = entries.reduce(
                (max, [, v]) => v.aqi > max.aqi ? v : max,
                entries[0][1]
            );

            box.add_child(label('Overall AQI (AirNow / US EPA)', 'wp-section-title'));
            const overallRow = hbox('wp-allergen-row');
            overallRow.add_child(label('Air Quality', 'wp-allergen-name'));
            overallRow.add_child(spacer());
            const overallLbl = label(`${worst.aqi} — ${worst.category}`, 'wp-allergen-val');
            const overallColor = AQ_COLORS[worst.categoryNum];
            if (overallColor) overallLbl.set_style(`color: ${overallColor};`);
            overallRow.add_child(overallLbl);
            box.add_child(overallRow);

            box.add_child(label('By Pollutant (stations within 25 mi / 40 km)', 'wp-section-title'));
            entries.forEach(([param, obs]) => {
                const row = hbox('wp-allergen-row');
                row.add_child(label(PARAM_LABELS[param] ?? param, 'wp-allergen-name'));
                row.add_child(spacer());
                const valLbl = label(`${obs.aqi} — ${obs.category}`, 'wp-allergen-val');
                const color = AQ_COLORS[obs.categoryNum];
                if (color) valLbl.set_style(`color: ${color};`);
                row.add_child(valLbl);
                box.add_child(row);
            });
        } else if (aq.openweather) {
            const owm = aq.openweather;

            box.add_child(label('Overall AQI (OpenWeatherMap)', 'wp-section-title'));
            const overallRow = hbox('wp-allergen-row');
            overallRow.add_child(label('Air Quality', 'wp-allergen-name'));
            overallRow.add_child(spacer());
            const overallLbl = label(`${owm.aqi} — ${owm.category}`, 'wp-allergen-val');
            const overallColor = AQ_COLORS[owm.categoryNum];
            if (overallColor) overallLbl.set_style(`color: ${overallColor};`);
            overallRow.add_child(overallLbl);
            box.add_child(overallRow);

            box.add_child(label('Pollutant Concentrations (µg/m³)', 'wp-section-title'));
            // Order matters: PM and ozone are the headline pollutants in most
            // health guidance; trace gases (NO, NH3) come last.
            const order = ['pm2_5', 'pm10', 'o3', 'no2', 'so2', 'co', 'no', 'nh3'];
            order.forEach(k => {
                const v = owm.components?.[k];
                if (v == null) return;
                const row = hbox('wp-allergen-row');
                row.add_child(label(OWM_COMPONENT_LABELS[k] ?? k, 'wp-allergen-name'));
                row.add_child(spacer());
                const lvl = owmPollutantLevel(k, v);
                const valStr = lvl
                    ? `${v.toFixed(2)} µg/m³ — ${lvl.text}`
                    : `${v.toFixed(2)} µg/m³ — no standard`;
                const valLbl = label(valStr, 'wp-allergen-val');
                if (lvl?.color) valLbl.set_style(`color: ${lvl.color};`);
                row.add_child(valLbl);
                box.add_child(row);
            });
        } else {
            box.add_child(label('Air Quality', 'wp-section-title'));
            [
                ['PM 2.5', aq.pm25, 'µg/m³'],
                ['PM 10',  aq.pm10, 'µg/m³'],
            ].forEach(([name, val, unit]) => {
                const lvl = pm25Level(val);
                const row = hbox('wp-allergen-row');
                row.add_child(label(name, 'wp-allergen-name'));
                row.add_child(spacer());
                const valStr = val != null ? `${Math.round(val)} ${unit} — ${lvl.text}` : 'N/A';
                const valLbl = label(valStr, 'wp-allergen-val');
                if (lvl.color) valLbl.set_style(`color: ${lvl.color};`);
                row.add_child(valLbl);
                box.add_child(row);
            });
            const note = label('Add an AirNow (US only) or OpenWeatherMap (global) key in Preferences for full AQI data', 'wp-status');
            note.clutter_text.line_wrap = true;
            box.add_child(note);
        }

        this._content.add_child(box);
    }

    _renderAstronomy() {
        const a   = this._data.astronomy;
        const box = vbox('wp-astronomy');

        const sunGrid = hbox('wp-detail-grid');
        [
            ['🌞 Sunrise', a.sunrise],
            ['🌜 Sunset',  a.sunset],
        ].forEach(([k, v]) => {
            const cell = vbox('wp-detail-cell');
            cell.add_child(label(k, 'wp-detail-key'));
            cell.add_child(label(v ?? '--', 'wp-detail-val'));
            sunGrid.add_child(cell);
        });
        box.add_child(sunGrid);

        const moonGrid = hbox('wp-detail-grid');
        [
            ['🌙 Moonrise', a.moonrise],
            ['🌒 Moonset',  a.moonset],
        ].forEach(([k, v]) => {
            const cell = vbox('wp-detail-cell');
            cell.add_child(label(k, 'wp-detail-key'));
            cell.add_child(label(v ?? '--', 'wp-detail-val'));
            moonGrid.add_child(cell);
        });
        box.add_child(moonGrid);

        if (a.moonPhase || a.moonIllumination != null) {
            box.add_child(label('Moon Phase', 'wp-section-title'));
            const row = hbox('wp-astro-phase-row');
            row.add_child(label(moonPhaseIcon(a.moonPhase), 'wp-astro-phase-icon'));
            const right = vbox('wp-astro-phase-right');
            right.add_child(label(a.moonPhase ?? 'Unknown', 'wp-astro-phase-name'));
            if (a.moonIllumination != null)
                right.add_child(label(`${a.moonIllumination}% illuminated`, 'wp-astro-phase-illum'));
            row.add_child(right);
            box.add_child(row);
        }

        this._content.add_child(box);
    }
}

// ── WeatherIndicator (top-bar button) ────────────────────────────────────

const WeatherIndicator = GObject.registerClass(
class WeatherIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Weather Prime', false);
        this._ext      = extension;
        this._settings = extension.getSettings();
        this._timer    = null;
        this._lat      = null;
        this._lon      = null;
        this._locName  = '';
        this._busy     = false;

        this._cachedParsed = null;
        this._lastFetch    = 0;
        this._cachedAq     = null;
        this._lastAqFetch  = 0;

        // System interface settings for auto color-scheme detection
        try {
            this._ifaceSettings   = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            this._ifaceSettingsId = this._ifaceSettings.connect('changed::color-scheme',
                () => this._updateTheme());
        } catch {
            this._ifaceSettings = null;
        }

        // ── Pill (top bar) ────────────────────────────────────────────────
        const pill = hbox('wp-pill');
        pill.set_y_expand(true);
        pill.set_y_align(Clutter.ActorAlign.CENTER);

        this._pillIcon  = label('🌡️', 'wp-pill-icon');
        this._pillTemp  = label('--',  'wp-pill-temp');
        this._pillAlert = label('⚠',  'wp-pill-alert');
        this._pillAlert.hide();

        pill.add_child(this._pillIcon);
        pill.add_child(this._pillTemp);
        pill.add_child(this._pillAlert);
        this.add_child(pill);

        // ── Drop-down panel ───────────────────────────────────────────────
        this._panel = new WeatherPanel();
        this._panel.onRefresh(()  => this._fetch(true));
        this._panel.onSettings(() => this._ext.openPreferences());

        const section = new PopupMenu.PopupMenuSection();
        section.actor.add_child(this._panel.actor);
        this.menu.addMenuItem(section);

        this._menuSignalId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open) this._fetch(false);
        });

        this._settingsId = this._settings.connect('changed', () => {
            _session = null;
            this._cachedParsed = null;
            this._lastFetch    = 0;
            this._cachedAq     = null;
            this._lastAqFetch  = 0;
            this._updateTheme();
            this._restartTimer();
            this._fetch(true);
        });

        this._updateTheme();
        this._fetch(true);
        this._startTimer();
    }

    _updateTheme() {
        const pref = this._settings.get_string('color-scheme');
        let isLight;
        if (pref === 'light') {
            isLight = true;
        } else if (pref === 'dark') {
            isLight = false;
        } else {
            // auto: follow org.gnome.desktop.interface color-scheme
            try {
                isLight = this._ifaceSettings?.get_string('color-scheme') === 'prefer-light';
            } catch {
                isLight = false;
            }
        }
        if (isLight)
            this._panel.actor.add_style_class_name('wp-light');
        else
            this._panel.actor.remove_style_class_name('wp-light');

        const isLarge = this._settings.get_string('panel-size') === 'large';
        if (isLarge)
            this._panel.actor.add_style_class_name('wp-large');
        else
            this._panel.actor.remove_style_class_name('wp-large');
    }

    _startTimer() {
        const weatherMins = Math.max(5, this._settings.get_int('fetch-interval'));
        const aqMins      = Math.max(5, this._settings.get_int('aq-fetch-interval'));
        const secs = Math.min(weatherMins, aqMins) * 60;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._fetch(false);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _restartTimer() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = null; }
        this._startTimer();
    }

    async _resolveLocation() {
        if (!this._settings.get_boolean('location-auto')) {
            this._lat     = this._settings.get_double('location-latitude');
            this._lon     = this._settings.get_double('location-longitude');
            this._locName = this._settings.get_string('location-name') || 'Custom location';
            if (this._lat === 0 && this._lon === 0)
                throw new Error('No location set. Open Preferences to configure.');
            return;
        }

        await new Promise((resolve, reject) => {
            Geoclue.Simple.new('weather-prime', Geoclue.AccuracyLevel.CITY, null,
                async (_obj, result) => {
                    try {
                        const simple  = Geoclue.Simple.new_finish(result);
                        const loc     = simple.get_location();
                        this._lat     = loc.latitude;
                        this._lon     = loc.longitude;
                        this._locName = await reverseGeocode(this._lat, this._lon);
                        resolve();
                    } catch (e) {
                        const lat = this._settings.get_double('location-latitude');
                        const lon = this._settings.get_double('location-longitude');
                        if (lat !== 0 || lon !== 0) {
                            this._lat     = lat;
                            this._lon     = lon;
                            this._locName = this._settings.get_string('location-name') || 'Last known location';
                            resolve();
                        } else {
                            reject(new Error('Location unavailable. Set manually in Preferences.'));
                        }
                    }
                }
            );
        });
    }

    async _fetch(force = false) {
        if (this._busy) return;

        const now          = Date.now();
        const weatherMs    = Math.max(5, this._settings.get_int('fetch-interval')) * 60 * 1000;
        const aqMs         = Math.max(5, this._settings.get_int('aq-fetch-interval')) * 60 * 1000;
        const weatherFresh = !force && this._cachedParsed && (now - this._lastFetch) < weatherMs;
        const aqFresh      = !force && this._lastAqFetch > 0 && (now - this._lastAqFetch) < aqMs;

        if (weatherFresh && aqFresh) {
            if (this._locName) this._panel.setLocation(this._locName);
            this._panel.setData(this._cachedParsed);
            return;
        }

        this._busy = true;
        if (!weatherFresh) this._panel.setLoading();

        try {
            await this._resolveLocation();
            this._panel.setLocation(this._locName);

            const provider     = this._settings.get_string('api-provider');
            const unit         = this._settings.get_string('temperature-unit');
            const windUnit     = this._settings.get_string('wind-unit');
            const pressureUnit = this._settings.get_string('pressure-unit');
            const airnowKey    = this._settings.get_string('airnow-api-key').trim();
            const owmKey       = this._settings.get_string('openweather-api-key').trim();
            const aqSource     = this._settings.get_string('aq-source');

            // 'auto' tries AirNow first, then OWM. Explicit values pin one source.
            const tryAirnow = (aqSource === 'auto' || aqSource === 'airnow') && airnowKey;
            const tryOwm    = (aqSource === 'auto' || aqSource === 'openweather') && owmKey;

            let aqResult = aqFresh ? this._cachedAq : null;
            if (!aqFresh) {
                aqResult = { airnow: null, openweather: null };
                if (tryAirnow) {
                    aqResult.airnow = await fetchAirNow(this._lat, this._lon, airnowKey);
                }
                if (!aqResult.airnow && tryOwm) {
                    aqResult.openweather = await fetchOpenWeatherAirPollution(this._lat, this._lon, owmKey);
                }
                this._cachedAq    = aqResult;
                this._lastAqFetch = Date.now();
            }

            let parsed;
            if (weatherFresh) {
                parsed = this._cachedParsed;
                parsed.airquality.airnow      = aqResult.airnow;
                parsed.airquality.openweather = aqResult.openweather;
            } else {
                const waiKey = this._settings.get_string('weatherai-key').trim();

                const [aqData, alerts, waiAstroRaw] = await Promise.all([
                    fetchJSON(buildAirQualityUrl(this._lat, this._lon)).catch(() => null),
                    fetchAlerts(this._lat, this._lon),
                    waiKey
                        ? fetchWeatherAiAstronomy(this._lat, this._lon, waiKey).catch(e => {
                            console.error('[WeatherPrime] WeatherAI.io astronomy failed:', e.message);
                            return null;
                        })
                        : Promise.resolve(null),
                ]);

                if (provider === 'weatherapi') {
                    const key = this._settings.get_string('weatherapi-key').trim();
                    if (!key) throw new Error('WeatherAPI key missing — add it in Preferences.');
                    const raw = await fetchWeatherAPI(this._lat, this._lon, key);
                    parsed = parseWeatherAPI(raw, aqData, windUnit, pressureUnit, unit);
                } else {
                    const raw = await fetchJSON(buildOpenMeteoUrl(this._lat, this._lon, unit));
                    parsed = parseOpenMeteo(raw, aqData, windUnit, pressureUnit, unit);
                }

                if (waiAstroRaw) {
                    try {
                        parsed.astronomy = parseWeatherAiAstronomy(waiAstroRaw);
                    } catch (e) {
                        console.error('[WeatherPrime] WeatherAI astronomy parse error:', e.message);
                    }
                }

                parsed.alerts = alerts;
                parsed.airquality.airnow      = aqResult.airnow;
                parsed.airquality.openweather = aqResult.openweather;

                if (this._settings.get_boolean('location-auto')) {
                    this._settings.set_double('location-latitude',  this._lat);
                    this._settings.set_double('location-longitude', this._lon);
                    this._settings.set_string('location-name',      this._locName);
                }

                this._cachedParsed = parsed;
                this._lastFetch    = Date.now();
            }

            const alerts = parsed.alerts ?? [];
            this._pillIcon.set_text(parsed.current.icon);
            this._pillTemp.set_text(parsed.current.temp);
            if (alerts.length > 0) this._pillAlert.show();
            else                   this._pillAlert.hide();

            this._panel.setData(parsed);

        } catch (e) {
            this._panel.setError(e.message);
            this._pillIcon.set_text('⚠️');
            this._pillTemp.set_text('--');
            console.error('[WeatherPrime]', e.message);
        } finally {
            this._busy = false;
        }
    }

    destroy() {
        if (this._menuSignalId) {
            this.menu.disconnect(this._menuSignalId);
            this._menuSignalId = null;
        }
        if (this._timer)      { GLib.source_remove(this._timer); this._timer = null; }
        if (this._settingsId) { this._settings.disconnect(this._settingsId); this._settingsId = null; }
        if (this._ifaceSettings && this._ifaceSettingsId) {
            this._ifaceSettings.disconnect(this._ifaceSettingsId);
            this._ifaceSettings = null;
        }
        this._panel?.destroy();
        this._panel = null;
        super.destroy();
    }
});

// ── Extension entry point ─────────────────────────────────────────────────

export default class WeatherPrimeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._addIndicator();
        this._posChangedId = this._settings.connect('changed::panel-position',
            () => this._addIndicator());
    }

    _addIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._indicator = new WeatherIndicator(this);
        const pos = this._settings.get_string('panel-position');
        if (pos === 'left')
            Main.panel.addToStatusArea(this.uuid, this._indicator, 99, 'left');
        else if (pos === 'center')
            Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'center');
        else
            Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._posChangedId) {
            this._settings?.disconnect(this._posChangedId);
            this._posChangedId = null;
        }
        _session = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
