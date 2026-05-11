import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import Geoclue from 'gi://Geoclue';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

if (typeof URLSearchParams === 'undefined') {
    globalThis.URLSearchParams = class {
        constructor(o = {}) { this._e = Object.entries(o).map(([k, v]) => [k, String(v)]); }
        toString() { return this._e.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
    };
}

const WMO = {
    0:{icon:'☀️',desc:'Clear sky'},1:{icon:'🌤️',desc:'Mainly clear'},2:{icon:'⛅',desc:'Partly cloudy'},
    3:{icon:'☁️',desc:'Overcast'},45:{icon:'🌫️',desc:'Fog'},48:{icon:'🌫️',desc:'Rime fog'},
    51:{icon:'🌦️',desc:'Light drizzle'},53:{icon:'🌦️',desc:'Drizzle'},55:{icon:'🌦️',desc:'Dense drizzle'},
    56:{icon:'🌨️',desc:'Light freezing drizzle'},57:{icon:'🌨️',desc:'Freezing drizzle'},
    61:{icon:'🌧️',desc:'Slight rain'},63:{icon:'🌧️',desc:'Rain'},65:{icon:'🌧️',desc:'Heavy rain'},
    66:{icon:'🌨️',desc:'Light freezing rain'},67:{icon:'🌨️',desc:'Freezing rain'},
    71:{icon:'❄️',desc:'Slight snow'},73:{icon:'❄️',desc:'Snowfall'},75:{icon:'❄️',desc:'Heavy snow'},
    77:{icon:'🌨️',desc:'Snow grains'},80:{icon:'🌦️',desc:'Slight showers'},81:{icon:'🌦️',desc:'Showers'},
    82:{icon:'🌧️',desc:'Violent showers'},85:{icon:'🌨️',desc:'Slight snow showers'},86:{icon:'🌨️',desc:'Heavy snow showers'},
    95:{icon:'⛈️',desc:'Thunderstorm'},96:{icon:'⛈️',desc:'Thunderstorm w/ hail'},99:{icon:'⛈️',desc:'Thunderstorm w/ heavy hail'},
};
function wmo(code) { return WMO[code] ?? {icon:'🌡️',desc:'Unknown'}; }

function pollenLevel(value) {
    if (value == null) return {text:'N/A',color:null};
    const levels = ['None','Very Low','Low','Medium','High','Very High'];
    const colors = ['#9E9E9E','#8BC34A','#FFC107','#FF9800','#FF5722','#EF5350'];
    const i = Math.max(0, Math.min(5, Math.round(value)));
    return {text: levels[i], color: colors[i]};
}
function pm25Level(v) {
    if (v == null) return {text:'N/A',color:null};
    if (v < 12)    return {text:'Good',color:'#4CAF50'};
    if (v < 35.4)  return {text:'Moderate',color:'#FFC107'};
    if (v < 55.4)  return {text:'USG',color:'#FF9800'};
    if (v < 150.4) return {text:'Unhealthy',color:'#FF5722'};
    return               {text:'Very Unhealthy',color:'#EF5350'};
}
function windDir(deg) {
    if (deg == null) return '';
    return ['N','NE','E','SE','S','SW','W','NW'][Math.round(deg/45)%8];
}
function fmt(val, unit) {
    if (val == null) return '--';
    return `${Math.round(val)}${unit === 'fahrenheit' ? '°F' : '°C'}`;
}
function shortHour(s) {
    const d = new Date(s); let h = d.getHours();
    const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
    return `${h}${ap}`;
}
function shortDay(s) {
    const d = new Date(s.length === 10 ? s + 'T12:00:00' : s);
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
}

let _session = null;
function getSession() {
    if (!_session) _session = new Soup.Session({user_agent:'WeatherPrime/1.0'});
    return _session;
}
function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', url);
        if (!msg) { reject(new Error(`Bad URL: ${url}`)); return; }
        getSession().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
            try {
                const bytes = sess.send_and_read_finish(result);
                if (msg.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${msg.get_status()}`);
                resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
            } catch(e) { reject(e); }
        });
    });
}

function buildOpenMeteoUrl(lat, lon, unit) {
    const params = new URLSearchParams({
        latitude: lat, longitude: lon,
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code,surface_pressure',
        hourly: 'temperature_2m,weather_code',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        temperature_unit: unit === 'fahrenheit' ? 'fahrenheit' : 'celsius',
        wind_speed_unit: 'mph', timezone: 'auto', forecast_days: 7,
    });
    return `https://api.open-meteo.com/v1/forecast?${params}`;
}
function buildAirQualityUrl(lat, lon) {
    const params = new URLSearchParams({latitude: lat, longitude: lon, hourly: 'pm2_5,pm10', timezone: 'auto', forecast_days: 1});
    return `https://air-quality-api.open-meteo.com/v1/air-quality?${params}`;
}

function parseOpenMeteo(data, aqData, pollen, unit) {
    const c = data.current, h = data.hourly, d = data.daily;
    const now = new Date();
    let hi = 0;
    for (let i = 0; i < h.time.length; i++) { if (new Date(h.time[i]) <= now) hi = i; else break; }
    const hourly = h.time.slice(hi, hi+12).map((t,idx) => ({
        time: shortHour(t), temp: fmt(h.temperature_2m[hi+idx], unit), icon: wmo(h.weather_code[hi+idx]).icon,
    }));
    const daily = d.time.map((t,i) => ({
        day: shortDay(t), hi: fmt(d.temperature_2m_max[i], unit), lo: fmt(d.temperature_2m_min[i], unit),
        icon: wmo(d.weather_code[i]).icon, precip: `${d.precipitation_probability_max[i] ?? 0}%`,
    }));
    const aqH = aqData?.hourly;
    let aqIdx = aqH ? aqH.time.findIndex(t => new Date(t) >= now) : -1;
    if (aqIdx < 0) aqIdx = 0;
    const aq = k => aqH?.[k]?.[aqIdx] ?? null;
    return {
        current: {
            temp: fmt(c.temperature_2m, unit), feelsLike: fmt(c.apparent_temperature, unit),
            humidity: `${c.relative_humidity_2m ?? '--'}%`,
            wind: `${Math.round(c.wind_speed_10m ?? 0)} mph ${windDir(c.wind_direction_10m)}`,
            pressure: `${Math.round(c.surface_pressure ?? 0)} hPa`,
            icon: wmo(c.weather_code).icon, desc: wmo(c.weather_code).desc,
        },
        hourly, daily,
        allergens: { treeIndex: pollen?.treeIndex ?? null, grassIndex: pollen?.grassIndex ?? null, weedIndex: pollen?.weedIndex ?? null, pm25: aq('pm2_5'), pm10: aq('pm10') },
    };
}

function fetchWeatherAPI(lat, lon, key) {
    const params = new URLSearchParams({key, q:`${lat},${lon}`, days:7, aqi:'no', alerts:'no'});
    return fetchJSON(`https://api.weatherapi.com/v1/forecast.json?${params}`);
}
function wApiIcon(t, isDay) {
    t = t.toLowerCase();
    if (t.includes('thunder')) return '⛈️';
    if (t.includes('snow') || t.includes('blizzard')) return '❄️';
    if (t.includes('sleet') || t.includes('ice')) return '🌨️';
    if (t.includes('rain') || t.includes('drizzle')) return '🌧️';
    if (t.includes('mist') || t.includes('fog')) return '🌫️';
    if (t.includes('overcast')) return '☁️';
    if (t.includes('cloud')) return '⛅';
    return isDay ? '☀️' : '🌙';
}
function parseWeatherAPI(data, aqData, pollen, unit) {
    const c = data.current, isF = unit === 'fahrenheit';
    const now = new Date();
    const allHours = data.forecast.forecastday.flatMap(day => day.hour);
    let hi = 0;
    for (let i = 0; i < allHours.length; i++) { if (new Date(allHours[i].time) <= now) hi = i; else break; }
    const hourly = allHours.slice(hi, hi+12).map(h => ({
        time: shortHour(h.time), temp: `${Math.round(isF ? h.temp_f : h.temp_c)}°${isF?'F':'C'}`, icon: wApiIcon(h.condition.text, h.is_day),
    }));
    const daily = data.forecast.forecastday.map(day => ({
        day: shortDay(day.date), hi: `${Math.round(isF ? day.day.maxtemp_f : day.day.maxtemp_c)}°${isF?'F':'C'}`,
        lo: `${Math.round(isF ? day.day.mintemp_f : day.day.mintemp_c)}°${isF?'F':'C'}`,
        icon: wApiIcon(day.day.condition.text, 1), precip: `${day.day.daily_chance_of_rain ?? 0}%`,
    }));
    const aqH = aqData?.hourly;
    let aqIdx = aqH ? aqH.time.findIndex(t => new Date(t) >= now) : -1;
    if (aqIdx < 0) aqIdx = 0;
    const aq = k => aqH?.[k]?.[aqIdx] ?? null;
    return {
        current: {
            temp: `${Math.round(isF ? c.temp_f : c.temp_c)}°${isF?'F':'C'}`,
            feelsLike: `${Math.round(isF ? c.feelslike_f : c.feelslike_c)}°${isF?'F':'C'}`,
            humidity: `${c.humidity}%`, wind: `${Math.round(c.wind_mph)} mph ${c.wind_dir}`,
            pressure: `${Math.round(c.pressure_mb)} hPa`, icon: wApiIcon(c.condition.text, c.is_day), desc: c.condition.text,
        },
        hourly, daily,
        allergens: { treeIndex: pollen?.treeIndex ?? null, grassIndex: pollen?.grassIndex ?? null, weedIndex: pollen?.weedIndex ?? null, pm25: aq('pm2_5'), pm10: aq('pm10') },
    };
}

async function fetchTomorrowPollen(lat, lon, key) {
    if (!key) return null;
    try {
        const url = `https://api.tomorrow.io/v4/weather/realtime?location=${lat},${lon}&fields=treeIndex,grassIndex,weedIndex&apikey=${key}`;
        const d = await fetchJSON(url);
        const vals = d?.data?.values;
        if (!vals) { console.warn('[WeatherPrime] Tomorrow.io unexpected shape', JSON.stringify(d)); return null; }
        return { treeIndex: vals.treeIndex ?? null, grassIndex: vals.grassIndex ?? null, weedIndex: vals.weedIndex ?? null };
    } catch(e) { console.error('[WeatherPrime] Tomorrow.io pollen:', e.message); return null; }
}

async function fetchAlerts(lat, lon) {
    try {
        const data = await fetchJSON(`https://api.weather.gov/alerts/active?point=${lat},${lon}`);
        return (data.features ?? []).map(f => ({
            event: f.properties.event ?? 'Alert',
            headline: f.properties.headline ?? '',
            desc: f.properties.description ?? '',
            severity: f.properties.severity ?? 'Unknown',
        }));
    } catch { return []; }
}

async function reverseGeocode(lat, lon) {
    try {
        const params = new URLSearchParams({lat, lon, format:'json', zoom:10});
        const data = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?${params}`);
        const a = data.address;
        return a.city ?? a.town ?? a.village ?? a.county ?? data.display_name ?? 'Current location';
    } catch { return 'Current location'; }
}

function label(text, styleClass='') { return new St.Label({text: String(text), style_class: styleClass}); }
function hbox(styleClass='') { return new St.BoxLayout({style_class: styleClass, x_expand: true}); }
function vbox(styleClass='') { return new St.BoxLayout({vertical: true, style_class: styleClass, x_expand: true}); }
function spacer() { return new St.Widget({x_expand: true}); }

class WeatherPanel {
    constructor() {
        this._data = null; this._tab = 'current'; this._refreshCb = null; this._settingsCb = null;
        this.actor = vbox('wp-panel');
        this._build();
    }
    _build() {
        const header = hbox('wp-header');
        this._locationLbl = label('Loading…', 'wp-location');
        this._refreshBtn = new St.Button({label:'↻', style_class:'wp-icon-btn'});
        this._refreshBtn.tooltip_text = 'Refresh weather data';
        this._refreshBtn.connect('clicked', () => this._refreshCb?.());
        this._settingsBtn = new St.Button({label:'⚙', style_class:'wp-icon-btn wp-settings-btn'});
        this._settingsBtn.tooltip_text = 'Open preferences';
        this._settingsBtn.connect('clicked', () => this._settingsCb?.());
        header.add_child(this._locationLbl);
        header.add_child(spacer());
        header.add_child(this._refreshBtn);
        header.add_child(this._settingsBtn);
        this.actor.add_child(header);

        this._alertsBanner = vbox('wp-alerts-banner');
        this._alertsBanner.hide();
        this.actor.add_child(this._alertsBanner);

        const tabBar = hbox('wp-tab-bar');
        this._tabBtns = {};
        [['current','Now'],['hourly','Hourly'],['daily','7-Day'],['allergens','🌿 Allergens']].forEach(([id,lbl]) => {
            const btn = new St.Button({label:lbl, style_class:'wp-tab', x_expand:true, reactive:true, can_focus:true});
            btn.connect('clicked', () => this._selectTab(id));
            this._tabBtns[id] = btn;
            tabBar.add_child(btn);
        });
        this.actor.add_child(tabBar);

        this._scroll = new St.ScrollView({style_class:'wp-scroll', x_expand:true, overlay_scrollbars:true});
        this._content = vbox('wp-content');
        this._scroll.set_child(this._content);
        this.actor.add_child(this._scroll);
        this._selectTab('current');
    }
    _selectTab(id) {
        this._tab = id;
        Object.entries(this._tabBtns).forEach(([tid,btn]) => {
            if (tid === id) btn.add_style_class_name('active');
            else btn.remove_style_class_name('active');
        });
        this._render();
    }
    onRefresh(cb)  { this._refreshCb  = cb; }
    onSettings(cb) { this._settingsCb = cb; }
    setLocation(name) { this._locationLbl.set_text(name || 'Unknown'); }
    setLoading() { this._content.destroy_all_children(); this._content.add_child(label('Fetching weather…','wp-status')); }
    setError(msg) {
        this._content.destroy_all_children();
        const box = vbox('wp-error');
        box.add_child(label('⚠️','wp-error-icon'));
        box.add_child(label(msg,'wp-error-msg'));
        this._content.add_child(box);
    }
    setData(data) { this._data = data; this._renderAlertsBanner(data.alerts ?? []); this._render(); }
    _renderAlertsBanner(alerts) {
        this._alertsBanner.destroy_all_children();
        if (!alerts.length) { this._alertsBanner.hide(); return; }
        this._alertsBanner.show();
        alerts.forEach(a => {
            const item = vbox('wp-alert-item');
            const tr = hbox('wp-alert-title-row');
            tr.add_child(label('⚠','wp-alert-badge'));
            tr.add_child(label(a.event,'wp-alert-event'));
            item.add_child(tr);
            if (a.headline) item.add_child(label(a.headline,'wp-alert-headline'));
            this._alertsBanner.add_child(item);
        });
    }
    _render() {
        this._content.destroy_all_children();
        if (!this._data) return;
        switch(this._tab) {
            case 'current':   this._renderCurrent();   break;
            case 'hourly':    this._renderHourly();    break;
            case 'daily':     this._renderDaily();     break;
            case 'allergens': this._renderAllergens(); break;
        }
    }
    _renderCurrent() {
        const c = this._data.current, box = vbox('wp-current');
        const top = hbox('wp-current-top');
        top.add_child(label(c.icon,'wp-cur-icon'));
        const right = vbox('wp-cur-right');
        right.add_child(label(c.temp,'wp-cur-temp'));
        right.add_child(label(c.desc,'wp-cur-desc'));
        top.add_child(right); box.add_child(top);
        const grid = hbox('wp-detail-grid');
        [['Feels like',c.feelsLike],['Humidity',c.humidity],['Wind',c.wind],['Pressure',c.pressure]].forEach(([k,v]) => {
            const cell = vbox('wp-detail-cell');
            cell.add_child(label(k,'wp-detail-key'));
            cell.add_child(label(v,'wp-detail-val'));
            grid.add_child(cell);
        });
        box.add_child(grid); this._content.add_child(box);
    }
    _renderHourly() {
        const box = vbox('wp-hourly');
        this._data.hourly.forEach(h => {
            const row = hbox('wp-hour-row');
            row.add_child(label(h.time,'wp-hour-time'));
            row.add_child(label(h.icon,'wp-hour-icon'));
            row.add_child(spacer());
            row.add_child(label(h.temp,'wp-hour-temp'));
            box.add_child(row);
        });
        this._content.add_child(box);
    }
    _renderDaily() {
        const box = vbox('wp-daily');
        this._data.daily.forEach(d => {
            const row = hbox('wp-day-row');
            row.add_child(label(d.day,'wp-day-name'));
            row.add_child(label(d.icon,'wp-day-icon'));
            row.add_child(spacer());
            row.add_child(label(d.hi,'wp-day-hi'));
            row.add_child(label(' / ','wp-day-sep'));
            row.add_child(label(d.lo,'wp-day-lo'));
            row.add_child(label(`  💧${d.precip}`,'wp-day-precip'));
            box.add_child(row);
        });
        this._content.add_child(box);
    }
    _renderAllergens() {
        const a = this._data.allergens, box = vbox('wp-allergens');
        box.add_child(label('Pollen','wp-section-title'));
        [['Tree',a.treeIndex],['Grass',a.grassIndex],['Weed',a.weedIndex]].forEach(([name,val]) => {
            const lvl = pollenLevel(val), row = hbox('wp-allergen-row');
            row.add_child(label(name,'wp-allergen-name'));
            row.add_child(spacer());
            const lbl = label(lvl.text,'wp-allergen-val');
            if (lvl.color) lbl.set_style(`color:${lvl.color};`);
            row.add_child(lbl); box.add_child(row);
        });
        box.add_child(label('Air Quality','wp-section-title'));
        [['PM 2.5',a.pm25,'µg/m³'],['PM 10',a.pm10,'µg/m³']].forEach(([name,val,unit]) => {
            const lvl = pm25Level(val), row = hbox('wp-allergen-row');
            row.add_child(label(name,'wp-allergen-name'));
            row.add_child(spacer());
            const str = val != null ? `${Math.round(val)} ${unit} — ${lvl.text}` : 'N/A';
            const lbl = label(str,'wp-allergen-val');
            if (lvl.color) lbl.set_style(`color:${lvl.color};`);
            row.add_child(lbl); box.add_child(row);
        });
        this._content.add_child(box);
    }
}

const WeatherIndicator = GObject.registerClass(
class WeatherIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Weather Prime', false);
        this._ext = extension; this._settings = extension.getSettings();
        this._timer = null; this._lat = null; this._lon = null; this._locName = ''; this._busy = false;
        this._cachedParsed = null; this._lastFetch = 0;

        const pill = hbox('wp-pill');
        pill.set_y_expand(true); pill.set_y_align(Clutter.ActorAlign.CENTER);
        this._pillIcon  = label('🌡️','wp-pill-icon');
        this._pillTemp  = label('--','wp-pill-temp');
        this._pillAlert = label('⚠','wp-pill-alert');
        this._pillAlert.hide();
        pill.add_child(this._pillIcon); pill.add_child(this._pillTemp); pill.add_child(this._pillAlert);
        this.add_child(pill);

        this._panel = new WeatherPanel();
        this._panel.onRefresh(()  => this._fetch(true));
        this._panel.onSettings(() => this._ext.openPreferences());

        const section = new PopupMenu.PopupMenuSection();
        section.actor.add_child(this._panel.actor);
        this.menu.addMenuItem(section);
        this.menu.connect('open-state-changed', (_m, open) => { if (open) this._fetch(false); });

        this._settingsId = this._settings.connect('changed', () => {
            _session = null; this._cachedParsed = null; this._lastFetch = 0;
            this._restartTimer(); this._fetch(true);
        });
        this._fetch(true); this._startTimer();
    }
    _startTimer() {
        const secs = Math.max(5, this._settings.get_int('update-interval')) * 60;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => { this._fetch(true); return GLib.SOURCE_CONTINUE; });
    }
    _restartTimer() { if (this._timer) { GLib.source_remove(this._timer); this._timer = null; } this._startTimer(); }
    async _resolveLocation() {
        if (!this._settings.get_boolean('location-auto')) {
            this._lat = this._settings.get_double('location-latitude');
            this._lon = this._settings.get_double('location-longitude');
            this._locName = this._settings.get_string('location-name') || 'Custom location';
            if (this._lat === 0 && this._lon === 0) throw new Error('No location set. Open Preferences to configure.');
            return;
        }
        await new Promise((resolve, reject) => {
            Geoclue.Simple.new('weather-prime', Geoclue.AccuracyLevel.CITY, null, async (_obj, result) => {
                try {
                    const simple = Geoclue.Simple.new_finish(result);
                    const loc = simple.get_location();
                    this._lat = loc.latitude; this._lon = loc.longitude;
                    this._locName = await reverseGeocode(this._lat, this._lon);
                    resolve();
                } catch(e) {
                    const lat = this._settings.get_double('location-latitude');
                    const lon = this._settings.get_double('location-longitude');
                    if (lat !== 0 || lon !== 0) {
                        this._lat = lat; this._lon = lon;
                        this._locName = this._settings.get_string('location-name') || 'Last known location';
                        resolve();
                    } else { reject(new Error('Location unavailable. Set manually in Preferences.')); }
                }
            });
        });
    }
    async _fetch(force = false) {
        if (this._busy) return;
        const intervalMs = Math.max(5, this._settings.get_int('update-interval')) * 60 * 1000;
        if (!force && this._cachedParsed && (Date.now() - this._lastFetch) < intervalMs) {
            if (this._locName) this._panel.setLocation(this._locName);
            this._panel.setData(this._cachedParsed);
            return;
        }
        this._busy = true; this._panel.setLoading();
        try {
            await this._resolveLocation();
            this._panel.setLocation(this._locName);
            const provider = this._settings.get_string('api-provider');
            const unit = this._settings.get_string('temperature-unit');
            const tomorrowKey = this._settings.get_string('tomorrow-api-key').trim();
            const [aqData, pollen, alerts] = await Promise.all([
                fetchJSON(buildAirQualityUrl(this._lat, this._lon)).catch(() => null),
                fetchTomorrowPollen(this._lat, this._lon, tomorrowKey),
                fetchAlerts(this._lat, this._lon),
            ]);
            let parsed;
            if (provider === 'weatherapi') {
                const key = this._settings.get_string('weatherapi-key').trim();
                if (!key) throw new Error('WeatherAPI key missing — add it in Preferences.');
                const raw = await fetchWeatherAPI(this._lat, this._lon, key);
                parsed = parseWeatherAPI(raw, aqData, pollen, unit);
            } else {
                const raw = await fetchJSON(buildOpenMeteoUrl(this._lat, this._lon, unit));
                parsed = parseOpenMeteo(raw, aqData, pollen, unit);
            }
            parsed.alerts = alerts;
            if (this._settings.get_boolean('location-auto')) {
                this._settings.set_double('location-latitude', this._lat);
                this._settings.set_double('location-longitude', this._lon);
                this._settings.set_string('location-name', this._locName);
            }
            this._pillIcon.set_text(parsed.current.icon);
            this._pillTemp.set_text(parsed.current.temp);
            if (alerts.length > 0) this._pillAlert.show(); else this._pillAlert.hide();
            this._cachedParsed = parsed; this._lastFetch = Date.now();
            this._panel.setData(parsed);
        } catch(e) {
            this._panel.setError(e.message);
            this._pillIcon.set_text('⚠️'); this._pillTemp.set_text('--');
            console.error('[WeatherPrime]', e.message);
        } finally { this._busy = false; }
    }
    destroy() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = null; }
        if (this._settingsId) { this._settings.disconnect(this._settingsId); this._settingsId = null; }
        super.destroy();
    }
});

export default class WeatherPrimeExtension extends Extension {
    enable() { this._indicator = new WeatherIndicator(this); Main.panel.addToStatusArea(this.uuid, this._indicator); }
    disable() { _session = null; this._indicator?.destroy(); this._indicator = null; }
}
