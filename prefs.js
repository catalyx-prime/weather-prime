import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

if (typeof URLSearchParams === 'undefined') {
    globalThis.URLSearchParams = class {
        constructor(o = {}) { this._e = Object.entries(o).map(([k, v]) => [k, String(v)]); }
        toString() { return this._e.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
    };
}

function geocodeSearch(query) {
    return new Promise((resolve, reject) => {
        const session = new Soup.Session({user_agent: 'WeatherPrime/1.0'});
        const params  = new URLSearchParams({name: query, count: 5, language: 'en', format: 'json'});
        const msg     = Soup.Message.new('GET', `https://geocoding-api.open-meteo.com/v1/search?${params}`);
        if (!msg) { reject(new Error('Bad URL')); return; }
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
            try {
                const bytes = sess.send_and_read_finish(res);
                const data  = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                resolve(data.results ?? []);
            } catch (e) { reject(e); }
        });
    });
}

export default class WeatherPrimePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(580, 680);
        window.add(this._locationPage(settings));
        window.add(this._apiPage(settings));
        window.add(this._unitsPage(settings));
    }

    _locationPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Location', icon_name: 'find-location-symbolic'});
        const autoGroup = new Adw.PreferencesGroup({title: 'Automatic Location'});
        const autoRow = new Adw.SwitchRow({title: 'Use GeoClue', subtitle: 'Detect location automatically via the system location service'});
        settings.bind('location-auto', autoRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(autoRow);
        page.add(autoGroup);

        const manualGroup = new Adw.PreferencesGroup({title: 'Manual Location', description: 'Search for a city or enter coordinates directly.'});
        const searchRow = new Adw.ActionRow({title: 'Search city', subtitle: 'Type a city name and press Search'});
        const searchEntry = new Gtk.Entry({placeholder_text: 'e.g. Chicago', hexpand: true, valign: Gtk.Align.CENTER});
        const searchBtn = new Gtk.Button({label: 'Search', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
        searchRow.add_suffix(searchEntry);
        searchRow.add_suffix(searchBtn);
        manualGroup.add(searchRow);

        const resultsRow = new Adw.ActionRow({title: 'Results', visible: false});
        const resultsCombo = new Gtk.ComboBoxText({valign: Gtk.Align.CENTER, hexpand: true});
        const applyBtn = new Gtk.Button({label: 'Use', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
        resultsRow.add_suffix(resultsCombo);
        resultsRow.add_suffix(applyBtn);
        manualGroup.add(resultsRow);

        const latRow  = new Adw.EntryRow({title: 'Latitude'});
        const lonRow  = new Adw.EntryRow({title: 'Longitude'});
        const nameRow = new Adw.EntryRow({title: 'Display name'});
        latRow.set_text(String(settings.get_double('location-latitude')));
        lonRow.set_text(String(settings.get_double('location-longitude')));
        nameRow.set_text(settings.get_string('location-name'));
        latRow.connect('changed',  () => { const v = parseFloat(latRow.get_text());  if (!isNaN(v)) settings.set_double('location-latitude', v); });
        lonRow.connect('changed',  () => { const v = parseFloat(lonRow.get_text());  if (!isNaN(v)) settings.set_double('location-longitude', v); });
        nameRow.connect('changed', () => settings.set_string('location-name', nameRow.get_text()));
        manualGroup.add(latRow);
        manualGroup.add(lonRow);
        manualGroup.add(nameRow);
        page.add(manualGroup);

        let _results = [];
        const runSearch = async () => {
            const q = searchEntry.get_text().trim();
            if (!q) return;
            searchBtn.set_sensitive(false); searchBtn.set_label('…');
            try {
                _results = await geocodeSearch(q);
                resultsCombo.remove_all();
                if (_results.length === 0) { resultsRow.set_subtitle('No results found.'); resultsRow.set_visible(true); applyBtn.set_sensitive(false); return; }
                _results.forEach(r => { const parts = [r.name, r.admin1, r.country].filter(Boolean); resultsCombo.append_text(parts.join(', ')); });
                resultsCombo.set_active(0); resultsRow.set_subtitle(''); resultsRow.set_visible(true); applyBtn.set_sensitive(true);
            } catch (e) { resultsRow.set_subtitle(`Error: ${e.message}`); resultsRow.set_visible(true); applyBtn.set_sensitive(false); }
            finally { searchBtn.set_sensitive(true); searchBtn.set_label('Search'); }
        };
        searchBtn.connect('clicked', () => runSearch());
        searchEntry.connect('activate', () => runSearch());
        applyBtn.connect('clicked', () => {
            const idx = resultsCombo.get_active();
            if (idx < 0 || idx >= _results.length) return;
            const r = _results[idx];
            const parts = [r.name, r.admin1, r.country].filter(Boolean);
            settings.set_double('location-latitude', r.latitude);
            settings.set_double('location-longitude', r.longitude);
            settings.set_string('location-name', parts.join(', '));
            settings.set_boolean('location-auto', false);
            latRow.set_text(String(r.latitude)); lonRow.set_text(String(r.longitude)); nameRow.set_text(parts.join(', ')); autoRow.set_active(false);
        });
        return page;
    }

    _apiPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Weather API', icon_name: 'network-wireless-symbolic'});

        const sourceGroup = new Adw.PreferencesGroup({title: 'Data Source', description: 'Open-Meteo is free and requires no API key. WeatherAPI.com requires a free account.'});
        const providerRow = new Adw.ComboRow({title: 'Provider', subtitle: 'Which weather service to use', model: Gtk.StringList.new(['Open-Meteo (free, no key)', 'WeatherAPI.com (bring your own key)'])});
        const currentProvider = settings.get_string('api-provider');
        providerRow.set_selected(currentProvider === 'weatherapi' ? 1 : 0);
        const wApiKeyRow = new Adw.PasswordEntryRow({title: 'WeatherAPI.com key', show_apply_button: true});
        wApiKeyRow.set_text(settings.get_string('weatherapi-key'));
        wApiKeyRow.set_visible(currentProvider === 'weatherapi');
        providerRow.connect('notify::selected', () => { const isWApi = providerRow.get_selected() === 1; settings.set_string('api-provider', isWApi ? 'weatherapi' : 'open-meteo'); wApiKeyRow.set_visible(isWApi); });
        wApiKeyRow.connect('apply', () => settings.set_string('weatherapi-key', wApiKeyRow.get_text()));
        sourceGroup.add(providerRow);
        sourceGroup.add(wApiKeyRow);
        page.add(sourceGroup);

        const pollenGroup = new Adw.PreferencesGroup({title: 'Pollen Data', description: 'Tomorrow.io provides global tree/grass/weed pollen indices. A free API key is required.'});
        const tomorrowKeyRow = new Adw.PasswordEntryRow({title: 'Tomorrow.io API key', show_apply_button: true});
        tomorrowKeyRow.set_text(settings.get_string('tomorrow-api-key'));
        tomorrowKeyRow.connect('apply', () => settings.set_string('tomorrow-api-key', tomorrowKeyRow.get_text()));
        pollenGroup.add(tomorrowKeyRow);
        page.add(pollenGroup);

        const intervalGroup = new Adw.PreferencesGroup({title: 'Refresh'});
        const intervalRow = new Adw.SpinRow({title: 'Update interval', subtitle: 'How often to refresh weather data (minutes)', adjustment: new Gtk.Adjustment({lower: 5, upper: 180, step_increment: 5, value: settings.get_int('update-interval')})});
        settings.bind('update-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        intervalGroup.add(intervalRow);
        page.add(intervalGroup);
        return page;
    }

    _unitsPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Units', icon_name: 'weather-clear-symbolic'});
        const group = new Adw.PreferencesGroup({title: 'Temperature'});
        const unitRow = new Adw.ComboRow({title: 'Temperature unit', model: Gtk.StringList.new(['Fahrenheit (°F)', 'Celsius (°C)'])});
        const currentUnit = settings.get_string('temperature-unit');
        unitRow.set_selected(currentUnit === 'celsius' ? 1 : 0);
        unitRow.connect('notify::selected', () => settings.set_string('temperature-unit', unitRow.get_selected() === 1 ? 'celsius' : 'fahrenheit'));
        group.add(unitRow);
        page.add(group);
        return page;
    }
}
