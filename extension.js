import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import Geoclue from 'gi://Geoclue';
import Pango from 'gi://Pango';
import Cairo from 'gi://cairo';

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

// Flip to true while developing to surface fetch/parse failures in journalctl.
// Shipped releases keep this false so the extension stays quiet per EGO's
// "no excessive logging" review guideline.
const DEBUG = false;
const logError = (...args) => { if (DEBUG) console.error(...args); };

// ── WMO weather code table ────────────────────────────────────────────────

// Weather-condition icons are Meteocons (static fill) slugs — the basenames of
// the SVGs bundled in icons/, rendered to colour St.Icons by weatherIcon().
// Codes that read differently by day vs night carry {day, night}; the rest a
// single {icon} (Meteocons has no day/night split for bare precipitation).
const WMO = {
    0:  {day: 'clear-day',          night: 'clear-night',          desc: 'Clear sky'},
    1:  {day: 'mostly-clear-day',   night: 'mostly-clear-night',   desc: 'Mainly clear'},
    2:  {day: 'partly-cloudy-day',  night: 'partly-cloudy-night',  desc: 'Partly cloudy'},
    3:  {day: 'overcast-day',       night: 'overcast-night',       desc: 'Overcast'},
    45: {day: 'fog-day',            night: 'fog-night',            desc: 'Fog'},
    48: {day: 'fog-day',            night: 'fog-night',            desc: 'Rime fog'},
    51: {icon: 'drizzle',       desc: 'Light drizzle'},
    53: {icon: 'drizzle',       desc: 'Drizzle'},
    55: {icon: 'drizzle',       desc: 'Dense drizzle'},
    56: {icon: 'sleet',         desc: 'Light freezing drizzle'},
    57: {icon: 'sleet',         desc: 'Freezing drizzle'},
    61: {icon: 'rain',          desc: 'Slight rain'},
    63: {icon: 'rain',          desc: 'Rain'},
    65: {icon: 'rain',          desc: 'Heavy rain'},
    66: {icon: 'sleet',         desc: 'Light freezing rain'},
    67: {icon: 'sleet',         desc: 'Freezing rain'},
    71: {icon: 'snow',          desc: 'Slight snow'},
    73: {icon: 'snow',          desc: 'Snowfall'},
    75: {icon: 'snow',          desc: 'Heavy snow'},
    77: {icon: 'snow',          desc: 'Snow grains'},
    80: {day: 'partly-cloudy-day-rain', night: 'partly-cloudy-night-rain', desc: 'Slight showers'},
    81: {icon: 'rain',          desc: 'Showers'},
    82: {icon: 'extreme-rain',  desc: 'Violent showers'},
    85: {day: 'partly-cloudy-day-snow', night: 'partly-cloudy-night-snow', desc: 'Slight snow showers'},
    86: {icon: 'snow',          desc: 'Heavy snow showers'},
    95: {icon: 'thunderstorms',      desc: 'Thunderstorm'},
    96: {icon: 'thunderstorms-hail', desc: 'Thunderstorm w/ hail'},
    99: {icon: 'thunderstorms-hail', desc: 'Thunderstorm w/ heavy hail'},
};

// Meteocons ships dedicated day/night art for every sky-dominant condition, so
// the old separate night-override table is gone: pick .night after dark when
// the code defines one, else fall back to the single icon.
function wmo(code, isDay = 1) {
    const base = WMO[code] ?? {icon: 'not-available', desc: 'Unknown'};
    const icon = (!isDay && base.night) ? base.night : (base.day ?? base.icon);
    return {icon, desc: base.desc};
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

// Visibility comes from the APIs in metres. Show miles for Fahrenheit users,
// kilometres otherwise; drop the decimal once we're past 10 (mi|km) for tidiness.
function fmtVisibility(meters, unit) {
    if (meters == null) return null;
    if (unit === 'fahrenheit') {
        const mi = meters / 1609.34;
        return `${mi >= 10 ? Math.round(mi) : mi.toFixed(1)} mi`;
    }
    const km = meters / 1000;
    return `${km >= 10 ? Math.round(km) : km.toFixed(1)} km`;
}

// Format a last-24h precipitation total. The unit tracks the temperature unit
// (inches when imperial, else millimetres) and matches the precipitation_unit
// the source request asked for, so no conversion happens here. Returns null for
// missing data so _renderCurrent omits the cell; 0 is shown ("0 in" = measured
// and dry, distinct from "we don't know").
function fmtPrecipTotal(total, unit) {
    if (total == null) return null;
    if (unit === 'fahrenheit') {
        if (total === 0)  return '0 in';
        if (total < 0.01) return '<0.01 in';
        return `${total.toFixed(2)} in`;
    }
    if (total === 0)  return '0 mm';
    if (total < 0.1)  return '<0.1 mm';
    return `${total.toFixed(1)} mm`;
}

// Format a last-24h snowfall total. This is snow *depth*, not liquid-water
// equivalent, so it reads much larger than the precip total (~7× at typical
// ratios) and uses its own unit: inches when imperial (same as precip), else
// centimetres (Open-Meteo reports snowfall in cm even though precipitation is
// mm — see buildOpenMeteoPrecip24hUrl). Returns null for missing or zero snow
// so the caller drops the line entirely; unlike precip there's no "0" state —
// no measurable snow simply means no snow line.
function fmtSnowTotal(total, unit) {
    if (total == null || total <= 0) return null;
    if (unit === 'fahrenheit') {
        if (total < 0.1) return '<0.1 in';
        return `${total.toFixed(1)} in`;
    }
    if (total < 0.1) return '<0.1 cm';
    return `${total.toFixed(1)} cm`;
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

// Format a Unix-epoch (seconds) radar frame timestamp as local "h:mmam/pm".
function radarFrameTime(epochSec) {
    const d  = new Date(epochSec * 1000);
    let h    = d.getHours();
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return `${h}:${mm}${ampm}`;
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

// TextDecoder is reusable and stateless across decode() calls; share one
// rather than allocating per response.
const _decoder = new TextDecoder();

let _session = null;
function getSession() {
    if (!_session)
        _session = new Soup.Session({
            user_agent:   'WeatherPrime/1.0',
            // Cap stalled connections so a hung endpoint surfaces as an error
            // instead of leaving _fetch()'s _busy guard latched forever.
            timeout:      30,
            idle_timeout: 30,
        });
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
                resolve(JSON.parse(_decoder.decode(bytes.get_data())));
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
            'is_day', 'wind_gusts_10m', 'dew_point_2m', 'visibility', 'cloud_cover',
        ].join(','),
        hourly:           'temperature_2m,relative_humidity_2m,weather_code,surface_pressure,precipitation_probability,wind_speed_10m,wind_direction_10m,is_day',
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

// Minimal Open-Meteo request for just the 7-day dominant wind directions.
// Used to backfill the daily forecast when the selected provider (e.g.
// WeatherAPI) omits a per-day wind direction.
function buildOpenMeteoDailyWindUrl(lat, lon) {
    const params = new URLSearchParams({
        latitude:      lat,
        longitude:     lon,
        daily:         'wind_direction_10m_dominant',
        timezone:      'auto',
        forecast_days: 7,
    });
    return `https://api.open-meteo.com/v1/forecast?${params}`;
}

// Minimal Open-Meteo request for the trailing 24h of hourly precipitation (24
// past hours + the current hour). Sources the Current tab's "Precip (24h, max nearby)"
// total for every provider: neither Open-Meteo's main forecast nor WeatherAPI's
// free forecast surfaces a prior-day precip sum, so this keyless call is the
// fallback for that one data point regardless of api-provider. Kept separate
// from the main request because past_hours there balloons the hourly array and
// past_days pollutes the 7-day forecast (see the parallel fetch in _fetch).
// precipitation_unit tracks the temperature unit so the sum needs no conversion.
// `snowfall` rides along so the Current tab can break out how much of that
// precipitation fell as snow — `precipitation` is liquid-water equivalent and
// would otherwise show a melted-down number with no hint it was snow. Note the
// two use different units: precipitation_unit=inch yields inches for both, but
// the metric default gives precipitation in mm and snowfall in cm.
function buildOpenMeteoPrecip24hUrl(lat, lon, unit) {
    const params = new URLSearchParams({
        latitude:           lat,
        longitude:          lon,
        hourly:             'precipitation,snowfall',
        timezone:           'auto',
        past_hours:         24,
        forecast_hours:     1,
        precipitation_unit: unit === 'fahrenheit' ? 'inch' : 'mm',
        // Query several models and let precip24hSeries take the per-hour max.
        // Open-Meteo's default best_match (GFS in the US) routinely zeroes out
        // convective rain that ECMWF/ICON captured — it will even report a 96%
        // precip *probability* alongside 0 *amount* — so a single model silently
        // under-reports real rainfall. Max-across-models means any model that
        // saw the storm still counts. Each model arrives as its own
        // `precipitation_<model>` array on the shared time axis.
        models:             'ecmwf_ifs025,icon_seamless,gfs_seamless',
        // UTC epochs, not local ISO strings: precip24hSeries compares against
        // the device clock, so an unanchored local timestamp would skew the
        // 24h window for a manually-set location in another timezone.
        timeformat:         'unixtime',
    });
    return `https://api.open-meteo.com/v1/forecast?${params}`;
}

// Builds a { 'YYYY-MM-DD': degrees } map from an Open-Meteo daily-wind
// response so callers can look up a direction by date string. Returns null
// when the response is missing or malformed.
function dailyWindDirMap(omWindRaw) {
    const d = omWindRaw?.daily;
    if (!d?.time) return null;
    const map = {};
    d.time.forEach((t, i) => { map[t] = d.wind_direction_10m_dominant?.[i] ?? null; });
    return map;
}

// The trailing-24h hourly precipitation and snowfall from a
// buildOpenMeteoPrecip24hUrl response, as two index-aligned per-hour arrays
// (oldest→newest): `precip` is liquid-water equivalent (rain + melted snow) in
// the request's unit, `snow` is snow depth (inches imperial, else cm). The
// Current tab sums `precip` for the displayed total and draws it as a
// sparkline, sums `snow` for a separate snowfall total, and uses each hour's
// `snow > 0` to colour snow hours in the sparkline.
//
// The request asks for several models, each arriving as its own
// `precipitation_<model>` / `snowfall_<model>` array on the shared time axis;
// we take the max across models per hour so a storm only some models captured
// isn't lost (best_match/GFS routinely zeroes out convective rain — see
// buildOpenMeteoPrecip24hUrl). Falls back to bare `precipitation`/`snowfall`
// keys for a single-model response.
//
// Times are unixtime (UTC epoch seconds); Open-Meteo stamps each hourly bucket
// with its start, so a value at time T covers T..T+1h and we keep buckets whose
// start is within the last 24h. An hour is kept if either variable reported a
// value (so the two arrays stay aligned); a missing one is filled with 0.
// Returns null when nothing is available (so the Current tab hides the block);
// an all-zero precip array means measured-but-dry.
function precip24hSeries(omRaw) {
    const t = omRaw?.hourly?.time;
    if (!Array.isArray(t)) return null;
    const pick = prefix => Object.keys(omRaw.hourly)
        .filter(k => k === prefix || k.startsWith(prefix + '_'))
        .map(k => omRaw.hourly[k])
        .filter(Array.isArray);
    const precipModels = pick('precipitation');
    const snowModels   = pick('snowfall');
    if (precipModels.length === 0 && snowModels.length === 0) return null;
    const maxAt = (models, i) => {
        let best = null;
        for (const m of models) {
            const v = m[i];
            if (v != null && (best === null || v > best)) best = v;
        }
        return best;
    };
    const now    = Date.now();
    const cutoff = now - 24 * 3600 * 1000;
    const precip = [];
    const snow   = [];
    for (let i = 0; i < t.length; i++) {
        const ms = t[i] * 1000;
        if (ms <= cutoff || ms > now) continue;
        const p = maxAt(precipModels, i);
        const s = maxAt(snowModels, i);
        if (p === null && s === null) continue;
        precip.push(p ?? 0);
        snow.push(s ?? 0);
    }
    return precip.length ? { precip, snow } : null;
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
        icon:     wmo(h.weather_code[hi + idx], h.is_day?.[hi + idx] ?? 1).icon,
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
            windGust:   c.wind_gusts_10m != null ? fmtWind(c.wind_gusts_10m, null, windUnit) : null,
            dewPoint:   c.dew_point_2m   != null ? fmt(c.dew_point_2m, unit) : null,
            visibility: fmtVisibility(c.visibility, unit),
            cloudCover: c.cloud_cover    != null ? `${Math.round(c.cloud_cover)}%` : null,
            icon:      wmo(c.weather_code, c.is_day ?? 1).icon,
            desc:      wmo(c.weather_code, c.is_day ?? 1).desc,
        },
        hourly,
        daily,
        astronomy: {
            sunrise:          formatTime(d.sunrise?.[0]),
            sunset:           formatTime(d.sunset?.[0]),
            moonrise:         null,
            moonset:          null,
            moonPhase:        null,
            moonIllumination: null,
        },
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
    const t  = condText.toLowerCase();
    const dn = (day, night) => (isDay ? day : night);
    if (t.includes('thunder'))                        return 'thunderstorms';
    if (t.includes('snow') || t.includes('blizzard')) return 'snow';
    if (t.includes('sleet') || t.includes('ice'))     return 'sleet';
    if (t.includes('rain') || t.includes('drizzle'))  return 'rain';
    if (t.includes('mist') || t.includes('fog'))      return dn('fog-day', 'fog-night');
    if (t.includes('overcast'))                       return dn('overcast-day', 'overcast-night');
    if (t.includes('cloud'))                          return dn('partly-cloudy-day', 'partly-cloudy-night');
    return dn('clear-day', 'clear-night');
}

function parseWeatherAPI(data, aqData, windUnit, pressureUnit, unit, dailyWindDirs = null) {
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

    // WeatherAPI's daily forecast has no dominant wind direction; backfill the
    // arrow from Open-Meteo (keyed by date) when a map is supplied.
    const daily = data.forecast.forecastday.map(day => ({
        day:      shortDay(day.date),
        hi:       `${Math.round(isF ? day.day.maxtemp_f : day.day.maxtemp_c)}°${isF ? 'F' : 'C'}`,
        lo:       `${Math.round(isF ? day.day.mintemp_f : day.day.mintemp_c)}°${isF ? 'F' : 'C'}`,
        icon:     wApiIcon(day.day.condition.text, 1),
        precip:   `${day.day.daily_chance_of_rain ?? 0}%`,
        humidity: day.day.avghumidity != null ? `${Math.round(day.day.avghumidity)}%` : '--',
        wind:     fmtWindShort(day.day.maxwind_mph, dailyWindDirs?.[day.date] ?? null, windUnit),
    }));

    const aqH = aqData?.hourly;
    let aqIdx = aqH ? aqH.time.findIndex(t => new Date(t) >= now) : -1;
    if (aqIdx < 0) aqIdx = 0;
    const aq = key => aqH?.[key]?.[aqIdx] ?? null;

    const trend = pressureTrend(allHours.map(h => h.pressure_mb), hi);

    const astro = data.forecast.forecastday?.[0]?.astro ?? {};

    return {
        current: {
            temp:      `${Math.round(isF ? c.temp_f : c.temp_c)}°${isF ? 'F' : 'C'}`,
            feelsLike: `${Math.round(isF ? c.feelslike_f : c.feelslike_c)}°${isF ? 'F' : 'C'}`,
            humidity:  `${c.humidity}%`,
            wind:      fmtWind(c.wind_mph, c.wind_dir, windUnit),
            pressure:  fmtPressure(c.pressure_mb, pressureUnit, trend),
            windGust:   c.gust_mph != null ? fmtWind(c.gust_mph, null, windUnit) : null,
            dewPoint:   (isF ? c.dewpoint_f : c.dewpoint_c) != null
                            ? fmt(isF ? c.dewpoint_f : c.dewpoint_c, unit) : null,
            visibility: c.vis_km != null ? fmtVisibility(c.vis_km * 1000, unit) : null,
            cloudCover: c.cloud != null ? `${c.cloud}%` : null,
            icon:      wApiIcon(c.condition.text, c.is_day),
            desc:      c.condition.text,
        },
        hourly,
        daily,
        astronomy: {
            sunrise:          formatTime(astro.sunrise),
            sunset:           formatTime(astro.sunset),
            moonrise:         formatTime(astro.moonrise),
            moonset:          formatTime(astro.moonset),
            moonPhase:        astro.moon_phase || null,
            moonIllumination: astro.moon_illumination != null && astro.moon_illumination !== ''
                                  ? parseInt(astro.moon_illumination, 10) : null,
        },
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

// ── USNO (US Naval Observatory, keyless) ──────────────────────────────────
// Free, no key, authoritative. Adds solar noon (the sun's upper transit) plus
// the dates of the next new and full moons — detail no weather provider gives.
// These shift by at most a minute or two a day, so USNO rides its own
// once-per-calendar-day schedule (see usnoDayKey) rather than the weather TTL;
// _fetch refreshes it on the first run of a new local day. Each call degrades
// to null independently; the Astronomy tab simply omits missing rows.

const USNO_BASE = 'https://aa.usno.navy.mil/api';
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fetchUsnoAstronomy(lat, lon) {
    const now  = new Date();
    const date = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    // USNO wants an east-positive UTC offset in hours (may be fractional). We
    // use the device's offset, which matches the location for auto-located
    // users; a manually-set distant location shows solar noon in device time.
    const tz   = -now.getTimezoneOffset() / 60;
    const oneday = new URLSearchParams({ date, coords: `${lat},${lon}`, tz: String(tz) });
    // Any 4 consecutive primary phases span a full cycle, so nump=4 always
    // yields exactly one New Moon and one Full Moon.
    const phases = new URLSearchParams({ date, nump: '4' });
    return Promise.all([
        fetchJSON(`${USNO_BASE}/rstt/oneday?${oneday}`).catch(() => null),
        fetchJSON(`${USNO_BASE}/moon/phases/date?${phases}`).catch(() => null),
    ]).catch(() => [null, null]);
}

// Format a USNO phase entry (UT year/month/day/time) as a local "Mon D" date.
function usnoPhaseDate(p) {
    if (!p) return null;
    const m  = String(p.time).match(/(\d{1,2}):(\d{2})/);
    const hh = m ? parseInt(m[1], 10) : 0;
    const mm = m ? parseInt(m[2], 10) : 0;
    const d  = new Date(Date.UTC(p.year, p.month - 1, p.day, hh, mm));
    return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}`;
}

function parseUsno(oneday, phases) {
    const out = { solarNoon: null, nextNewMoon: null, nextFullMoon: null };

    const sun = oneday?.properties?.data?.sundata;
    if (Array.isArray(sun)) {
        const noon = sun.find(s => s.phen === 'Upper Transit');
        if (noon?.time) out.solarNoon = formatTime(noon.time);
    }

    const pd = phases?.phasedata;
    if (Array.isArray(pd)) {
        out.nextNewMoon  = usnoPhaseDate(pd.find(p => p.phase === 'New Moon'));
        out.nextFullMoon = usnoPhaseDate(pd.find(p => p.phase === 'Full Moon'));
    }
    return out;
}

// Local calendar-day key; USNO is refetched only when this changes day to day.
function usnoDayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
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
        logError('[WeatherPrime] AirNow error:', e.message);
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
        logError('[WeatherPrime] OpenWeatherMap air pollution error:', e.message);
        return null;
    }
}

// ── Weather map (RainViewer + Esri satellite + roads/cities overlay) ─────
//
// Zoom strategy: the base/roads/cities are fetched as a 2×2 grid at z=MAP_ZOOM+1
// (4× pixel density across the same geographic area as one MAP_ZOOM tile, so
// the displayed image is crisper). RainViewer radar tops out at z=7, so the
// radar is fetched as a single tile at MAP_ZOOM and stretched across the full
// 2×2 area.

const MAP_ZOOM = 7;
const MAP_TILE_SIZE = 256;

// RainViewer publishes new radar frames every 10 minutes — polling more often
// just refetches the same data and is wasted on the provider's bandwidth.
const RADAR_MIN_INTERVAL_MIN = 10;

// Radar loop playback: each frame holds RADAR_FRAME_MS, then the most-recent
// frame holds RADAR_HOLD_MS so the current conditions linger before looping.
const RADAR_FRAME_MS = 500;
const RADAR_HOLD_MS  = 1500;

const MAP_WEBSITES = {
    'windy':        {label: 'Windy.com',      url: (lat, lon, z) => `https://www.windy.com/?radar,${lat},${lon},${z}`},
    'zoom-earth':   {label: 'Zoom Earth',     url: (lat, lon, z) => `https://zoom.earth/maps/radar/#view=${lat},${lon},${z}z`},
    'ventusky':     {label: 'Ventusky',       url: (lat, lon, z) => `https://www.ventusky.com/?p=${lat};${lon};${z}&l=radar`},
    'rainviewer':   {label: 'RainViewer',     url: (lat, lon, z) => `https://www.rainviewer.com/map.html?loc=${lat},${lon},${z}`},
    'weather-com':  {label: 'Weather.com',    url: (lat, lon)    => `https://weather.com/weather/radar/interactive/l/${lat},${lon}`},
    'wunderground': {label: 'Wunderground',   url: (lat, lon, z) => `https://www.wunderground.com/wundermap?lat=${lat}&lon=${lon}&zoom=${z}&radar=1`},
    'nws':          {label: 'NWS Radar (US)', url: ()            => 'https://radar.weather.gov/'},
};

function latLonToTile(lat, lon, zoom) {
    const n = 2 ** zoom;
    const x = Math.floor((lon + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const y = Math.floor(
        (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n
    );
    return {x: ((x % n) + n) % n, y: Math.max(0, Math.min(n - 1, y))};
}

function mapCacheDir() {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'weather-prime']);
    GLib.mkdir_with_parents(dir, 0o755);
    return dir;
}

function downloadToFile(url, destPath, headers = null) {
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
                const file = Gio.File.new_for_path(destPath);
                file.replace_contents(bytes.get_data(), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                resolve(destPath);
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Delete cached radar tiles that aren't part of the current frame set. The
// base/roads/places tiles are left alone (they rarely change and are keyed by
// position, not time); only the time-keyed rainviewer-*.png frames accumulate.
function pruneRadarCache(dir, keepPaths) {
    try {
        const keep = new Set(keepPaths.map(p => GLib.path_get_basename(p)));
        const d  = Gio.File.new_for_path(dir);
        const en = d.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null) {
            const name = info.get_name();
            if (name.startsWith('rainviewer-') && !keep.has(name)) {
                try { d.get_child(name).delete(null); } catch { /* ignore */ }
            }
        }
        en.close(null);
    } catch (e) {
        logError('[WeatherPrime] radar cache prune failed:', e.message);
    }
}

async function fetchMapTiles(lat, lon) {
    const meta    = await fetchJSON('https://api.rainviewer.com/public/weather-maps.json');
    const past    = meta?.radar?.past    ?? [];
    const nowcast = meta?.radar?.nowcast ?? [];
    if (past.length === 0) throw new Error('No radar frames available');

    // Fetch a 2×2 grid at MAP_ZOOM+1; geographically covers the same area as
    // one tile at MAP_ZOOM but at 2× the pixel density, so display scaling
    // becomes ~1:1 instead of 2× upscale.
    const tileZoom = MAP_ZOOM + 1;
    const {x: tx, y: ty} = latLonToTile(lat, lon, MAP_ZOOM);
    const x0 = tx * 2;
    const y0 = ty * 2;
    const dir = mapCacheDir();

    const cells = [];
    const downloads = [];

    for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
            const x = x0 + dx;
            const y = y0 + dy;

            const basePath   = GLib.build_filenamev([dir, `satellite-${tileZoom}-${x}-${y}.png`]);
            const roadsPath  = GLib.build_filenamev([dir, `roads-${tileZoom}-${x}-${y}.png`]);
            const placesPath = GLib.build_filenamev([dir, `places-${tileZoom}-${x}-${y}.png`]);

            // Esri ArcGIS tile services — note the {z}/{y}/{x} order (different from OSM).
            const baseUrl   = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${tileZoom}/${y}/${x}`;
            const roadsUrl  = `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/${tileZoom}/${y}/${x}`;
            const placesUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${tileZoom}/${y}/${x}`;

            if (!Gio.File.new_for_path(basePath).query_exists(null))
                downloads.push(downloadToFile(baseUrl, basePath, {'User-Agent': 'WeatherPrime/1.0'}));
            if (!Gio.File.new_for_path(roadsPath).query_exists(null))
                downloads.push(downloadToFile(roadsUrl, roadsPath, {'User-Agent': 'WeatherPrime/1.0'}));
            if (!Gio.File.new_for_path(placesPath).query_exists(null))
                downloads.push(downloadToFile(placesUrl, placesPath, {'User-Agent': 'WeatherPrime/1.0'}));

            cells.push({basePath, roadsPath, placesPath, col: dx, row: dy});
        }
    }

    // RainViewer caps radar at zoom 7, so each frame is a single z=MAP_ZOOM
    // tile covering the same geographic area as the 2×2 base grid. Past frames
    // first (oldest → newest), then nowcast so the loop runs into the forecast.
    const frameMeta = [
        ...past.map(f    => ({...f, kind: 'past'})),
        ...nowcast.map(f => ({...f, kind: 'nowcast'})),
    ];
    const frames = frameMeta.map(f => {
        const path = GLib.build_filenamev([dir, `rainviewer-${f.time}-${MAP_ZOOM}-${tx}-${ty}.png`]);
        const url  = `${meta.host}${f.path}/${MAP_TILE_SIZE}/${MAP_ZOOM}/${tx}/${ty}/2/1_1.png`;
        if (!Gio.File.new_for_path(path).query_exists(null))
            downloads.push(downloadToFile(url, path));
        return {path, time: f.time, kind: f.kind};
    });

    await Promise.all(downloads);
    pruneRadarCache(dir, frames.map(f => f.path));

    return {cells, frames, zoom: MAP_ZOOM};
}

// ── NWS weather alerts (US, free, no key) ────────────────────────────────

async function fetchAlerts(lat, lon) {
    try {
        const data = await fetchJSON(
            `https://api.weather.gov/alerts/active?point=${lat},${lon}`
        );
        return (data.features ?? []).map(f => ({
            event:       f.properties.event       ?? 'Alert',
            headline:    f.properties.headline    ?? '',
            desc:        f.properties.description  ?? '',
            instruction: f.properties.instruction ?? '',  // "Precautionary/Preparedness Actions"
            areaDesc:    f.properties.areaDesc     ?? '',
            sender:      f.properties.senderName   ?? '',
            severity:    f.properties.severity     ?? 'Unknown',
            urgency:     f.properties.urgency      ?? '',
            expires:     f.properties.expires      ?? '',  // ISO timestamp
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

// Absolute path to the bundled Meteocons icons/ directory, set in enable() from
// the extension install path (module-level so the helpers below can reach it
// without threading it through every WeatherPanel/indicator call site).
let ICON_DIR = null;

// Gio.FileIcon for a Meteocons slug (basename of a bundled SVG). Unknown/empty
// slugs fall back to the neutral 'not-available' glyph rather than a broken
// icon. Used both to build St.Icons and to swap the pill icon in place.
function iconGicon(slug) {
    return Gio.FileIcon.new(
        Gio.File.new_for_path(`${ICON_DIR}/${slug || 'not-available'}.svg`));
}

// Drop-down tab glyphs (current/hourly/daily) are nudged up by this many pixels. The
// Meteocons SVGs sit a touch low in their rows (vs. the emoji they replaced);
// translation_y shifts the painted icon without disturbing layout/spacing, which St
// CSS can't do (no transform property, and margins would only move it by an
// alignment-dependent fraction). The top-bar pill icons pass rise=0 — they sit
// centred in the pill at their original position without a nudge.
const ICON_RISE = 5;

// A colour St.Icon for a Meteocons slug. Size is left to CSS (the icon-size
// property on styleClass, with wp-medium/wp-large overrides) so icons track the
// panel-size setting the same way the old emoji labels did via font-size. rise is
// the upward translation_y nudge in pixels (pass 0 for the top-bar pill icons).
function weatherIcon(slug, styleClass = '', rise = ICON_RISE) {
    return new St.Icon({
        gicon: iconGicon(slug),
        style_class: styleClass,
        translation_y: -rise,
    });
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

// A bar sparkline of the trailing-24h hourly precipitation for the Current tab.
// `series` is the raw per-hour liquid-equivalent array from precip24hSeries
// (oldest→newest, same unit as the displayed total); bars are scaled to the
// wettest hour, so a dry day reads as a flat baseline rather than empty space.
// `height` is passed in by the caller so the sparkline tracks the panel-size
// setting. `opts.snow` is the aligned per-hour snow-depth array — any hour with
// snow > 0 is drawn in an icy tint instead of rain blue, so the type is visible
// at a glance (heights stay liquid-equivalent either way, one comparable scale).
// `opts.imperial`/`opts.light` set label precision and theme contrast. A top
// band is reserved for per-hour value labels. Drawn with Cairo via
// St.DrawingArea's repaint; the context must be disposed every paint.
function precipSparkline(series, height, opts = {}) {
    const { snow = null, imperial = false, light = false } = opts;
    const area = new St.DrawingArea({
        style_class: 'wp-precip-spark',
        x_expand:    true,
        height,
    });
    const max = series.reduce((m, v) => (v > m ? v : m), 0);
    const fmtLabel = v => (imperial ? v.toFixed(2) : v.toFixed(1));
    area.connect('repaint', () => {
        const cr = area.get_context();
        // get_context() should never be null inside repaint, but guard anyway:
        // a null here would otherwise make the finally's cr.$dispose() throw,
        // and an exception escaping a repaint handler crashes the shell's paint.
        if (!cr) return;
        const [w, h] = area.get_surface_size();
        try {
            if (!(w > 0) || series.length === 0) return;
            const n    = series.length;
            const slot = w / n;
            const bw   = Math.max(1, slot - 1);   // 1px gap between hours
            // Top band holds the value labels so bars never grow into the text;
            // sized off the sparkline height, which already tracks panel size.
            const fs     = Math.max(7, Math.round(h * 0.26));
            const labelH = fs + 2;
            const baseY  = h - 1;
            const barMax = Math.max(1, h - 2 - labelH);  // tallest a bar can grow
            // Faint baseline so an all-dry series still reads as "measured"
            // (dark band on a light panel, light band on a dark one).
            const base = light ? 0 : 1;
            cr.setSourceRGBA(base, base, base, 0.12);
            cr.rectangle(0, baseY, w, 1);
            cr.fill();
            if (max <= 0) return;
            // Rain blue vs. an icy tint for snow hours; per-theme so both stay
            // visible and distinct on the panel background. A 1.5px floor keeps a
            // trace of precip visible next to a heavy hour.
            const rainCol = light ? [0.18, 0.44, 0.82] : [0.42, 0.68, 1.0];
            const snowCol = light ? [0.30, 0.66, 0.80] : [0.78, 0.90, 1.0];
            for (let i = 0; i < n; i++) {
                const v = series[i];
                if (v <= 0) continue;
                const isSnow = Array.isArray(snow) && snow[i] > 0;
                const [r, g, b] = isSnow ? snowCol : rainCol;
                cr.setSourceRGBA(r, g, b, 0.9);
                const bh = Math.max(1.5, (v / max) * barMax);
                cr.rectangle(i * slot, baseY - bh, bw, bh);
                cr.fill();
            }
            // Per-hour value labels across the top band, placed greedily
            // left→right and skipped when they'd collide with the previous one,
            // so a few wet hours read cleanly while a wall-to-wall wet day thins
            // out instead of turning to mush.
            cr.selectFontFace('sans-serif', 0, 0);
            cr.setFontSize(fs);
            const fg = light ? [0.18, 0.20, 0.26] : [0.86, 0.88, 0.95];
            cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.95);
            let lastRight = -Infinity;
            for (let i = 0; i < n; i++) {
                const v = series[i];
                if (v <= 0) continue;
                const txt = fmtLabel(v);
                const tw  = cr.textExtents(txt).width;
                let x = i * slot + bw / 2 - tw / 2;
                x = Math.max(0, Math.min(x, w - tw));
                if (x < lastRight + 2) continue;   // would overlap the last label
                cr.moveTo(x, fs);
                cr.showText(txt);
                lastRight = x + tw;
            }
        } catch (e) {
            // Never let a draw error propagate out of the repaint signal into
            // Clutter's paint cycle — that would take down gnome-shell.
            logError('[WeatherPrime] precip sparkline repaint failed:', e.message);
        } finally {
            cr.$dispose();
        }
    });
    return area;
}

// ── WeatherPanel ──────────────────────────────────────────────────────────

class WeatherPanel {
    constructor() {
        this._data       = null;
        this._tab        = 'current';
        // Index into _data.alerts to show alone on the Alerts tab, or null for
        // all. Set when an alert in the banner is clicked; cleared by any tab
        // button (incl. the Alerts tab itself) and on panel close.
        this._alertFilter = null;
        this._refreshCb  = null;
        this._settingsCb = null;

        // Radar loop animation state (see _startMapAnimation).
        this._mapAnimId     = null;
        this._mapIcons      = null;
        this._mapFrames     = null;
        this._mapCaptionLbl = null;
        this._mapSite       = null;
        this._mapIndex      = 0;
        this._mapPlayBtn    = null;   // play/pause toggle on the Map tab
        this._mapUserPaused = true;   // paused by default; the loop plays only after the user hits ▶. Persists across re-renders
        this._mapRequestCb  = null;   // indicator hook to lazily fetch radar when the Map tab is viewed
        this._mapState      = 'loading';  // 'loading' | 'failed' — only shown while there are no tiles yet

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
            ['alerts',     '⚠'],
            ['current',    'Now'],
            ['hourly',     'Hourly'],
            ['daily',      '7-Day'],
            ['airquality', '🌬️ Air'],
            ['astronomy',  '🌙 Astro'],
            ['map',        '🗺️ Map'],
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
        this._tabBtns.alerts.hide();   // shown only when alerts are active
        // The Map tab stays visible; radar tiles load lazily on first view.
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

    _selectTab(id, alertFilter = null) {
        // Default null clears the filter, so a direct Alerts-tab click — even
        // while it is already active — reverts to showing all alerts. Only the
        // banner passes a specific index.
        this._alertFilter = alertFilter;
        this._tab = id;
        Object.entries(this._tabBtns).forEach(([tid, btn]) => {
            if (tid === id) btn.add_style_class_name('active');
            else            btn.remove_style_class_name('active');
        });
        if (id === 'hourly' || id === 'map') {
            this._scroll.add_style_class_name('wp-scroll-tall');
        } else {
            this._scroll.remove_style_class_name('wp-scroll-tall');
        }
        if (id === 'airquality') {
            this._scroll.add_style_class_name('wp-scroll-auto');
        } else {
            this._scroll.remove_style_class_name('wp-scroll-auto');
        }
        this._render();
        // Selecting the Map tab triggers a lazy radar fetch (no-op if fresh).
        if (id === 'map') this._mapRequestCb?.();
    }

    destroy() {
        this._stopMapAnimation();
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
    onMapRequest(cb) { this._mapRequestCb = cb; }

    get activeTab() { return this._tab; }

    // Status shown on the Map tab while radar loads lazily: 'loading' shows a
    // spinner, 'failed' shows the unavailable message. Once tiles arrive, the
    // indicator delivers them via setData and the message is replaced.
    setMapStatus(status) {
        this._mapState = status;
        if (this._tab === 'map') this._render();
    }

    // Re-render the current tab. Needed when panel-size changes, since the Map
    // tab sizes its tiles in JS from the active size class rather than via CSS.
    relayout() { this._render(); }

    // Called when the menu closes so the next open shows all alerts rather than
    // a stale single-alert filter. No re-render needed — the panel is hidden and
    // the next open's setData() re-renders.
    resetAlertFilter() { this._alertFilter = null; }

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

    setData(data, render = true) {
        this._data = data;
        // Background refreshes land while the menu is closed; storing the data
        // is enough then. The panel is rebuilt when the menu opens (open-state-
        // changed → _fetch → setData with render=true), so skipping the full
        // destroy_all_children/rebuild here avoids wasted work nobody can see.
        if (!render) return;
        const alerts = data.alerts ?? [];
        this._renderAlertsBanner(alerts);
        if (alerts.length) {
            this._tabBtns.alerts?.show();
            // Widen the panel (see .wp-has-alerts rules) so the extra tab fits
            // and the long NWS description text wraps onto fewer lines.
            this.actor.add_style_class_name('wp-has-alerts');
        } else {
            this._tabBtns.alerts?.hide();
            this.actor.remove_style_class_name('wp-has-alerts');
            if (this._tab === 'alerts') this._selectTab('current');
        }
        const a = data.astronomy;
        const hasAstro = !!a && (a.sunrise || a.sunset || a.moonrise || a.moonset ||
                                 a.moonPhase || a.moonIllumination != null ||
                                 a.solarNoon || a.nextNewMoon || a.nextFullMoon);
        if (hasAstro) {
            this._tabBtns.astronomy?.show();
        } else {
            this._tabBtns.astronomy?.hide();
            if (this._tab === 'astronomy') this._selectTab('current');
        }
        // The Map tab is always available; radar tiles are fetched lazily when
        // the tab is first viewed (see WeatherIndicator._ensureMap).
        this._tabBtns.map?.show();
        const dayCount = data.daily?.length ?? 7;
        if (this._tabBtns.daily) this._tabBtns.daily.label = `${dayCount}-Day`;
        this._render();
    }

    setMapWebsite(siteKey) {
        this._mapWebsite = siteKey;
        if (this._tab === 'map') this._render();
    }

    _renderAlertsBanner(alerts) {
        this._alertsBanner.destroy_all_children();
        if (!alerts.length) { this._alertsBanner.hide(); return; }
        this._alertsBanner.show();
        alerts.forEach((a, idx) => {
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
            item.add_child(label('Read full text →', 'wp-alert-more'));
            // Wrap each item in a button so clicking it opens the Alerts tab,
            // where the full description and instructions are shown.
            const btn = new St.Button({
                child:       item,
                style_class: 'wp-alert-button',
                reactive:    true,
                can_focus:   true,
                x_expand:    true,
            });
            const sid = btn.connect('clicked', () => this._selectTab('alerts', idx));
            btn.connect('destroy', () => btn.disconnect(sid));
            this._alertsBanner.add_child(btn);
        });
    }

    _render() {
        this._stopMapAnimation();   // frame icons are about to be destroyed
        this._content.destroy_all_children();
        if (!this._data) return;
        switch (this._tab) {
        case 'alerts':     this._renderAlerts();     break;
        case 'current':    this._renderCurrent();    break;
        case 'hourly':     this._renderHourly();     break;
        case 'daily':      this._renderDaily();      break;
        case 'airquality': this._renderAirQuality(); break;
        case 'astronomy':  this._renderAstronomy();  break;
        case 'map':        this._renderMap();        break;
        }
    }

    _renderAlerts() {
        const all = this._data.alerts ?? [];
        // A banner click filters to a single alert; a direct tab click clears
        // the filter. Guard the index against a data refresh that shrank the list.
        const filtered = this._alertFilter != null && this._alertFilter < all.length;
        const alerts = filtered ? [all[this._alertFilter]] : all;
        const box = vbox('wp-alerts');

        // NWS descriptions are multi-paragraph; preserve their embedded
        // newlines and wrap long lines rather than ellipsizing.
        const wrapLabel = (text, cls) => {
            const l = label(text, cls);
            l.clutter_text.line_wrap      = true;
            l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            l.clutter_text.ellipsize      = Pango.EllipsizeMode.NONE;
            return l;
        };

        alerts.forEach(a => {
            const card = vbox('wp-alert-card');
            card.add_child(wrapLabel(`⚠ ${a.event}`, 'wp-alert-card-event'));

            const meta = [];
            if (a.severity && a.severity !== 'Unknown') meta.push(a.severity);
            if (a.urgency  && a.urgency  !== 'Unknown') meta.push(a.urgency);
            if (a.areaDesc)                             meta.push(a.areaDesc);
            if (meta.length)
                card.add_child(wrapLabel(meta.join(' • '), 'wp-alert-card-meta'));
            if (a.expires) {
                const exp = new Date(a.expires);
                if (!isNaN(exp))
                    card.add_child(wrapLabel(`Expires ${exp.toLocaleString()}`, 'wp-alert-card-meta'));
            }

            if (a.headline)
                card.add_child(wrapLabel(a.headline, 'wp-alert-card-headline'));
            if (a.desc)
                card.add_child(wrapLabel(a.desc, 'wp-alert-card-desc'));
            if (a.instruction) {
                card.add_child(label('Precautionary / Preparedness Actions', 'wp-section-title'));
                card.add_child(wrapLabel(a.instruction, 'wp-alert-card-desc'));
            }
            if (a.sender)
                card.add_child(wrapLabel(a.sender, 'wp-alert-card-sender'));

            box.add_child(card);
        });

        this._content.add_child(box);
    }

    _renderCurrent() {
        const c   = this._data.current;
        const box = vbox('wp-current');

        const top = hbox('wp-current-top');
        top.add_child(weatherIcon(c.icon, 'wp-cur-icon'));
        const right = vbox('wp-cur-right');
        right.add_child(label(c.temp, 'wp-cur-temp'));
        const descLbl = label(c.desc, 'wp-cur-desc');
        descLbl.clutter_text.line_wrap = true;
        descLbl.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        descLbl.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        right.add_child(descLbl);
        top.add_child(right);
        box.add_child(top);

        // First four are always present; the rest depend on what the active
        // provider returns. Lay out four-per-row, padding the final row with
        // transparent spacers so the columns stay aligned.
        const cells = [
            ['Feels like',  c.feelsLike],
            ['Humidity',    c.humidity],
            ['Wind',        c.wind],
            ['Pressure',    c.pressure],
            ['Gusts',       c.windGust],
            ['Dew point',   c.dewPoint],
            ['Visibility',  c.visibility],
            ['Cloud',       c.cloudCover],
        ].filter(([, v]) => v != null);

        const grid = vbox('wp-detail-grid');
        const COLS = 4;
        for (let i = 0; i < cells.length; i += COLS) {
            const row = hbox('wp-detail-row');
            const slice = cells.slice(i, i + COLS);
            slice.forEach(([k, v]) => {
                const cell = vbox('wp-detail-cell');
                cell.add_child(label(k, 'wp-detail-key'));
                cell.add_child(label(v, 'wp-detail-val'));
                row.add_child(cell);
            });
            for (let p = slice.length; p < COLS; p++)
                row.add_child(spacer());
            grid.add_child(row);
        }
        box.add_child(grid);

        // Last-24h precipitation gets its own full-width block below the grid so
        // the hourly sparkline has room to breathe (a single grid cell is too
        // narrow for 24 bars). Hidden when the side fetch gave nothing
        // (precip24h null); a measured-but-dry day still shows ("0 in" with a
        // flat baseline).
        if (c.precip24h != null) {
            const pBox  = vbox('wp-precip24h');
            const pHead = hbox('wp-precip24h-head');
            pHead.add_child(label('Precip (Past 24h, max nearby)', 'wp-detail-key'));
            pHead.add_child(spacer());
            pHead.add_child(label(c.precip24h, 'wp-detail-val'));
            pBox.add_child(pHead);
            // When some of that precip fell as snow, break out the snow depth on
            // its own line: the precip total above is liquid-water equivalent, so
            // a heavy snow shows as a small number there. Different unit (in/cm),
            // and only shown when there was measurable snow (snow24h null otherwise).
            if (c.snow24h) {
                const sHead = hbox('wp-precip24h-head');
                sHead.add_child(label('❄️ Snowfall (Past 24h)', 'wp-detail-key'));
                sHead.add_child(spacer());
                sHead.add_child(label(c.snow24h, 'wp-detail-val'));
                pBox.add_child(sHead);
            }
            if (Array.isArray(c.precip24hSeries) && c.precip24hSeries.length) {
                const sparkH = this.actor.has_style_class_name('wp-large')  ? 48
                             : this.actor.has_style_class_name('wp-medium') ? 40
                             : 32;
                pBox.add_child(precipSparkline(c.precip24hSeries, sparkH, {
                    snow:     c.snow24hSeries,
                    imperial: c.precip24hImperial,
                    light:    this.actor.has_style_class_name('wp-light'),
                }));
            }
            box.add_child(pBox);
        }

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
            row.add_child(weatherIcon(h.icon, 'wp-hour-icon'));
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
        const sepHdr = label(' / ',        'wp-day-sep wp-col-header');
        sepHdr.clutter_text.ellipsize = Pango.EllipsizeMode.NONE; // never collapse to "…"
        header.add_child(sepHdr);
        header.add_child(label('Lo',       'wp-day-lo wp-col-header'));
        header.add_child(label('Precip',   'wp-day-precip wp-col-header'));
        header.add_child(label('Wind',     'wp-day-wind wp-col-header'));
        box.add_child(header);

        this._data.daily.forEach(d => {
            const row = hbox('wp-day-row');
            row.add_child(label(d.day,           'wp-day-name'));
            row.add_child(weatherIcon(d.icon, 'wp-day-icon'));
            row.add_child(spacer());
            row.add_child(label(d.humidity,      'wp-day-humidity'));
            row.add_child(spacer());
            row.add_child(label(d.hi,            'wp-day-hi'));
            const sep = label(' / ',             'wp-day-sep');
            sep.clutter_text.ellipsize = Pango.EllipsizeMode.NONE; // never collapse to "…"
            row.add_child(sep);
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

    _renderMap() {
        const m   = this._data.map;
        const box = vbox('wp-map');
        if (!m) {
            const msg = this._mapState === 'failed' ? 'Map unavailable.' : 'Loading map…';
            box.add_child(label(msg, 'wp-status'));
            this._content.add_child(box);
            return;
        }

        const siteKey = this._mapWebsite ?? 'windy';
        const site    = MAP_WEBSITES[siteKey] ?? MAP_WEBSITES['windy'];
        const lat     = this._data.lat;
        const lon     = this._data.lon;

        const tileDisplay = this.actor.has_style_class_name('wp-large')  ? 510
                          : this.actor.has_style_class_name('wp-medium') ? 425
                          : 340;
        const cellSize = Math.floor(tileDisplay / 2);

        const grid = new St.BoxLayout({
            vertical:    true,
            style_class: 'wp-map-stack',
            x_align:     Clutter.ActorAlign.CENTER,
        });
        for (let row = 0; row < 2; row++) {
            const rowBox = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
            for (let col = 0; col < 2; col++) {
                const cell = m.cells.find(c => c.col === col && c.row === row);
                const stack = new St.Widget({layout_manager: new Clutter.BinLayout()});
                stack.add_child(new St.Icon({
                    gicon:     Gio.FileIcon.new(Gio.File.new_for_path(cell.basePath)),
                    icon_size: cellSize,
                }));
                stack.add_child(new St.Icon({
                    gicon:     Gio.FileIcon.new(Gio.File.new_for_path(cell.roadsPath)),
                    icon_size: cellSize,
                }));
                stack.add_child(new St.Icon({
                    gicon:     Gio.FileIcon.new(Gio.File.new_for_path(cell.placesPath)),
                    icon_size: cellSize,
                }));
                rowBox.add_child(stack);
            }
            grid.add_child(rowBox);
        }

        // Each radar frame is a single z=MAP_ZOOM tile geographically matching
        // the 2×2 base grid; stretch it across the whole map. All frames are
        // stacked, only the current one visible — the animation timer flips
        // visibility to play the loop without re-decoding images on every tick.
        const mapStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_align:        Clutter.ActorAlign.CENTER,
        });
        mapStack.add_child(grid);

        const frames     = m.frames ?? [];
        const lastIdx    = frames.length - 1;
        const frameIcons = frames.map((f, i) => {
            const icon = new St.Icon({
                gicon:     Gio.FileIcon.new(Gio.File.new_for_path(f.path)),
                icon_size: tileDisplay,
                opacity:   200,
                visible:   i === lastIdx,   // most-recent frame as the resting view
            });
            mapStack.add_child(icon);
            return icon;
        });

        const button = new St.Button({
            child:       mapStack,
            style_class: 'wp-map-button',
            reactive:    true,
            can_focus:   true,
            x_align:     Clutter.ActorAlign.CENTER,
        });
        const url = site.url(lat, lon, m.zoom);
        const sid = button.connect('clicked', () => {
            try { Gio.AppInfo.launch_default_for_uri(url, null); }
            catch (e) { logError('[WeatherPrime] open map URL failed:', e.message); }
        });
        button.connect('destroy', () => button.disconnect(sid));
        box.add_child(button);

        // Play/pause toggle — only meaningful when there's a loop to control.
        let playBtn = null;
        if (frames.length > 1) {
            const controls = new St.BoxLayout({
                style_class: 'wp-map-controls',
                x_align:     Clutter.ActorAlign.CENTER,
            });
            playBtn = new St.Button({
                style_class: 'wp-map-ctrl',
                label:       this._mapUserPaused ? '▶' : '⏸',
                can_focus:   true,
            });
            const pid = playBtn.connect('clicked', () => this._toggleMapPlay());
            playBtn.connect('destroy', () => playBtn.disconnect(pid));
            controls.add_child(playBtn);
            box.add_child(controls);
        }

        const captionLbl = label('', 'wp-map-caption');
        captionLbl.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(captionLbl);

        this._content.add_child(box);

        // Drives the loop and keeps the caption in sync with the shown frame.
        this._startMapAnimation(frameIcons, frames, captionLbl, site, lastIdx, playBtn);
    }

    // ── Radar loop animation ──────────────────────────────────────────────
    // Cycles the stacked frame icons oldest → newest, pausing on the latest.
    // A self-rescheduling timeout (rather than a fixed-interval one) lets the
    // final frame hold longer than the rest.

    _mapCaptionText(i) {
        const f = this._mapFrames?.[i];
        if (!f) return '';
        const tag = f.kind === 'nowcast' ? ' (forecast)' : '';
        return `Radar ${radarFrameTime(f.time)}${tag} — tap to open in ${this._mapSite.label}`;
    }

    _showMapFrame(i) {
        this._mapIcons.forEach((icon, idx) => { icon.visible = idx === i; });
        this._mapCaptionLbl?.set_text(this._mapCaptionText(i));
    }

    _scheduleMapFrame() {
        const delay = this._mapIndex === this._mapIcons.length - 1
            ? RADAR_HOLD_MS : RADAR_FRAME_MS;
        this._mapAnimId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._mapAnimId = null;
            this._mapIndex  = (this._mapIndex + 1) % this._mapIcons.length;
            this._showMapFrame(this._mapIndex);
            this._scheduleMapFrame();
            return GLib.SOURCE_REMOVE;
        });
    }

    _startMapAnimation(frameIcons, frames, captionLbl, site, restingIdx, playBtn) {
        this._stopMapAnimation();
        this._mapSite       = site;
        this._mapFrames     = frames;
        this._mapCaptionLbl = captionLbl;
        this._mapPlayBtn    = playBtn ?? null;
        if (!frameIcons || frameIcons.length === 0) return;
        this._mapIcons = frameIcons;
        this._updateMapPlayBtn();
        if (frameIcons.length === 1 || this._mapUserPaused) {
            // Nothing to animate, or the user paused: rest on the latest frame.
            this._mapIndex = restingIdx;
            this._showMapFrame(restingIdx);
            return;
        }
        this._mapIndex = 0;
        this._showMapFrame(0);
        this._scheduleMapFrame();
    }

    // Stop and forget the loop — call before the frame icons are destroyed.
    // Leaves _mapUserPaused intact so the preference survives a re-render.
    _stopMapAnimation() {
        if (this._mapAnimId) { GLib.source_remove(this._mapAnimId); this._mapAnimId = null; }
        this._mapIcons      = null;
        this._mapFrames     = null;
        this._mapCaptionLbl = null;
        this._mapSite       = null;
        this._mapPlayBtn    = null;
    }

    // Play/pause button handler: flip the user preference and the timer to match.
    _toggleMapPlay() {
        this._mapUserPaused = !this._mapUserPaused;
        if (this._mapUserPaused) {
            if (this._mapAnimId) { GLib.source_remove(this._mapAnimId); this._mapAnimId = null; }
        } else if (!this._mapAnimId && this._mapIcons && this._mapIcons.length > 1) {
            this._scheduleMapFrame();
        }
        this._updateMapPlayBtn();
    }

    _updateMapPlayBtn() {
        if (this._mapPlayBtn) this._mapPlayBtn.label = this._mapUserPaused ? '▶' : '⏸';
    }

    // Halt playback without dropping the frame references (menu closed).
    // Does not touch _mapUserPaused — this is incidental, not a user pause.
    pauseMap() {
        if (this._mapAnimId) { GLib.source_remove(this._mapAnimId); this._mapAnimId = null; }
    }

    // Resume playback if we're still on the map tab with frames intact and the
    // user hasn't explicitly paused.
    resumeMap() {
        if (this._tab === 'map' && this._mapIcons && this._mapIcons.length > 1
            && !this._mapAnimId && !this._mapUserPaused)
            this._scheduleMapFrame();
    }

    _renderAstronomy() {
        const a   = this._data.astronomy;
        const box = vbox('wp-astronomy');

        const addGrid = cells => {
            const present = cells.filter(([, v]) => v != null);
            if (!present.length) return;
            const grid = hbox('wp-detail-grid');
            present.forEach(([k, v]) => {
                const cell = vbox('wp-detail-cell');
                cell.add_child(label(k, 'wp-detail-key'));
                cell.add_child(label(v, 'wp-detail-val'));
                grid.add_child(cell);
            });
            box.add_child(grid);
        };

        addGrid([
            ['🌞 Sunrise',    a.sunrise],
            ['☀️ Solar Noon', a.solarNoon],
            ['🌜 Sunset',     a.sunset],
        ]);
        addGrid([
            ['🌙 Moonrise', a.moonrise],
            ['🌒 Moonset',  a.moonset],
        ]);

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

        if (a.nextNewMoon || a.nextFullMoon) {
            box.add_child(label('Upcoming', 'wp-section-title'));
            addGrid([
                ['🌑 New Moon',  a.nextNewMoon],
                ['🌕 Full Moon', a.nextFullMoon],
            ]);
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
        this._destroyed = false; // set in destroy(); guards async continuations after teardown
        this._geoclue  = null;   // cached GeoClue client, created once and reused
        this._geoLat   = null;   // coords of the last reverse-geocode; skip re-geocoding when unchanged
        this._geoLon   = null;
        this._mapBusy  = false;  // guards the lazy radar fetch

        this._cachedParsed = null;
        this._lastFetch    = 0;
        this._cachedAq     = null;
        this._lastAqFetch  = 0;
        this._cachedMap    = null;
        this._lastMapFetch = 0;
        this._cachedUsno   = null;   // USNO astronomy, refreshed at most once per calendar day
        this._lastUsnoDay  = null;   // usnoDayKey() of the last successful USNO fetch
        this._cachedLat    = null;
        this._cachedLon    = null;

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

        this._pillIcon  = weatherIcon('thermometer', 'wp-pill-icon', 0);
        this._pillTemp  = label('--',  'wp-pill-temp');
        this._pillAlert = weatherIcon('code-orange', 'wp-pill-alert', 0);
        this._pillAlert.hide();

        // The pill's height is set by the tallest child (the icon), so center
        // each child on the cross axis — otherwise the shorter temp label rides
        // high instead of lining up with the icon. A horizontal St.BoxLayout
        // does not propagate y_align to its children, so set it per child.
        this._pillIcon.set_y_align(Clutter.ActorAlign.CENTER);
        this._pillTemp.set_y_align(Clutter.ActorAlign.CENTER);
        this._pillAlert.set_y_align(Clutter.ActorAlign.CENTER);

        pill.add_child(this._pillIcon);
        pill.add_child(this._pillTemp);
        pill.add_child(this._pillAlert);
        this.add_child(pill);

        // ── Drop-down panel ───────────────────────────────────────────────
        this._panel = new WeatherPanel();
        this._panel.onRefresh(()  => { this._fetch(true); this._ensureMap(); });
        this._panel.onSettings(() => this._ext.openPreferences());
        this._panel.onMapRequest(() => this._ensureMap());
        this._panel.setMapWebsite(this._settings.get_string('map-website'));

        const section = new PopupMenu.PopupMenuSection();
        section.actor.add_child(this._panel.actor);
        this.menu.addMenuItem(section);

        this._menuSignalId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open) { this._fetch(false); this._ensureMap(); this._panel.resumeMap(); }
            else      { this._panel.pauseMap(); this._panel.resetAlertFilter(); }
        });

        this._settingsId = this._settings.connect('changed', (_s, key) => {
            // In auto mode _fetch() writes the resolved coords/name back to
            // these keys as a cache. Those self-writes must not wipe the caches
            // and trigger a second full fetch. Manual location edits happen only
            // when location-auto is off, so this never suppresses user intent.
            if ((key === 'location-latitude' || key === 'location-longitude' ||
                 key === 'location-name') &&
                this._settings.get_boolean('location-auto'))
                return;

            // Purely visual keys never need a network refetch — restyle in place
            // rather than dropping caches and re-downloading everything.
            if (key === 'map-website') {
                this._panel.setMapWebsite(this._settings.get_string('map-website'));
                return;
            }
            // panel-position is owned by the extension-level handler, which
            // reparents the indicator's container between panel boxes. It needs
            // no restyle or refetch here — the data and theme are unaffected.
            if (key === 'panel-position') return;

            if (key === 'color-scheme' || key === 'panel-size') {
                this._updateTheme();
                if (key === 'panel-size') this._panel.relayout();
                return;
            }

            // Everything else affects the fetched data: drop caches and refetch.
            // The Soup.Session is intentionally kept — its config is static, so
            // reusing it preserves keep-alive connections across the refetch.
            this._cachedParsed = null;
            this._lastFetch    = 0;
            this._cachedAq     = null;
            this._lastAqFetch  = 0;
            this._cachedMap    = null;
            this._lastMapFetch = 0;
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

        const panelSize = this._settings.get_string('panel-size');
        if (panelSize === 'large') {
            this._panel.actor.add_style_class_name('wp-large');
            this._panel.actor.remove_style_class_name('wp-medium');
        } else if (panelSize === 'medium') {
            this._panel.actor.add_style_class_name('wp-medium');
            this._panel.actor.remove_style_class_name('wp-large');
        } else {
            this._panel.actor.remove_style_class_name('wp-large');
            this._panel.actor.remove_style_class_name('wp-medium');
        }
    }

    _startTimer() {
        const weatherMins = Math.max(5, this._settings.get_int('fetch-interval'));
        const aqMins      = Math.max(5, this._settings.get_int('aq-fetch-interval'));
        // Radar is fetched lazily when the Map tab is viewed, so it no longer
        // drives the background timer — only weather and air quality do.
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
            // Forget the last reverse-geocoded coords so that re-enabling auto
            // always re-geocodes. Otherwise a return to a previously-seen
            // GeoClue spot would hit the throttle below and keep the manual
            // city's name in _locName.
            this._geoLat = this._geoLon = null;
            if (this._lat === 0 && this._lon === 0)
                throw new Error('No location set. Open Preferences to configure.');
            return;
        }

        // Create the GeoClue client once and reuse it across fetches. A fresh
        // client per fetch churns D-Bus every refresh and leaves teardown to GC;
        // GClueSimple instead pushes location updates into the cached object.
        if (!this._geoclue) {
            this._geoclue = await new Promise(resolve => {
                // If geoclue never calls back, resolve null after 15s so _fetch
                // falls back to last-known coords rather than hanging forever.
                let settled = false;
                const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
                    if (!settled) {
                        settled = true;
                        logError('[WeatherPrime] GeoClue init timed out');
                        resolve(null);
                    }
                    return GLib.SOURCE_REMOVE;
                });
                Geoclue.Simple.new('weather-prime', Geoclue.AccuracyLevel.CITY, null,
                    (_obj, result) => {
                        if (settled) return;
                        settled = true;
                        GLib.source_remove(timeoutId);
                        try { resolve(Geoclue.Simple.new_finish(result)); }
                        catch (e) { logError('[WeatherPrime] GeoClue init failed:', e.message); resolve(null); }
                    });
            });
            // destroy() can run during the await above; at that point _geoclue
            // is still null so destroy()'s client.stop() is skipped. Stop the
            // just-resolved client ourselves rather than leak a live D-Bus
            // location subscription attached to a torn-down indicator.
            if (this._destroyed) {
                try { this._geoclue?.get_client()?.stop(); } catch { /* no client under portal */ }
                this._geoclue = null;
                return;
            }
        }

        const loc = this._geoclue?.get_location() ?? null;
        if (loc) {
            this._lat = loc.latitude;
            this._lon = loc.longitude;
            // Reverse-geocoding only changes when we've actually moved. Skip the
            // Nominatim request (and its fair-use rate limit) when we're within
            // ~1 km of the coords we last resolved a name for. Otherwise this
            // fires on every menu open and every timer tick.
            if (this._locName && this._geoLat != null &&
                Math.abs(this._lat - this._geoLat) < 0.01 &&
                Math.abs(this._lon - this._geoLon) < 0.01)
                return;
            this._locName = await reverseGeocode(this._lat, this._lon);
            this._geoLat  = this._lat;
            this._geoLon  = this._lon;
            return;
        }

        // GeoClue unavailable — fall back to the last known coords from settings.
        const lat = this._settings.get_double('location-latitude');
        const lon = this._settings.get_double('location-longitude');
        if (lat !== 0 || lon !== 0) {
            this._lat     = lat;
            this._lon     = lon;
            this._locName = this._settings.get_string('location-name') || 'Last known location';
            return;
        }
        throw new Error('Location unavailable. Set manually in Preferences.');
    }

    async _fetch(force = false) {
        if (this._busy) return;
        this._busy = true;

        try {
            // Resolve location first so we can detect when GeoClue (or manual
            // settings) moved us, even when cached weather is otherwise fresh.
            await this._resolveLocation();
            if (this._destroyed) return;
            this._panel.setLocation(this._locName);

            // Persist the resolved coords/name in auto mode so the Preferences
            // window (which mirrors these keys live) always reflects the
            // location the panel is actually showing. Done here — right after
            // resolution, before any freshness gate — so a fresh-cache early
            // return below can't leave Preferences pinned to the previous
            // (e.g. manually searched) location. Our own 'changed' handler
            // ignores these self-writes in auto mode, so no refetch loop.
            if (this._settings.get_boolean('location-auto')) {
                this._settings.set_double('location-latitude',  this._lat);
                this._settings.set_double('location-longitude', this._lon);
                this._settings.set_string('location-name',      this._locName);
            }

            const locChanged = this._cachedLat != null &&
                (this._lat !== this._cachedLat || this._lon !== this._cachedLon);
            if (locChanged) {
                this._cachedParsed = null;
                this._lastFetch    = 0;
                this._cachedAq     = null;
                this._lastAqFetch  = 0;
                this._cachedMap    = null;
                this._lastMapFetch = 0;
                this._cachedUsno   = null;   // solar noon is location-specific
                this._lastUsnoDay  = null;
            }

            const now          = Date.now();
            const weatherMs    = Math.max(5, this._settings.get_int('fetch-interval')) * 60 * 1000;
            const aqMs         = Math.max(5, this._settings.get_int('aq-fetch-interval')) * 60 * 1000;
            const weatherFresh = !force && this._cachedParsed && (now - this._lastFetch) < weatherMs;
            const aqFresh      = !force && this._cachedAq && (now - this._lastAqFetch) < aqMs;
            // USNO has its own once-per-calendar-day cadence, independent of the
            // weather/AQ TTLs. A manual refresh (force) bypasses the day gate;
            // the _busy guard at the top of _fetch still keeps button-spam from
            // launching overlapping fetches.
            const todayKey     = usnoDayKey();
            const usnoStale    = force || !this._cachedUsno || this._lastUsnoDay !== todayKey;

            // Radar is fetched lazily by _ensureMap when the Map tab is viewed,
            // so it doesn't participate in this background freshness gate.
            if (weatherFresh && aqFresh && !usnoStale) {
                this._panel.setData(this._cachedParsed, this.menu.isOpen);
                return;
            }

            if (!weatherFresh) this._panel.setLoading();

            // Kicked off here so it runs in parallel with the weather/AQ work
            // below; awaited just before the astronomy merge.
            const usnoPromise = usnoStale
                ? fetchUsnoAstronomy(this._lat, this._lon).catch(() => null)
                : null;

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

                const [aqData, alerts, waiAstroRaw, precipRaw] = await Promise.all([
                    fetchJSON(buildAirQualityUrl(this._lat, this._lon)).catch(() => null),
                    fetchAlerts(this._lat, this._lon),
                    waiKey
                        ? fetchWeatherAiAstronomy(this._lat, this._lon, waiKey).catch(e => {
                            logError('[WeatherPrime] WeatherAI.io astronomy failed:', e.message);
                            return null;
                        })
                        : Promise.resolve(null),
                    // Last-24h precip total for the Current tab. Always keyless
                    // Open-Meteo regardless of api-provider — see buildOpenMeteoPrecip24hUrl.
                    fetchJSON(buildOpenMeteoPrecip24hUrl(this._lat, this._lon, unit)).catch(() => null),
                ]);

                if (provider === 'weatherapi') {
                    const key = this._settings.get_string('weatherapi-key').trim();
                    if (!key) throw new Error('WeatherAPI key missing — add it in Preferences.');
                    // WeatherAPI omits a per-day wind direction, so pull the
                    // dominant directions from Open-Meteo (keyless) in parallel
                    // and backfill the 7-day arrows.
                    const [raw, omWindRaw] = await Promise.all([
                        fetchWeatherAPI(this._lat, this._lon, key),
                        fetchJSON(buildOpenMeteoDailyWindUrl(this._lat, this._lon)).catch(() => null),
                    ]);
                    parsed = parseWeatherAPI(raw, aqData, windUnit, pressureUnit, unit,
                                             dailyWindDirMap(omWindRaw));
                } else {
                    const raw = await fetchJSON(buildOpenMeteoUrl(this._lat, this._lon, unit));
                    parsed = parseOpenMeteo(raw, aqData, windUnit, pressureUnit, unit);
                }

                // Last-24h precip: a single keyless Open-Meteo source for both
                // providers (neither main response carries it). The per-hour
                // series feeds the Current tab's sparkline; its sum is the
                // displayed total. Both stay null/absent if the side fetch failed
                // — the block just hides. Summed/formatted here so neither parser
                // needs to know about it.
                const precipSeries = precip24hSeries(precipRaw);
                const sumOf = arr => arr.reduce((a, b) => a + b, 0);
                parsed.current.precip24hSeries  = precipSeries?.precip ?? null;
                parsed.current.snow24hSeries    = precipSeries?.snow  ?? null;
                parsed.current.precip24hImperial = unit === 'fahrenheit';
                parsed.current.precip24h = fmtPrecipTotal(
                    precipSeries ? sumOf(precipSeries.precip) : null, unit);
                parsed.current.snow24h = fmtSnowTotal(
                    precipSeries ? sumOf(precipSeries.snow) : null, unit);

                // WeatherAI.io is a dedicated astronomy source; when present its
                // values take precedence, falling back to whatever the weather
                // provider already supplied (Open-Meteo/WeatherAPI sun + moon).
                if (waiAstroRaw) {
                    try {
                        const wai  = parseWeatherAiAstronomy(waiAstroRaw);
                        const base = parsed.astronomy ?? {};
                        parsed.astronomy = {
                            sunrise:          wai.sunrise          ?? base.sunrise          ?? null,
                            sunset:           wai.sunset           ?? base.sunset           ?? null,
                            moonrise:         wai.moonrise         ?? base.moonrise         ?? null,
                            moonset:          wai.moonset          ?? base.moonset          ?? null,
                            moonPhase:        wai.moonPhase        ?? base.moonPhase        ?? null,
                            moonIllumination: wai.moonIllumination ?? base.moonIllumination ?? null,
                        };
                    } catch (e) {
                        logError('[WeatherPrime] WeatherAI astronomy parse error:', e.message);
                    }
                }

                parsed.alerts = alerts;
                parsed.airquality.airnow      = aqResult.airnow;
                parsed.airquality.openweather = aqResult.openweather;
                parsed.lat = this._lat;
                parsed.lon = this._lon;
                // Preserve any radar already fetched for this location so the
                // Map tab keeps its tiles across a weather refresh; _ensureMap
                // refreshes them on demand when they go stale.
                parsed.map = this._cachedMap;

                this._cachedParsed = parsed;
                this._lastFetch    = Date.now();
            }

            // USNO refreshes on its own daily cadence, so resolve it here and
            // merge into the astronomy block regardless of which path produced
            // `parsed`. It's purely additive (solar noon + next moon dates) on
            // top of whatever the providers/WeatherAI supplied. A failed fetch
            // leaves the cached value (and its day key) untouched so the next
            // _fetch retries rather than waiting out the day.
            if (usnoPromise) {
                const raw = await usnoPromise;
                if (raw && (raw[0] || raw[1])) {
                    try {
                        this._cachedUsno  = parseUsno(raw[0], raw[1]);
                        this._lastUsnoDay = todayKey;
                    } catch (e) {
                        logError('[WeatherPrime] USNO astronomy parse error:', e.message);
                    }
                }
            }
            if (this._cachedUsno) {
                parsed.astronomy = { ...(parsed.astronomy ?? {}), ...this._cachedUsno };
            }

            // The weather/AQ/USNO awaits above can each run up to the 30s Soup
            // timeout; bail if we were torn down meanwhile, before writing to
            // (now-finalized) pill widgets and the panel.
            if (this._destroyed) return;

            this._cachedLat = this._lat;
            this._cachedLon = this._lon;

            const alerts = parsed.alerts ?? [];
            this._pillIcon.set_gicon(iconGicon(parsed.current.icon));
            this._pillTemp.set_text(parsed.current.temp);
            if (alerts.length > 0) this._pillAlert.show();
            else                   this._pillAlert.hide();

            this._panel.setData(parsed, this.menu.isOpen);

        } catch (e) {
            // A teardown mid-fetch surfaces here as a finalized-object access;
            // don't try to render the "error" into widgets that no longer exist.
            if (!this._destroyed) {
                this._panel.setError(e.message);
                this._pillIcon.set_gicon(iconGicon('not-available'));
                this._pillTemp.set_text('--');
            }
            logError('[WeatherPrime]', e.message);
        } finally {
            this._busy = false;
        }
    }

    // Lazily fetch radar tiles, but only when the Map tab is actually being
    // viewed. Skips the fetch when the cached radar is still within the refresh
    // interval (RainViewer publishes at most every 10 min), so opening the menu
    // or switching to the Map tab costs nothing while the data is fresh.
    async _ensureMap() {
        if (this._lat == null || this._panel.activeTab !== 'map') return;

        const now   = Date.now();
        const mapMs = Math.max(RADAR_MIN_INTERVAL_MIN, this._settings.get_int('map-fetch-interval')) * 60 * 1000;
        if (this._cachedMap && (now - this._lastMapFetch) < mapMs) return;

        if (this._mapBusy) return;
        this._mapBusy = true;
        // Show a spinner only when there's no prior radar to keep on screen;
        // otherwise the stale frames stay visible until the refresh lands.
        if (!this._cachedMap) this._panel.setMapStatus('loading');
        try {
            const tiles = await fetchMapTiles(this._lat, this._lon).catch(e => {
                logError('[WeatherPrime] map tile fetch failed:', e.message);
                return null;
            });
            if (this._destroyed) return;
            if (tiles) {
                this._cachedMap    = tiles;
                this._lastMapFetch = Date.now();
                if (this._cachedParsed) {
                    this._cachedParsed.map = tiles;
                    this._panel.setData(this._cachedParsed, this.menu.isOpen);
                }
            } else if (!this._cachedMap) {
                this._panel.setMapStatus('failed');
            }
        } finally {
            this._mapBusy = false;
        }
    }

    destroy() {
        // Flag teardown first so any in-flight _fetch/_ensureMap continuation
        // (the boot-time fetch can still be suspended on a slow network when a
        // lock/session-mode flip disables us) bails at its next await instead of
        // touching now-finalized widgets.
        this._destroyed = true;
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
        if (this._geoclue) {
            try { this._geoclue.get_client()?.stop(); } catch { /* no client under portal */ }
            this._geoclue = null;
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
        // Resolve the bundled Meteocons icons/ directory from the install path
        // so the module-level icon helpers can build St.Icons from it.
        ICON_DIR = `${this.path}/icons`;
        // Create and register the indicator once: addToStatusArea claims the
        // role and wires the menu into the panel's menu manager. A position
        // change afterwards only reparents the container (see _reposition), so
        // the indicator and all its state — caches, in-flight fetches, the
        // cached GeoClue client — survive a left/center/right move intact.
        this._indicator = new WeatherIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._reposition();
        this._posChangedId = this._settings.connect('changed::panel-position',
            () => this._reposition());
    }

    // Move the (already-registered) indicator's container into the box for the
    // current panel-position setting, without destroying the indicator.
    _reposition() {
        const container = this._indicator?.container;
        if (!container) return;
        const pos = this._settings.get_string('panel-position');
        const box = pos === 'left'   ? Main.panel._leftBox
                  : pos === 'center' ? Main.panel._centerBox
                  :                    Main.panel._rightBox;
        // 'left' sits at the far (inner) end of the left box, after Activities;
        // center/right sit at the leading edge of their box.
        const parent = container.get_parent();
        if (parent) parent.remove_child(container);
        const index = pos === 'left' ? box.get_n_children() : 0;
        box.insert_child_at_index(container, index);
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
