import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

// Reusable across decode() calls — no need to allocate one per response.
const _decoder = new TextDecoder();

function geocodeSearch(query) {
    return new Promise((resolve, reject) => {
        const session = new Soup.Session({user_agent: 'WeatherPrime/1.0'});
        const params  = new URLSearchParams({name: query, count: 5, language: 'en', format: 'json'});
        const msg     = Soup.Message.new('GET', `https://geocoding-api.open-meteo.com/v1/search?${params}`);
        if (!msg) { reject(new Error('Bad URL')); return; }
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
            try {
                const bytes = sess.send_and_read_finish(res);
                const data  = JSON.parse(_decoder.decode(bytes.get_data()));
                resolve(data.results ?? []);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export default class WeatherPrimePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(580, 720);

        window.add(this._locationPage(settings));
        window.add(this._apiPage(settings));
        window.add(this._appearancePage(settings));
    }

    // ── Location page ─────────────────────────────────────────────────────

    _locationPage(settings) {
        const page = new Adw.PreferencesPage({
            title:     'Location',
            icon_name: 'find-location-symbolic',
        });

        const autoGroup = new Adw.PreferencesGroup({title: 'Automatic Location'});
        const autoRow   = new Adw.SwitchRow({
            title:    'Use GeoClue',
            subtitle: 'Detect location automatically via the system location service',
        });
        settings.bind('location-auto', autoRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(autoRow);
        page.add(autoGroup);

        const manualGroup = new Adw.PreferencesGroup({
            title:       'Manual Location',
            description: 'Search for a city or enter coordinates directly.',
        });

        const searchRow = new Adw.ActionRow({
            title:    'Search city',
            subtitle: 'Type a city name and press Search',
        });
        const searchEntry = new Gtk.Entry({
            placeholder_text: 'e.g. Chicago',
            hexpand:          true,
            valign:           Gtk.Align.CENTER,
        });
        const searchBtn = new Gtk.Button({
            label:       'Search',
            valign:      Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        searchRow.add_suffix(searchEntry);
        searchRow.add_suffix(searchBtn);
        manualGroup.add(searchRow);

        const resultsRow   = new Adw.ActionRow({title: 'Results', visible: false});
        const resultsCombo = new Gtk.ComboBoxText({valign: Gtk.Align.CENTER, hexpand: true});
        const applyBtn     = new Gtk.Button({
            label:       'Use',
            valign:      Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        resultsRow.add_suffix(resultsCombo);
        resultsRow.add_suffix(applyBtn);
        manualGroup.add(resultsRow);

        const latRow  = new Adw.EntryRow({title: 'Latitude'});
        const lonRow  = new Adw.EntryRow({title: 'Longitude'});
        const nameRow = new Adw.EntryRow({title: 'Display name'});

        latRow.set_text(String(settings.get_double('location-latitude')));
        lonRow.set_text(String(settings.get_double('location-longitude')));
        nameRow.set_text(settings.get_string('location-name'));

        // Guard so programmatic updates from GSettings don't loop back into set_double/set_string.
        let _syncing = false;

        latRow.connect('changed',  () => { if (_syncing) return; const v = parseFloat(latRow.get_text());  if (!isNaN(v)) settings.set_double('location-latitude', v); });
        lonRow.connect('changed',  () => { if (_syncing) return; const v = parseFloat(lonRow.get_text());  if (!isNaN(v)) settings.set_double('location-longitude', v); });
        nameRow.connect('changed', () => { if (_syncing) return; settings.set_string('location-name', nameRow.get_text()); });

        // When GeoClue (in the shell process) writes new coordinates, refresh the entries live.
        const syncFromSettings = (row, value) => {
            const text = String(value);
            if (row.get_text() === text) return;
            _syncing = true;
            row.set_text(text);
            _syncing = false;
        };
        settings.connect('changed::location-latitude',  () => syncFromSettings(latRow,  settings.get_double('location-latitude')));
        settings.connect('changed::location-longitude', () => syncFromSettings(lonRow,  settings.get_double('location-longitude')));
        settings.connect('changed::location-name',      () => syncFromSettings(nameRow, settings.get_string('location-name')));

        manualGroup.add(latRow);
        manualGroup.add(lonRow);
        manualGroup.add(nameRow);
        page.add(manualGroup);

        let _results = [];
        const runSearch = async () => {
            const q = searchEntry.get_text().trim();
            if (!q) return;
            searchBtn.set_sensitive(false);
            searchBtn.set_label('…');
            try {
                _results = await geocodeSearch(q);
                resultsCombo.remove_all();
                if (_results.length === 0) {
                    resultsRow.set_subtitle('No results found.');
                    resultsRow.set_visible(true);
                    applyBtn.set_sensitive(false);
                    return;
                }
                _results.forEach(r => {
                    const parts = [r.name, r.admin1, r.country].filter(Boolean);
                    resultsCombo.append_text(parts.join(', '));
                });
                resultsCombo.set_active(0);
                resultsRow.set_subtitle('');
                resultsRow.set_visible(true);
                applyBtn.set_sensitive(true);
            } catch (e) {
                resultsRow.set_subtitle(`Error: ${e.message}`);
                resultsRow.set_visible(true);
                applyBtn.set_sensitive(false);
            } finally {
                searchBtn.set_sensitive(true);
                searchBtn.set_label('Search');
            }
        };

        searchBtn.connect('clicked', () => runSearch());
        searchEntry.connect('activate', () => runSearch());

        applyBtn.connect('clicked', () => {
            const idx = resultsCombo.get_active();
            if (idx < 0 || idx >= _results.length) return;
            const r     = _results[idx];
            const parts = [r.name, r.admin1, r.country].filter(Boolean);
            settings.set_double('location-latitude',  r.latitude);
            settings.set_double('location-longitude', r.longitude);
            settings.set_string('location-name',      parts.join(', '));
            settings.set_boolean('location-auto',     false);
            latRow.set_text(String(r.latitude));
            lonRow.set_text(String(r.longitude));
            nameRow.set_text(parts.join(', '));
            autoRow.set_active(false);
        });

        return page;
    }

    // ── API page ──────────────────────────────────────────────────────────

    _apiPage(settings) {
        const page = new Adw.PreferencesPage({
            title:     'Weather API',
            icon_name: 'network-wireless-symbolic',
        });

        const sourceGroup = new Adw.PreferencesGroup({
            title:       'Weather Provider',
            description: 'Source for current conditions, hourly, and 7-day forecast. Open-Meteo is free and needs no key. WeatherAPI.com requires a free account.',
        });

        const providers = ['open-meteo', 'weatherapi'];
        const providerRow = new Adw.ComboRow({
            title:    'Provider',
            subtitle: 'Which weather service to use',
            model:    Gtk.StringList.new([
                'Open-Meteo (free, no key)',
                'WeatherAPI.com (bring your own key)',
            ]),
        });
        const savedProvider = settings.get_string('api-provider');
        let currentIdx = providers.indexOf(savedProvider);
        if (currentIdx < 0) {
            // Migrate legacy 'weatherai' value (or any unknown) to the default.
            currentIdx = 0;
            settings.set_string('api-provider', providers[0]);
        }
        providerRow.set_selected(currentIdx);

        const wApiKeyRow = new Adw.PasswordEntryRow({
            title:             'WeatherAPI.com key',
            show_apply_button: true,
        });
        wApiKeyRow.set_text(settings.get_string('weatherapi-key'));
        wApiKeyRow.set_visible(providers[currentIdx] === 'weatherapi');

        providerRow.connect('notify::selected', () => {
            const sel = providers[providerRow.get_selected()] ?? 'open-meteo';
            settings.set_string('api-provider', sel);
            wApiKeyRow.set_visible(sel === 'weatherapi');
        });
        wApiKeyRow.connect('apply', () => settings.set_string('weatherapi-key', wApiKeyRow.get_text()));

        sourceGroup.add(providerRow);
        sourceGroup.add(wApiKeyRow);
        page.add(sourceGroup);

        const waiGroup = new Adw.PreferencesGroup({
            title:       'WeatherAI.io (Astronomy)',
            description: 'When a key is set, WeatherAI.io powers the Astronomy tab (sunrise/sunset, moon phase, illumination). If the key is missing, the Astronomy tab is hidden. Forecast data always comes from the Weather Provider above.',
        });
        const waiKeyRow = new Adw.PasswordEntryRow({
            title:             'WeatherAI.io key',
            show_apply_button: true,
        });
        waiKeyRow.set_text(settings.get_string('weatherai-key'));
        waiKeyRow.connect('apply', () => settings.set_string('weatherai-key', waiKeyRow.get_text()));
        waiGroup.add(waiKeyRow);
        page.add(waiGroup);

        const aqGroup = new Adw.PreferencesGroup({
            title:       'Air Quality Data',
            description: 'AirNow provides US EPA air quality index (0–500 scale) and per-pollutant data from monitoring stations within 25 miles. OpenWeatherMap provides a coarser 1–5 AQI but works globally and always returns all 8 pollutant concentrations. Without a key, basic PM2.5/PM10 from Open-Meteo are shown.',
        });

        const airnowKeyRow = new Adw.PasswordEntryRow({
            title:             'AirNow API key (US, register at airnowapi.org)',
            show_apply_button: true,
        });
        airnowKeyRow.set_text(settings.get_string('airnow-api-key'));
        airnowKeyRow.connect('apply', () => settings.set_string('airnow-api-key', airnowKeyRow.get_text()));
        aqGroup.add(airnowKeyRow);

        const owmKeyRow = new Adw.PasswordEntryRow({
            title:             'OpenWeatherMap API key (global, register at openweathermap.org)',
            show_apply_button: true,
        });
        owmKeyRow.set_text(settings.get_string('openweather-api-key'));
        owmKeyRow.connect('apply', () => settings.set_string('openweather-api-key', owmKeyRow.get_text()));
        aqGroup.add(owmKeyRow);

        const aqSources = [
            {value: 'auto',        label: 'Automatic (AirNow → OpenWeatherMap → Open-Meteo)'},
            {value: 'airnow',      label: 'AirNow only'},
            {value: 'openweather', label: 'OpenWeatherMap only'},
            {value: 'open-meteo',  label: 'Open-Meteo PM2.5 / PM10 only'},
        ];
        const aqSourceRow = new Adw.ComboRow({
            title:    'Air quality source',
            subtitle: 'Which provider to use when its API key is configured',
            model:    Gtk.StringList.new(aqSources.map(s => s.label)),
        });
        const savedAqSource = settings.get_string('aq-source');
        const aqIdx = aqSources.findIndex(s => s.value === savedAqSource);
        aqSourceRow.set_selected(aqIdx >= 0 ? aqIdx : 0);
        aqSourceRow.connect('notify::selected', () => {
            const src = aqSources[aqSourceRow.get_selected()];
            if (src) settings.set_string('aq-source', src.value);
        });
        aqGroup.add(aqSourceRow);

        page.add(aqGroup);

        const tideGroup = new Adw.PreferencesGroup({
            title:       'Tides',
            description: 'Adds a high/low tide line to the Astronomy tab for coastal locations. WeatherAPI.com works worldwide but reuses the WeatherAPI.com key above. NOAA is keyless but covers the United States only. Either way the line is hidden when the location is not near the coast.',
        });

        const tideSources = [
            {value: 'off',        label: 'Off'},
            {value: 'weatherapi', label: 'WeatherAPI.com (global, uses WeatherAPI.com key)'},
            {value: 'noaa',       label: 'NOAA (US only, no key)'},
        ];
        const tideSourceRow = new Adw.ComboRow({
            title:    'Tide source',
            subtitle: 'Where to fetch tide predictions from',
            model:    Gtk.StringList.new(tideSources.map(s => s.label)),
        });
        const savedTideSource = settings.get_string('tide-source');
        const tideIdx = tideSources.findIndex(s => s.value === savedTideSource);
        tideSourceRow.set_selected(tideIdx >= 0 ? tideIdx : 0);
        tideSourceRow.connect('notify::selected', () => {
            const src = tideSources[tideSourceRow.get_selected()];
            if (src) settings.set_string('tide-source', src.value);
        });
        tideGroup.add(tideSourceRow);
        page.add(tideGroup);

        const fetchOptions = [
            {label: 'Every 15 minutes', minutes: 15},
            {label: 'Every 30 minutes', minutes: 30},
            {label: 'Every hour',       minutes: 60},
            {label: 'Every 3 hours',    minutes: 180},
            {label: 'Every 6 hours',    minutes: 360},
            {label: 'Every 12 hours',   minutes: 720},
            {label: 'Once a day',       minutes: 1440},
        ];

        // RainViewer publishes new radar frames every 10 minutes, so 10 min is
        // the floor — polling more often just refetches identical data.
        const radarOptions = [
            {label: 'Every 10 minutes', minutes: 10},
            {label: 'Every 15 minutes', minutes: 15},
            {label: 'Every 30 minutes', minutes: 30},
            {label: 'Every hour',       minutes: 60},
            {label: 'Every 3 hours',    minutes: 180},
        ];

        const makeFreqRow = (title, subtitle, key, options = fetchOptions) => {
            const row = new Adw.ComboRow({title, subtitle,
                model: Gtk.StringList.new(options.map(o => o.label)),
            });
            const saved = settings.get_int(key);
            const idx   = options.findIndex(o => o.minutes === saved);
            row.set_selected(idx >= 0 ? idx : options.length - 1);
            row.connect('notify::selected', () => {
                const opt = options[row.get_selected()];
                if (opt) settings.set_int(key, opt.minutes);
            });
            return row;
        };

        const fetchGroup = new Adw.PreferencesGroup({title: 'API Call Frequency'});
        fetchGroup.add(makeFreqRow('Weather data',     'How often to fetch weather, forecasts and alerts', 'fetch-interval'));
        fetchGroup.add(makeFreqRow('Air quality data', 'How often to refresh the AQI source',             'aq-fetch-interval'));
        fetchGroup.add(makeFreqRow('Radar overlay',    'How often to refresh the RainViewer radar on the Map tab (10 min minimum — that is the provider’s refresh cadence)', 'map-fetch-interval', radarOptions));
        page.add(fetchGroup);

        return page;
    }

    // ── Appearance page ───────────────────────────────────────────────────

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({
            title:     'Appearance',
            icon_name: 'preferences-color-symbolic',
        });

        const makeComboRow = (title, subtitle, key, options) => {
            const labels  = options.map(o => o.label);
            const values  = options.map(o => o.value);
            const row     = new Adw.ComboRow({title, subtitle,
                model: Gtk.StringList.new(labels),
            });
            const current = settings.get_string(key);
            const idx     = values.indexOf(current);
            row.set_selected(idx >= 0 ? idx : 0);
            row.connect('notify::selected', () => {
                settings.set_string(key, values[row.get_selected()] ?? values[0]);
            });
            return row;
        };

        const appearanceGroup = new Adw.PreferencesGroup({title: 'Appearance'});
        appearanceGroup.add(makeComboRow('Color scheme', 'Auto follows the system dark/light setting', 'color-scheme', [
            {label: 'Auto (follow system)', value: 'auto'},
            {label: 'Dark',                 value: 'dark'},
            {label: 'Light',                value: 'light'},
        ]));
        appearanceGroup.add(makeComboRow('Panel position', 'Where the weather pill appears in the top bar', 'panel-position', [
            {label: 'Left',   value: 'left'},
            {label: 'Center', value: 'center'},
            {label: 'Right',  value: 'right'},
        ]));
        appearanceGroup.add(makeComboRow('Panel size', 'Size of the drop-down panel content', 'panel-size', [
            {label: 'Default',       value: 'original'},
            {label: 'Medium (1.25×)', value: 'medium'},
            {label: 'Large (1.5×)',  value: 'large'},
        ]));
        page.add(appearanceGroup);

        const mapGroup = new Adw.PreferencesGroup({
            title:       'Weather Map',
            description: 'The Map tab shows a static RainViewer radar overlay on an OpenStreetMap base. Tap it to open a fully interactive map in your browser.',
        });
        mapGroup.add(makeComboRow('Open interactive map in', 'Which website to launch when the Map tab is clicked', 'map-website', [
            {label: 'Windy.com',       value: 'windy'},
            {label: 'Zoom Earth',      value: 'zoom-earth'},
            {label: 'Ventusky',        value: 'ventusky'},
            {label: 'RainViewer',      value: 'rainviewer'},
            {label: 'Weather.com',     value: 'weather-com'},
            {label: 'Wunderground',    value: 'wunderground'},
            {label: 'NWS Radar (US)',  value: 'nws'},
        ]));
        page.add(mapGroup);

        const unitsGroup = new Adw.PreferencesGroup({title: 'Units'});
        unitsGroup.add(makeComboRow('Temperature', 'Unit for all temperature values', 'temperature-unit', [
            {label: 'Fahrenheit (°F)', value: 'fahrenheit'},
            {label: 'Celsius (°C)',    value: 'celsius'},
        ]));
        unitsGroup.add(makeComboRow('Wind speed', 'Unit for wind speed in current conditions', 'wind-unit', [
            {label: 'mph',  value: 'mph'},
            {label: 'km/h', value: 'kmh'},
            {label: 'm/s',  value: 'ms'},
        ]));
        unitsGroup.add(makeComboRow('Pressure', 'Unit for barometric pressure', 'pressure-unit', [
            {label: 'hPa (mb)', value: 'hpa'},
            {label: 'inHg',     value: 'inhg'},
            {label: 'mmHg',     value: 'mmhg'},
        ]));
        page.add(unitsGroup);

        return page;
    }
}
