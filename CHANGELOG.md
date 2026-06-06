# Changelog

## v7 — 2026-06-05

- Let pill icons and text scale with the user's theme
- Fix pill icon clipping by switching to px sizes and trimming SVG viewBox padding
- Floor precip sparkline width to avoid 0-width Cogl texture allocation
- Make tides a NOAA-only (US) feature; drop WeatherAPI.com source
- Render tides as detail-grid cells and grow the Astronomy tab to fit
- Refresh the tide line immediately when the tide source changes
- Add opt-in tide line to the Astronomy tab (WeatherAPI.com or NOAA)
- Treat leaving the Map tab as a user pause for the radar loop
- Guard async continuations against teardown; harden sparkline repaint
- Replace emoji weather glyphs with bundled Meteocons SVG icons
- Add hourly precip sparkline + snowfall breakout to Current tab
- Add last-24h precip total to Current tab (multi-model max)
- Add Alerts tab with full NWS alert text
- Performance: reparent indicator on move, trim per-fetch waste
- Move USNO astronomy to its own once-per-calendar-day cadence
- Add keyless USNO solar noon and next new/full moon dates
- Load radar lazily on Map tab view; restyle visual prefs in place
- Cache GeoClue client and skip rendering while menu is closed
- Backfill 7-day wind direction from Open-Meteo for WeatherAPI
- Pause the radar Map loop by default until play is pressed
- Add play/pause control to the radar Map tab
- Animate Map tab radar loop over past + nowcast frames
- Move sun/moon data out of Now tab into a provider-driven Astronomy tab
- Add gusts, dew point, visibility, cloud cover, and sun times to Now tab

## v6 — 2026-05-23

- Show night icon variants after dark
- Default Map-tab external links to radar layers
- Add Medium (1.25×) panel size option

## v5 — 2026-05-20

- Add Weather Map tab with RainViewer radar over Esri imagery
- Add configurable radar overlay refresh interval
- Sync Location prefs entries when GeoClue updates coordinates
- Gate fetch/parse error logs behind a DEBUG flag
- Add OpenWeatherMap as a global air quality source
- Scope WeatherAI.io to astronomy data only
- Backfill 7-day wind direction from Open-Meteo when WeatherAI overlay lacks it
- Add panel size setting with original and large (1.5×) options
- Add wind column to hourly and 7-day forecasts

## v4 — 2026-05-19

- Add WeatherAI.io overlay for 7-day forecast and Astronomy tab
- Add humidity column to hourly and 7-day forecasts
- Wrap long current-conditions descriptions instead of clipping

## v3 — 2026-05-12

- Add hourly precip chance; fix 7-day forecast alignment

## v2 — 2026-05-11

- Replace Ambee with AirNow; add wind/pressure unit settings
- Add light/dark mode toggle and pressure trend indicator
- Add separate weather/pollen fetch intervals
- Add API call frequency setting
- Add tooltips; fix pollen display and weather alerts
