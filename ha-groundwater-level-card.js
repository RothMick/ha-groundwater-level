/**
 * ha-groundwater-level-card v1.4.1
 * Groundwater level tile with liquid-fill animation and history popup.
 * No dependencies (no Mushroom, card-mod or browser_mod). Details: README.md
 */

const CARD_VERSION = '1.4.1';
const MAX_LEVELS = 5;
const DEFAULT_SPEED = 8;
const DEFAULT_FILL = 80;

const DEFAULT_LEVELS = [
  { below: 37, fill: 60, color: '#966d1d', speed: 8 },
  { below: 39, fill: 80, color: '#1d8296', speed: 8 },
  { fill: 95, color: '#961d1d', speed: 8 },
];
const NO_DATA = { fill: 100, color: '#5a5a5a', speed: 20 };
const MISSING = ['unavailable', 'unknown', 'none', ''];
const RGB_TRIPLE = /^\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*$/;

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const isMissing = s => MISSING.includes(String(s ?? '').toLowerCase());

const subtitleMode = c => (c.subtitle_template ? 'template' : c.subtitle_entity ? 'entity' : 'none');

const levelLimit = l => (l.below == null || l.below === '' || isNaN(Number(l.below)) ? Infinity : Number(l.below));

const isCssColor = v => typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports('color', v);

// Colors as in ha-glow-card: an "r, g, b" triple or any CSS color.
const cssColor = raw => {
  const v = String(raw ?? '').trim();
  if (RGB_TRIPLE.test(v)) return `rgb(${v})`;
  return v && isCssColor(v) ? v : null;
};

const colorToHex = raw => {
  const v = String(raw ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const m3 = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toLowerCase();
  const m = v.match(/^(?:rgba?\()?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (!m) return null;
  return '#' + [m[1], m[2], m[3]].map(n => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
};

// Template output is rendered as HTML (<span style="color:…">), but only an allowlist
// of harmless formatting survives: no scripts, event handlers, frames or links.
const HTML_ALLOWED_TAGS = new Set([
  'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SMALL', 'BIG', 'SUB', 'SUP', 'BR',
  'SPAN', 'DIV', 'P', 'FONT', 'MARK', 'CODE', 'HA-ICON', 'IMG',
]);
const HTML_DROPPED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'TEMPLATE',
  'NOSCRIPT', 'TEXTAREA', 'TITLE', 'SVG', 'MATH', 'LINK', 'META', 'BASE',
  'FORM', 'INPUT', 'BUTTON', 'SELECT',
]);
const HTML_ALLOWED_ATTRS = new Set(['style', 'class', 'title', 'color', 'icon', 'src', 'alt', 'width', 'height']);

const sanitizeHtml = html => {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const clean = parent => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) continue;
      if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); continue; }
      const tag = node.tagName.toUpperCase();
      if (HTML_DROPPED_TAGS.has(tag)) { node.remove(); continue; }
      clean(node);
      if (!HTML_ALLOWED_TAGS.has(tag)) { node.replaceWith(...node.childNodes); continue; }
      for (const { name, value } of [...node.attributes]) {
        const n = name.toLowerCase();
        const badSrc = n === 'src' && !/^(https?:\/\/|\/(?!\/))/i.test(value.trim());
        if (!HTML_ALLOWED_ATTRS.has(n) || badSrc) node.removeAttribute(name);
      }
    }
  };
  clean(tpl.content);
  return tpl.content;
};

const renderTemplateResult = (el, result) => {
  const text = result == null ? '' : String(result).trim();
  if (!/[<&]/.test(text)) {
    if (el.textContent !== text || el.childElementCount) el.textContent = text;
    return;
  }
  el.replaceChildren(sanitizeHtml(text));
};

class HaGroundwaterLevelCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement('ha-groundwater-level-card-editor');
  }

  static getStubConfig(hass) {
    const entity = Object.keys(hass?.states || {}).find(e => /^sensor\..*(groundwater|grundwasser)/.test(e)) || '';
    return { entity };
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._sig = null;
    this._popup = null;
    this._tpl = {};
    this._tplResult = null;
  }

  setConfig(config) {
    if (!config?.entity) throw new Error('entity is required');
    this._config = {
      hours_to_show: 4380,
      popup_title: 'Groundwater level history',
      ...config,
    };
    const levels = Array.isArray(config.levels) && config.levels.length ? config.levels : DEFAULT_LEVELS;
    this._levels = [...levels].sort((a, b) => levelLimit(a) - levelLimit(b));
    this._sig = null;
    this._buildShell();
    if (this._hass) {
      this._syncTemplate();
      this._update();
    }
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (this._popup) this._popup.card.hass = hass;
    if (!this._config) return;
    if (first) this._syncTemplate();
    this._update();
  }

  getCardSize() { return 2; }

  getGridOptions() { return { columns: 12, rows: 'auto', min_columns: 6 }; }

  // Re-subscribe the template after a DOM move (relayout, tab switch).
  connectedCallback() {
    if (this._hass && this._config) this._syncTemplate();
  }

  disconnectedCallback() {
    this._closePopup();
    this._unsubscribeTpl();
  }

  _buildShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: 100%; }
        ha-card {
          position: relative; overflow: hidden; isolation: isolate;
          height: 100%; min-height: 80px; box-sizing: border-box;
          border-radius: 12px; cursor: pointer;
          display: flex; align-items: center;
          padding: 0 12px 0 84px;
          color: white;
          --liq-color: ${NO_DATA.color};
          --liq-level: ${NO_DATA.fill}%;
          --wave-speed: ${NO_DATA.speed}s;
        }
        .bar, .wave { position: absolute; background: var(--liq-color); }
        .bar {
          top: 0; left: 0; bottom: 0; z-index: -1;
          width: calc(var(--liq-level) - 60px);
          transition: width .5s cubic-bezier(.25, .1, .25, 1), background .5s ease;
        }
        .wave {
          z-index: -2; width: 120px; height: 120px; border-radius: 40%;
          left: calc(var(--liq-level) - 120px); top: calc(50% - 60px);
          animation: spin var(--wave-speed) linear infinite;
          transition: left .5s cubic-bezier(.25, .1, .25, 1), background .5s ease;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        /* Without animation: no wave, the bar ends with a straight edge exactly at the fill level */
        ha-card.static .wave { display: none; }
        ha-card.static .bar { width: var(--liq-level); }
        /* The circle overhangs the top-left corner, like the original Mushroom tile */
        .shape {
          position: absolute; left: -9px; top: -9px; width: 68px; height: 68px;
          border-radius: 50%; background: rgba(255, 255, 255, .2);
          display: flex; align-items: center; justify-content: center;
        }
        ha-icon { --mdc-icon-size: 45px; display: flex; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, .5)); }
        .text { min-width: 0; }
        .primary, .secondary { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .primary {
          font-size: clamp(20px, 2vw, 28px); line-height: clamp(22px, 2vw, 33.6px);
          font-weight: 400; letter-spacing: .1px;
        }
        .secondary { font-size: 14px; line-height: 16px; letter-spacing: .4px; }
        ha-card:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
      </style>
      <ha-card tabindex="0" role="button">
        <div class="bar"></div><div class="wave"></div>
        <div class="shape"><ha-icon></ha-icon></div>
        <div class="text"><div class="primary"></div><div class="secondary"></div></div>
      </ha-card>`;
    const card = this.shadowRoot.querySelector('ha-card');
    card.addEventListener('click', () => this._openPopup());
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._openPopup(); }
    });
  }

  _state(id) { return id ? this._hass.states[id] : undefined; }

  _update() {
    const c = this._config;
    const levelObj = this._state(c.entity);
    const subObj = this._state(c.subtitle_entity);
    const maint = this._state(c.maintenance_entity)?.state === 'on';
    const raw = levelObj?.state ?? 'unavailable';
    const sig = [raw, subObj?.state, maint, levelObj?.attributes.unit_of_measurement].join('|');
    if (sig === this._sig) return;
    this._sig = sig;
    this._maint = maint;

    const missing = isMissing(raw) || isNaN(parseFloat(raw));
    const unit = c.unit ?? levelObj?.attributes.unit_of_measurement ?? '';
    const primary = maint ? 'Under maintenance' : missing ? 'No data' : `${raw} ${unit}`.trim();

    const style = missing ? NO_DATA : this._levelFor(parseFloat(raw));
    const fill = Number(style.fill);
    const card = this.shadowRoot.querySelector('ha-card');
    card.style.setProperty('--liq-color', this._color(style.color));
    card.style.setProperty('--liq-level', `${Number.isFinite(fill) ? Math.min(100, Math.max(0, fill)) : DEFAULT_FILL}%`);
    card.style.setProperty('--wave-speed', `${Number(style.speed) > 0 ? Number(style.speed) : DEFAULT_SPEED}s`);
    card.classList.toggle('static', style.animation === false);
    this.shadowRoot.querySelector('ha-icon').icon = maint ? 'mdi:progress-wrench' : (c.icon || 'mdi:wave-arrow-up');
    this.shadowRoot.querySelector('.primary').textContent = primary;
    this._renderSecondary();
  }

  _renderSecondary() {
    const c = this._config;
    const el = this.shadowRoot.querySelector('.secondary');
    const mode = subtitleMode(c);
    el.hidden = mode === 'none' && !this._maint;

    if (this._maint) {
      el.textContent = 'Data source under maintenance';
    } else if (mode === 'entity') {
      const obj = this._state(c.subtitle_entity);
      const prefix = c.subtitle_prefix || '';
      if (!obj || isMissing(obj.state)) {
        el.textContent = prefix ? `${prefix} – no data` : 'No data';
      } else {
        let val = obj.state;
        try { val = this._hass.formatEntityState?.(obj) ?? val; } catch { /* raw state */ }
        el.textContent = prefix ? `${prefix} ${val}` : val;
      }
    } else if (mode === 'template') {
      renderTemplateResult(el, this._tplResult);
    } else {
      el.textContent = '';
    }

    const card = this.shadowRoot.querySelector('ha-card');
    const label = [this.shadowRoot.querySelector('.primary').textContent, el.hidden ? '' : el.textContent];
    card.setAttribute('aria-label', label.filter(Boolean).join(', '));
  }

  _levelFor(v) {
    return this._levels.find(l => v < levelLimit(l)) || this._levels[this._levels.length - 1];
  }

  _color(raw) {
    const css = cssColor(raw);
    if (css) return css;
    if (this._badColor !== raw) {
      this._badColor = raw;
      console.warn(`ha-groundwater-level-card: invalid color "${raw}"`);
    }
    return NO_DATA.color;
  }

  _syncTemplate() {
    this._subscribeTpl(subtitleMode(this._config) === 'template' ? this._config.subtitle_template : null);
  }

  _unsubscribeTpl() {
    this._tpl.unsub?.();
    // Always clear the slot: an in-flight subscribe sees its token is gone and discards itself.
    this._tpl = {};
  }

  async _subscribeTpl(template) {
    if (!template) { this._unsubscribeTpl(); return; }
    if (template === this._tpl.active) return;
    this._unsubscribeTpl();
    this._tplResult = null;
    if (!this._hass?.connection) return;

    const token = {};
    this._tpl = { active: template, token };
    try {
      const unsub = await this._hass.connection.subscribeMessage(
        msg => {
          if (this._tpl.token !== token) return;
          if (msg.result !== undefined) this._tplResult = msg.result;
          else if (msg.error) this._tplResult = `⚠ ${msg.error.message ?? msg.error}`;
          else return;
          this._renderSecondary();
        },
        { type: 'render_template', template, variables: {}, report_errors: true },
      );
      if (this._tpl.token === token) this._tpl.unsub = unsub;
      else unsub();
    } catch (err) {
      if (this._tpl.token !== token) return;
      this._tpl.active = null;
      this._tplResult = `⚠ Template error: ${err.message}`;
      this._renderSecondary();
    }
  }

  async _openPopup() {
    if (this._popup) return;
    const helpers = await window.loadCardHelpers?.();
    if (!helpers) {
      this.dispatchEvent(new CustomEvent('hass-more-info', {
        detail: { entityId: this._config.entity }, bubbles: true, composed: true,
      }));
      return;
    }
    const c = this._config;
    const card = helpers.createCardElement(c.statistic_id
      ? {
        type: 'statistics-graph',
        // The card links its title to the history panel, which cannot open external
        // statistics (domain:id) and reports "entity not found" — no title for those.
        ...(c.statistic_id.includes(':') ? {} : { title: 'History' }),
        entities: [c.statistic_id],
        period: 'day',
        stat_types: ['mean'],
        chart_type: 'line',
        fit_y_data: true,
        days_to_show: Math.max(1, Math.round(c.hours_to_show / 24)),
      }
      : {
        type: 'history-graph',
        title: 'History',
        hours_to_show: c.hours_to_show,
        entities: [c.entity],
      });
    card.hass = this._hass;

    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .backdrop {
          position: fixed; inset: 0; z-index: 9999;
          background: rgba(0, 0, 0, .5);
          display: flex; align-items: center; justify-content: center;
          padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
          box-sizing: border-box;
        }
        .dialog {
          width: min(100%, 720px); max-height: 100%; overflow: auto;
          background: var(--card-background-color, var(--ha-card-background, #1c1c1c));
          color: var(--primary-text-color);
          border-radius: var(--ha-dialog-border-radius, 24px);
          box-shadow: 0 8px 32px rgba(0, 0, 0, .4);
          font-family: var(--ha-font-family-body, Roboto, sans-serif);
        }
        header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 12px 4px 24px; font-size: 20px;
        }
        button {
          border: none; background: none; color: inherit; cursor: pointer;
          width: 40px; height: 40px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
        }
        button:hover { background: rgba(127, 127, 127, .15); }
        .content { padding: 0 8px 8px; }
      </style>
      <div class="backdrop">
        <div class="dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(this._config.popup_title)}">
          <header><span>${escapeHtml(this._config.popup_title)}</span>
            <button aria-label="Close"><ha-icon icon="mdi:close"></ha-icon></button></header>
          <div class="content"></div>
        </div>
      </div>`;
    root.querySelector('.content').appendChild(card);
    root.querySelector('.backdrop').addEventListener('click', e => {
      if (e.target === e.currentTarget) this._closePopup();
    });
    root.querySelector('button').addEventListener('click', () => this._closePopup());
    const onKey = e => { if (e.key === 'Escape') this._closePopup(); };
    document.addEventListener('keydown', onKey);
    // The graph reads theme data via Lit context from <home-assistant>; under document.body it stays empty.
    (document.querySelector('home-assistant')?.shadowRoot ?? document.body).appendChild(host);
    this._popup = { host, card, onKey };
    root.querySelector('button').focus();
  }

  _closePopup() {
    if (!this._popup) return;
    document.removeEventListener('keydown', this._popup.onKey);
    this._popup.host.remove();
    this._popup = null;
  }
}

class HaGroundwaterLevelCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._subOverride = null;
    this._levelsOpen = false;
    this._rendered = false;
  }

  set hass(hass) {
    this._hass = hass;
    this.shadowRoot.querySelectorAll('ha-form').forEach(f => { f.hass = hass; });
  }

  setConfig(config) {
    // HA echoes every change back; re-rendering would steal focus from the input.
    if (this._rendered && JSON.stringify(config) === JSON.stringify(this._config)) return;
    this._config = JSON.parse(JSON.stringify(config || {}));
    if (subtitleMode(this._config) !== 'none') this._subOverride = null;
    this._render();
  }

  _subMode() {
    const mode = subtitleMode(this._config);
    return mode !== 'none' ? mode : (this._subOverride || 'none');
  }

  _levels() {
    const levels = Array.isArray(this._config.levels) && this._config.levels.length ? this._config.levels : DEFAULT_LEVELS;
    return JSON.parse(JSON.stringify(levels));
  }

  _patch(values) {
    const cfg = { ...this._config, ...values };
    Object.keys(cfg).forEach(k => { if (cfg[k] === '' || cfg[k] == null) delete cfg[k]; });
    this._config = cfg;
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: cfg }, bubbles: true, composed: true }));
  }

  _setLevel(i, values) {
    const levels = this._levels();
    const level = { ...levels[i], ...values };
    Object.keys(level).forEach(k => { if (level[k] === '' || level[k] == null) delete level[k]; });
    levels[i] = level;
    this._patch({ levels });
  }

  _el(id) { return this.shadowRoot.getElementById(id); }

  _render() {
    const mode = this._subMode();
    const levels = this._levels();
    this.shadowRoot.innerHTML = `
      <style>${this._css()}</style>
      <ha-form id="form-main"></ha-form>

      <div class="section">Second line</div>
      <ha-form id="form-sub-mode"></ha-form>
      <div id="sub-entity-wrap" class="${mode !== 'entity' ? 'hidden' : ''}">
        <ha-form id="form-sub-entity"></ha-form>
      </div>
      <div id="sub-tpl-wrap" class="field ${mode !== 'template' ? 'hidden' : ''}">
        <label for="subtitle_template">Jinja2 template</label>
        <textarea id="subtitle_template" placeholder="Measured {{ states('sensor.abc') }}"></textarea>
        <div class="hint">Evaluated server-side. Basic HTML (e.g. &lt;span style&gt;) is rendered; scripts and event handlers are stripped.</div>
      </div>

      <details id="levels" ${this._levelsOpen ? 'open' : ''}>
        <summary>Thresholds <span class="count">${levels.length}/${MAX_LEVELS}</span></summary>
        <div class="levels-body">
          <div class="hint">The card sorts levels by threshold. A level without a threshold applies to all values above.</div>
          ${levels.map((_, i) => this._levelHtml(i, levels.length)).join('')}
          <button id="add-level" class="addbtn" ${levels.length >= MAX_LEVELS ? 'disabled' : ''}>+ Add level</button>
        </div>
      </details>

      <div class="section">Popup</div>
      <ha-form id="form-popup"></ha-form>
      <div class="hint">With a long-term statistic the popup shows its daily values instead of the sensor history, e.g. measurements imported with their real dates.</div>
    `;
    this._rendered = true;
    this._initForms(levels);
    this._wireNative(levels);
  }

  _levelHtml(i, count) {
    return `
      <div class="level">
        <div class="level-head">
          <span>Level ${i + 1}</span>
          <button class="icon-btn" data-remove="${i}" ${count <= 1 ? 'disabled' : ''}
            title="Remove level" aria-label="Remove level ${i + 1}"><ha-icon icon="mdi:delete-outline"></ha-icon></button>
        </div>
        <ha-form id="form-level-${i}"></ha-form>
        <div class="color-field">
          <div class="color-swatch no-color" id="lvl-${i}-swatch" title="Pick color">
            <input type="color" id="lvl-${i}-picker" class="color-hidden-input" aria-label="Color of level ${i + 1}">
          </div>
          <ha-form id="form-lvl-${i}-color"></ha-form>
        </div>
        <div class="hint">#hex, r, g, b, rgb(), hsl(), color names or var(--…)</div>
      </div>`;
  }

  _setupForm(id, schema, data, onChange) {
    const form = this._el(id);
    if (!form) return;
    form.hass = this._hass;
    form.schema = schema;
    form.data = data;
    form.computeLabel = s => s.label ?? s.name;
    form.addEventListener('value-changed', ev => onChange(ev.detail.value || {}));
  }

  _initForms(levels) {
    const c = this._config;
    const unit = this._hass?.states[c.entity]?.attributes.unit_of_measurement || '';

    this._setupForm('form-main', [
      { name: 'entity', label: 'Level sensor', required: true, selector: { entity: { domain: 'sensor' } } },
      { name: 'maintenance_entity', label: 'Maintenance sensor (optional)', selector: { entity: { domain: 'binary_sensor' } } },
      {
        type: 'grid', name: '', schema: [
          { name: 'icon', label: 'Icon', selector: { icon: {} } },
          { name: 'unit', label: 'Unit (empty = from sensor)', selector: { text: {} } },
        ],
      },
    ], {
      entity: c.entity || '', maintenance_entity: c.maintenance_entity || '', icon: c.icon || '', unit: c.unit || '',
    }, v => this._patch({
      entity: v.entity, maintenance_entity: v.maintenance_entity, icon: v.icon, unit: v.unit,
    }));

    this._setupForm('form-sub-mode', [
      { name: 'sub_mode', label: 'Source', selector: { select: { options: [
        { value: 'none', label: 'No subtitle' },
        { value: 'entity', label: 'Entity' },
        { value: 'template', label: 'Jinja2 template' },
      ] } } },
    ], { sub_mode: this._subMode() }, v => {
      const mode = v.sub_mode || 'none';
      this._subOverride = mode === 'none' ? null : mode;
      this._el('sub-entity-wrap').classList.toggle('hidden', mode !== 'entity');
      this._el('sub-tpl-wrap').classList.toggle('hidden', mode !== 'template');
      const patch = {};
      if (mode !== 'entity') Object.assign(patch, { subtitle_entity: null, subtitle_prefix: null });
      if (mode !== 'template') patch.subtitle_template = null;
      if (mode === 'template') {
        const tpl = this._el('subtitle_template').value.trim();
        if (tpl) patch.subtitle_template = tpl;
      }
      this._patch(patch);
    });

    this._setupForm('form-sub-entity', [
      { name: 'subtitle_entity', label: 'Entity', selector: { entity: {} } },
      { name: 'subtitle_prefix', label: 'Prefix text (optional)', selector: { text: {} } },
    ], { subtitle_entity: c.subtitle_entity || '', subtitle_prefix: c.subtitle_prefix || '' },
    v => this._patch({ subtitle_entity: v.subtitle_entity, subtitle_prefix: v.subtitle_prefix }));

    const levelSchema = animated => [
      { name: 'below', label: `Below${unit ? ` (${unit})` : ''}`, selector: { number: { step: 'any', mode: 'box' } } },
      { name: 'fill', label: 'Fill level', selector: { number: { min: 0, max: 100, step: 1, mode: 'slider', unit_of_measurement: '%' } } },
      { name: 'animation', label: 'Animation (wave)', selector: { boolean: {} } },
      ...(animated ? [{ name: 'speed', label: 'Wave: seconds per turn', selector: { number: { min: 1, max: 60, step: 0.5, mode: 'box', unit_of_measurement: 's' } } }] : []),
    ];

    levels.forEach((l, i) => {
      const animated = l.animation !== false;
      this._setupForm(`form-level-${i}`, levelSchema(animated),
        { below: l.below, fill: l.fill ?? DEFAULT_FILL, animation: animated, speed: l.speed ?? DEFAULT_SPEED },
        v => {
          const on = v.animation !== false;
          // Only store false; on is the default.
          this._setLevel(i, { below: v.below, fill: v.fill, speed: v.speed, animation: on ? null : false });
          const form = this._el(`form-level-${i}`);
          if (form && form.schema.some(s => s.name === 'speed') !== on) form.schema = levelSchema(on);
        });

      this._setupForm(`form-lvl-${i}-color`, [
        { name: 'color', label: 'Color', selector: { text: {} } },
      ], { color: l.color || '' }, v => {
        this._setLevel(i, { color: v.color });
        this._syncSwatch(i, v.color);
      });
    });

    this._setupForm('form-popup', [
      {
        type: 'grid', name: '', schema: [
          { name: 'popup_title', label: 'Title', selector: { text: {} } },
          { name: 'hours_to_show', label: 'History (hours)', selector: { number: { min: 1, max: 87600, mode: 'box' } } },
        ],
      },
      { name: 'statistic_id', label: 'Long-term statistic (optional)', selector: { statistic: {} } },
    ], { popup_title: c.popup_title || '', hours_to_show: c.hours_to_show ?? 4380, statistic_id: c.statistic_id || '' },
    v => this._patch({ popup_title: v.popup_title, hours_to_show: v.hours_to_show, statistic_id: v.statistic_id }));
  }

  _wireNative(levels) {
    const tpl = this._el('subtitle_template');
    tpl.value = this._config.subtitle_template || '';
    tpl.addEventListener('change', e => this._patch({ subtitle_template: e.target.value.trim() }));

    const details = this._el('levels');
    details.addEventListener('toggle', () => { this._levelsOpen = details.open; });

    levels.forEach((l, i) => {
      this._syncSwatch(i, l.color);
      this._el(`lvl-${i}-picker`).addEventListener('input', e => {
        const hex = e.target.value;
        const form = this._el(`form-lvl-${i}-color`);
        if (form) form.data = { color: hex };
        this._syncSwatch(i, hex);
        this._setLevel(i, { color: hex });
      });
    });

    this.shadowRoot.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', () => {
      const levels = this._levels();
      if (levels.length <= 1) return;
      levels.splice(Number(btn.dataset.remove), 1);
      this._patch({ levels });
      this._render();
    }));

    this._el('add-level').addEventListener('click', () => {
      const levels = this._levels();
      if (levels.length >= MAX_LEVELS) return;
      const last = levels[levels.length - 1] || {};
      levels.push({ fill: last.fill ?? DEFAULT_FILL, color: last.color || DEFAULT_LEVELS[1].color, speed: last.speed ?? DEFAULT_SPEED });
      this._levelsOpen = true;
      this._patch({ levels });
      this._render();
    });
  }

  _syncSwatch(i, color) {
    const hex = colorToHex(color);
    const swatch = this._el(`lvl-${i}-swatch`);
    const picker = this._el(`lvl-${i}-picker`);
    if (picker && hex) picker.value = hex;
    if (!swatch) return;
    // Non-hex colors (names, hsl(), var()) are shown directly, as far as the browser knows them.
    const css = hex || cssColor(color);
    swatch.style.background = css || '';
    swatch.classList.toggle('no-color', !css);
  }

  _css() {
    return `
      :host { display: block; }
      ha-form { --ha-form-grid-padding: 0; display: block; margin-bottom: 10px; }
      .section {
        margin: 18px 0 8px; font-size: 13px; font-weight: 600; letter-spacing: .4px;
        text-transform: uppercase; color: var(--secondary-text-color);
      }
      .field { margin-bottom: 10px; }
      label { display: block; font-size: 13px; color: var(--secondary-text-color); margin-bottom: 4px; }
      .hint { font-size: 12px; color: var(--secondary-text-color); margin: 2px 0 10px; }
      textarea {
        width: 100%; min-height: 72px; padding: 8px 12px; box-sizing: border-box; resize: vertical;
        border: 1px solid var(--divider-color, rgba(0, 0, 0, .12)); border-radius: 4px;
        background: var(--card-background-color, #1c1c1c); color: var(--primary-text-color);
        font-size: 13px; font-family: var(--code-font-family, monospace);
      }
      .hidden { display: none !important; }
      details {
        margin: 18px 0 10px; border: 1px solid var(--divider-color, rgba(0, 0, 0, .12)); border-radius: 12px;
      }
      summary {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 12px 16px; cursor: pointer; font-weight: 500; list-style: none;
      }
      summary::-webkit-details-marker { display: none; }
      summary::after { content: '▾'; color: var(--secondary-text-color); transition: transform .2s; }
      details[open] summary::after { transform: rotate(180deg); }
      summary .count { margin-left: auto; font-weight: 400; font-size: 13px; color: var(--secondary-text-color); }
      .levels-body { padding: 0 16px 16px; }
      .level {
        padding: 10px 12px 2px; margin-bottom: 10px; border-radius: 8px;
        background: var(--secondary-background-color, rgba(127, 127, 127, .08));
      }
      .level-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-weight: 500; }
      .icon-btn {
        border: none; background: none; color: var(--secondary-text-color); cursor: pointer;
        width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      }
      .icon-btn:hover:not([disabled]) { background: rgba(127, 127, 127, .15); color: var(--error-color, #db4437); }
      .icon-btn[disabled] { opacity: .35; cursor: default; }
      .color-field { display: flex; gap: 8px; align-items: center; }
      .color-field ha-form { flex: 1; margin-bottom: 0; }
      .color-swatch {
        width: 36px; height: 36px; flex-shrink: 0; border-radius: 4px; cursor: pointer;
        border: 1px solid var(--divider-color, rgba(0, 0, 0, .12)); position: relative; overflow: hidden;
      }
      .color-swatch.no-color {
        background: repeating-linear-gradient(-45deg, rgba(120, 120, 120, .5) 0px, rgba(120, 120, 120, .5) 4px, transparent 4px, transparent 8px);
      }
      .color-hidden-input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; padding: 0; border: none; }
      .addbtn {
        width: 100%; padding: 10px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500;
        background: none; color: var(--primary-color, #03a9f4); border: 1px solid var(--primary-color, #03a9f4);
      }
      .addbtn[disabled] { opacity: .4; cursor: default; }
    `;
  }
}

customElements.define('ha-groundwater-level-card', HaGroundwaterLevelCard);
customElements.define('ha-groundwater-level-card-editor', HaGroundwaterLevelCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'ha-groundwater-level-card',
  name: 'Groundwater Level Card',
  description: 'Groundwater level tile with liquid-fill animation and history popup. No dependencies.',
  preview: true,
});

console.info(`%c GROUNDWATER-LEVEL-CARD %c v${CARD_VERSION} `,
  'color:white;background:#1d8296;font-weight:700', 'color:#1d8296;background:white');
