# ha-groundwater-level

Home Assistant Lovelace card that shows a groundwater level as an animated liquid fill.
The fill width and color follow configurable thresholds; a tap opens a popup with the history graph.

- Single JavaScript file, **no dependencies**: no Mushroom, card-mod or browser_mod
- Up to 5 threshold levels, each with color, fill width, wave animation on/off and wave speed
- Second line from an entity (with optional prefix text) or a Jinja2 template
- Maintenance and "no data" states: a missing value is shown as a grey fill, never as a fake level
- Visual editor for all options
- Built-in history popup (no browser_mod needed)

The card works with any numeric sensor. The [data source section](#data-source-berlin-wasserportal)
shows a ready-made REST sensor for groundwater stations of the Berlin Wasserportal.

## Requirements

| What | Needed for | Notes |
|---|---|---|
| Home Assistant with sections views | the card | Tested with Home Assistant 2026.9 |
| A numeric sensor with the groundwater level | the card | e.g. the REST sensor below; the unit is taken from the sensor |
| Recorder history of that sensor | the history popup | If you use recorder `include`/`exclude` filters, make sure the level sensor is recorded |
| A sensor with the measurement date | optional second line | e.g. the REST date sensor below |
| A binary sensor that is `on` during maintenance | optional maintenance state | e.g. the REST binary sensor below |
| HACS | optional | only as an installation method |

No other custom cards or integrations are required.

## Installation

### HACS (custom repository)

1. HACS → ⋮ → **Custom repositories** → add `https://github.com/RothMick/ha-groundwater-level`, type **Dashboard**.
2. Search for **Groundwater Level Card**, download it.
3. Reload the browser.

### Manual

1. Copy `ha-groundwater-level-card.js` to `/config/www/`.
2. Settings → Dashboards → ⋮ → **Resources** → add `/local/ha-groundwater-level-card.js` as **JavaScript module**.
3. Reload the browser.

## Data source: Berlin Wasserportal

The Berlin Wasserportal publishes the measurements of its groundwater stations as CSV. One REST
request per day provides all three entities the card can use.

### Finding your station number

Open [wasserportal.berlin.de](https://wasserportal.berlin.de), select the groundwater level theme
and pick a station on the map. The station number is the `station=` parameter in the page URL; the
CSV export also lists it as `Messstellennummer`. Replace `STATION_ID` below with that number.

### The REST request

```
https://wasserportal.berlin.de/station.php?anzeige=d&station=STATION_ID&smode=c&thema=gws&exportthema=gw&sreihe=ew&sdatum=DD.MM.YYYY&senddatum=DD.MM.YYYY
```

`sdatum` and `senddatum` are the start and end of the period (`DD.MM.YYYY`); leave the other
parameters as they are. The response is a CSV file: a few header lines describing the station,
followed by one line per measurement, date and value separated by `;` with a decimal comma:

```
Messstellennummer;STATION_ID
...
"Geländeoberkante (GOK) (m ü. NHN)";42,36
...
14.09.2026;38,75
15.09.2026;38,76
```

Values are in `m ü. NHN` (metres above the German sea-level datum NHN). New values usually appear
with a delay of several days.

### REST sensor configuration

Add this to `configuration.yaml` and restart Home Assistant:

```yaml
rest:
  - resource_template: >
      {% set end = now() %}
      {% set start = end - timedelta(days=365) %}
      https://wasserportal.berlin.de/station.php?anzeige=d&station=STATION_ID&smode=c&thema=gws&exportthema=gw&sreihe=ew&sdatum={{ start.strftime('%d.%m.%Y') }}&senddatum={{ end.strftime('%d.%m.%Y') }}
    scan_interval: 86400
    timeout: 30
    headers:
      User-Agent: HomeAssistant
    encoding: "iso-8859-1"

    sensor:
      - name: "Groundwater level"
        unique_id: groundwater_level_value
        unit_of_measurement: "m ü. NHN"
        state_class: measurement
        availability: >
          {{ value is defined and value is string
             and value.splitlines()
                 | select('match','^"?[0-9]{2}\\.[0-9]{2}\\.[0-9]{4};') | list | count > 0 }}
        value_template: >
          {% set data = value.splitlines()
             | select('match','^"?[0-9]{2}\\.[0-9]{2}\\.[0-9]{4};') | list %}
          {{ (data | last | replace('"','')).split(';')[1] | replace(',','.') | float }}

      - name: "Groundwater level date"
        unique_id: groundwater_level_date
        availability: >
          {{ value is defined and value is string
             and value.splitlines()
                 | select('match','^"?[0-9]{2}\\.[0-9]{2}\\.[0-9]{4};') | list | count > 0 }}
        value_template: >
          {% set data = value.splitlines()
             | select('match','^"?[0-9]{2}\\.[0-9]{2}\\.[0-9]{4};') | list %}
          {{ (data | last | replace('"','')).split(';')[0] }}

    binary_sensor:
      - name: "Wasserportal maintenance"
        unique_id: wasserportal_maintenance
        device_class: problem
        value_template: "{{ 'Wartungsarbeiten' in value }}"
```

This creates `sensor.groundwater_level`, `sensor.groundwater_level_date` and
`binary_sensor.wasserportal_maintenance`.

Why it is built this way:

- **The "no value" case belongs in `availability`, never in `value_template`.** A sensor with
  `state_class: measurement` must not return a placeholder string such as `unknown`; Home Assistant
  then refuses to create the entity at all. With `availability`, a response without measurements
  makes the sensor `unavailable` and the `value_template` is not evaluated.
- **Maintenance returns HTTP 200.** During maintenance the portal answers with an HTML page
  ("Wartungsarbeiten") instead of the CSV, without an error status. The binary sensor detects it by
  its content and costs no extra request, because it shares the same REST resource.
- **`scan_interval: 86400`** fetches once a day. After a maintenance window the sensors may stay
  `unavailable` for up to 24 hours until the next fetch.

## Configuration

```yaml
type: custom:ha-groundwater-level-card
entity: sensor.groundwater_level
maintenance_entity: binary_sensor.wasserportal_maintenance
subtitle_entity: sensor.groundwater_level_date
subtitle_prefix: Measured
```

| Option | Default | Description |
|---|---|---|
| `entity` | – (required) | Numeric level sensor |
| `maintenance_entity` | – | Binary sensor; `on` shows "Under maintenance" / "Data source under maintenance" |
| `icon` | `mdi:wave-arrow-up` | Icon in normal operation (`mdi:progress-wrench` during maintenance) |
| `unit` | unit of the sensor | Unit shown after the value |
| `subtitle_entity` | – | Second line from an entity, formatted like in Home Assistant |
| `subtitle_prefix` | – | Text in front of the entity value, e.g. `Measured` |
| `subtitle_template` | – | Second line as a Jinja2 template (takes precedence over `subtitle_entity`) |
| `levels` | see below | Up to 5 threshold levels |
| `hours_to_show` | `4380` | Period of the history popup in hours (4380 ≈ 6 months) |
| `popup_title` | `Groundwater level history` | Title of the history popup |

Without `subtitle_entity` and `subtitle_template` the card has no second line.

### Second line

The editor offers **No subtitle**, **Entity** or **Jinja2 template**. Templates are rendered by Home
Assistant and update live. Their output may contain basic HTML, for example a colored part:

```yaml
subtitle_template: >
  Measured <span style="color:#ffd54f">{{ states('sensor.groundwater_level_date') }}</span>
```

Scripts, event handlers, frames and links are stripped from the output.

### Threshold levels

```yaml
levels:
  - below: 37         # applies to values below 37
    fill: 60          # fill width in %
    color: "#966d1d"  # #hex, "r, g, b", rgb(), hsl(), color name or var(--…)
    speed: 8          # wave: seconds per turn (default 8)
  - below: 39
    fill: 80
    color: "#1d8296"
    animation: false  # no wave, straight vertical edge exactly at 80 %
  - fill: 95          # no below: applies to all values above
    color: "#961d1d"
```

- The card sorts the levels by `below` itself; the order in the list does not matter.
- Without `levels` the three levels above are used (with animation on all of them).
- `animation` is on by default: the bar ends 60 px before the fill level and the rotating wave fills
  up the rest. With `animation: false` there is no wave; the bar reaches exactly to the fill level
  and ends with a straight vertical edge. `speed` is then ignored.
- If the level sensor has no value, the card shows "No data" with a grey fill at 100 % and a slow
  wave. This state is not configurable.

### Visual editor

All options can be set in the visual editor. The thresholds live in their own collapsible section
with up to 5 levels; each level has its threshold, fill slider, animation switch, wave speed
(hidden when the animation is off) and a color field. The color field works like in
[ha-glow-card](https://github.com/RothMick/ha-glow-card): click the swatch for a color picker or type
any CSS color.

### History popup

A tap (or Enter/Space) opens a dialog with Home Assistant's built-in `history-graph` card for the
level sensor. Close it with the × button, a click outside or Escape. The popup needs no browser_mod.

The dialog is attached inside `<home-assistant>`'s shadow root, like Home Assistant's own dialogs.
The history graph reads its theme data through a Lit context provided by `<home-assistant>`; a
dialog attached to `document.body` would open, but the graph would stay empty.

## Changelog

| Version | Date | Changes |
|---|---|---|
| 1.3.0 | 2026-09-27 | English UI, editor and documentation. Generic maintenance text ("Data source under maintenance"). The stub config finds sensors with `groundwater` or `grundwasser` in the entity ID. First public release. |
| 1.2.0 | 2026-09-27 | Per-level `animation` switch: without animation no wave and a straight vertical edge at the fill level. |
| 1.1.0 | 2026-09-27 | Visual editor. Up to 5 threshold levels with color, fill width and wave speed. Second line from an entity or a Jinja2 template. Text shadow removed. `date_entity`/`name` replaced by `subtitle_entity`/`subtitle_prefix`. |
| 1.0.0 | 2026-09-26 | First version: liquid-fill tile with maintenance and "no data" states and a history popup, without Mushroom, card-mod or browser_mod. |

## License

[MIT](LICENSE)
