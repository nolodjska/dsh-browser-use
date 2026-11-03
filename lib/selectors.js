/**
 * Playwright-dialect selector resolution + ARIA-style snapshot for the DSH right-Sidebar browser.
 * The plugin drives that page over the DevTools Protocol only (no Playwright binding), while the
 * upstream client library keeps sending Playwright-style selectors. This module supplies both, as
 * **in-page JavaScript source strings**: hand one to `Runtime.evaluate`, read back JSON. No sockets.
 * @module dsh-browser-use/selectors
 */
/**
 * In-page engine: evaluates to `{resolve, resolveAll, describe, snapshot}`. Single quotes only, no
 * template literals, no imports — valid standalone page JS.
 * @type {string}
 */
const CORE_SRC = String.raw`(function () {
  'use strict';
  var MAX_NAME = 200, MAX_SNAP = 8000, MAX_NODES = 1500;
  var SKIP = { SCRIPT:1, STYLE:1, NOSCRIPT:1, HEAD:1, META:1, LINK:1, TITLE:1, TEMPLATE:1, BASE:1 };
  var NAMEABLE = { link:1, button:1, heading:1, textbox:1, searchbox:1, combobox:1, listbox:1, option:1, checkbox:1, radio:1,
    switch:1, slider:1, spinbutton:1, img:1, cell:1, columnheader:1, rowheader:1, tab:1, menuitem:1, menuitemcheckbox:1,
    menuitemradio:1, listitem:1, term:1, dialog:1, alertdialog:1, status:1, alert:1, figure:1 };
  var TAG_ROLE = { a:'link', area:'link', button:'button', select:'combobox', textarea:'textbox', img:'img', ul:'list',
    ol:'list', li:'listitem', dl:'list', dt:'term', dd:'definition', table:'table', thead:'rowgroup', tbody:'rowgroup',
    tfoot:'rowgroup', tr:'row', td:'cell', th:'columnheader', nav:'navigation', main:'main', header:'banner',
    footer:'contentinfo', aside:'complementary', article:'article', section:'region', form:'form', dialog:'dialog',
    hr:'separator', figure:'figure', figcaption:'caption', option:'option', optgroup:'group', iframe:'iframe',
    h1:'heading', h2:'heading', h3:'heading', h4:'heading', h5:'heading', h6:'heading', p:'paragraph', details:'group',
    progress:'progressbar', output:'status', summary:'button', fieldset:'group', html:'generic', body:'generic',
    div:'generic', span:'generic', time:'generic' };
  var INPUT_ROLE = { checkbox:'checkbox', radio:'radio', range:'slider', number:'spinbutton', button:'button', submit:'button',
    reset:'button', image:'button', file:'button', color:'button', search:'searchbox', email:'textbox', text:'textbox',
    tel:'textbox', url:'textbox', password:'textbox', date:'textbox', time:'textbox', month:'textbox', week:'textbox',
    'datetime-local':'textbox' };
  function norm(s) { return (s === null || s === undefined ? '' : String(s)).replace(/\s+/g, ' ').trim(); }
  function attr(el, n) { try { var v = el.getAttribute && el.getAttribute(n); return v === undefined ? null : v; } catch (e) { return null; } }
  function cssEsc(s) { try { return window.CSS && window.CSS.escape ? window.CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); } catch (e) { return String(s); } }
  function textOf(el) { try { return norm(el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent); } catch (e) { return ''; } }
  function isVisible(el) {
    try {
      if (!el || el.nodeType !== 1 || el.hidden) return false;
      var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
      return cs ? !(cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') : true;
    } catch (e) { return false; }
  }
  function labelElements(el) {
    var out = [];
    try {
      var id = attr(el, 'id'), wrap = el.closest ? el.closest('label') : null;
      if (id) { var lab = document.querySelector('label[for="' + cssEsc(id) + '"]'); if (lab) out.push(lab); }
      if (wrap && out.indexOf(wrap) < 0) out.push(wrap);
    } catch (e) {}
    return out;
  }
  function labelledByText(el) {
    var ids = attr(el, 'aria-labelledby');
    if (!ids) return '';
    return norm(ids.split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? (attr(n, 'aria-label') || n.textContent || '') : ''; }).join(' '));
  }
  function accName(el) {
    try {
      var a = attr(el, 'aria-label'); if (a && norm(a)) return norm(a).slice(0, MAX_NAME);
      var lb = labelledByText(el); if (lb) return lb.slice(0, MAX_NAME);
      var labs = labelElements(el);
      for (var i = 0; i < labs.length; i++) { var t = norm(labs[i].textContent); if (t) return t.slice(0, MAX_NAME); }
      var alt = attr(el, 'alt'); if (alt && norm(alt)) return norm(alt).slice(0, MAX_NAME);
      var ph = attr(el, 'placeholder'); if (ph && norm(ph)) return norm(ph).slice(0, MAX_NAME);
      var ti = attr(el, 'title'); if (ti && norm(ti)) return norm(ti).slice(0, MAX_NAME);
      if (el.tagName && el.tagName.toLowerCase() === 'input') { var val = attr(el, 'value'); if (val && norm(val)) return norm(val).slice(0, MAX_NAME); }
      return textOf(el).slice(0, MAX_NAME);
    } catch (e) { return ''; }
  }
  function labelOf(el) {
    try {
      var labs = labelElements(el);
      for (var i = 0; i < labs.length; i++) { var t = norm(labs[i].textContent); if (t) return t; }
      if (el.tagName && el.tagName.toLowerCase() === 'label') return textOf(el);
      return norm(attr(el, 'aria-label') || labelledByText(el) || attr(el, 'placeholder') || '');
    } catch (e) { return ''; }
  }
  function roleOf(el) {
    try {
      var explicit = attr(el, 'role');
      if (explicit) { var r = norm(explicit).split(' ')[0].toLowerCase(); return r === 'none' || r === 'presentation' ? '' : r; }
      var tag = el.tagName.toLowerCase();
      if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : '';
      if (tag === 'input') return INPUT_ROLE[(attr(el, 'type') || 'text').toLowerCase()] || 'textbox';
      if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
      if (tag === 'img') { var alt = attr(el, 'alt'); return alt === null || norm(alt) !== '' ? 'img' : ''; }
      return TAG_ROLE[tag] || 'generic';
    } catch (e) { return ''; }
  }
  function splitChain(sel) {
    var parts = [], buf = '', q = null, depth = 0, s = String(sel === null || sel === undefined ? '' : sel);
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) { buf += c; if (c === '\\') { buf += s[++i] || ''; } else if (c === q) { q = null; } continue; }
      if (c === '"' || c === "'" || c === '/') { q = c; buf += c; continue; }
      if (c === '[' || c === '(') { depth++; } else if (c === ']' || c === ')') { depth--; }
      else if (c === '>' && s[i + 1] === '>' && depth <= 0) { parts.push(buf); buf = ''; i++; continue; }
      buf += c;
    }
    parts.push(buf);
    return parts.map(norm).filter(Boolean);
  }
  function splitFirstEq(s) {
    var q = null;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) { if (c === '\\') { i++; } else if (c === q) { q = null; } continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '=') return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
    }
    return null;
  }
  // "x"i / 'x's / /re/i / bare → {value, ci, regex}
  function readValue(s) {
    s = norm(s === null || s === undefined ? '' : String(s));
    var out = { value: '', ci: true, regex: false };
    if (!s) return out;
    var m = /^\/([\s\S]*)\/([a-z]*)$/.exec(s);
    if (m) { out.value = m[1]; out.regex = true; out.ci = m[2].indexOf('i') >= 0; return out; }
    if (s[0] !== '"' && s[0] !== "'") { out.value = s; return out; }
    var v = '', i = 1;
    for (; i < s.length; i++) {
      var c = s[i];
      if (c === '\\') { v += s[i + 1] || ''; i++; continue; }
      if (c === s[0]) { i++; break; }
      v += c;
    }
    out.value = v;
    out.ci = s.slice(i).indexOf('s') < 0;
    return out;
  }
  function parsePart(raw) {
    var p = norm(raw), low = p.toLowerCase(), step;
    if (low.indexOf('nth=') === 0) return { t: 'nth', n: parseInt(p.slice(4), 10) || 0 };
    if (low === 'first') return { t: 'nth', n: 0 };
    if (low === 'last') return { t: 'nth', n: -1 };
    if (low.indexOf('visible=') === 0) return { t: 'visible', v: low.slice(8) !== 'false' };
    if (low.indexOf('aria-ref=') === 0) return { t: 'css', css: '[data-dsh-ref="' + cssEsc(p.slice(9).trim()) + '"]' };
    if (low.indexOf('internal:') < 0) return { t: 'css', css: p };
    var body = p.slice(9), eq = body.indexOf('=');
    var eng = (eq < 0 ? body : body.slice(0, eq)).trim().toLowerCase();
    var arg = eq < 0 ? '' : body.slice(eq + 1);
    if (eng === 'text' || eng === 'label') return { t: eng, v: readValue(arg) };
    if (eng === 'has-text' || eng === 'has-not-text') return { t: 'hasText', v: readValue(arg), neg: eng === 'has-not-text' };
    if (eng === 'css') return { t: 'css', css: arg };
    if (eng === 'nth') return { t: 'nth', n: parseInt(arg, 10) || 0 };
    if (eng === 'visible') return { t: 'visible', v: norm(arg) !== 'false' };
    if (eng === 'attr' || eng === 'testid') {
      var kv2 = splitFirstEq(norm(arg).replace(/^\[/, '').replace(/\]$/, ''));
      if (!kv2) return { t: 'attr', attr: 'data-testid', v: readValue('') };
      return { t: 'attr', attr: eng === 'testid' ? 'data-testid' : kv2[0], v: readValue(kv2[1]) };
    }
    if (eng !== 'role') return { t: 'css', css: p };
    var a = norm(arg), br = a.indexOf('[');
    step = { t: 'role', role: (br < 0 ? a : a.slice(0, br)).trim().toLowerCase(), name: null };
    if (br >= 0) { var kv = splitFirstEq(a.slice(br + 1, a.lastIndexOf(']'))); if (kv && kv[0].toLowerCase() === 'name') step.name = readValue(kv[1]); }
    if (step.role.charAt(0) === '/') { var rs = readValue(step.role); try { step.roleRe = new RegExp(rs.value, 'i'); } catch (e) { step.roleRe = null; } }
    else if (step.role.indexOf(',') >= 0) step.roles = step.role.split(',').map(norm).filter(Boolean);
    return step;
  }
  function matchText(actual, spec) {
    if (!spec || spec.value === '') return true;
    actual = norm(actual);
    var v = spec.value;
    if (spec.regex) { try { if (new RegExp(v, spec.ci ? 'i' : '').test(actual)) return true; } catch (e) {} }
    return (spec.ci ? actual.toLowerCase() : actual).indexOf(spec.ci ? v.toLowerCase() : v) >= 0;
  }
  function matchName(actual, spec) {
    if (!spec || spec.value === '') return true;
    var a = norm(actual), b = norm(spec.value);
    if (spec.regex) {
      try { if (new RegExp('^(?:' + spec.value + ')$', spec.ci ? 'i' : '').test(a)) return true; } catch (e) {}
      return matchText(a, spec);
    }
    if (spec.ci) { var la = a.toLowerCase(), lb = b.toLowerCase(); return la === lb || la.indexOf(lb) >= 0; }
    return a === b || a.indexOf(b) >= 0;
  }
  function matchRole(el, step) {
    var r = roleOf(el);
    if (!r) return false;
    return step.roleRe ? step.roleRe.test(r) : step.roles ? step.roles.indexOf(r) >= 0 : r === step.role;
  }
  function allIn(scopes, includeSelf) {
    var out = [], seen = new Set(), i, j, nl, sc;
    for (i = 0; i < scopes.length; i++) {
      sc = scopes[i];
      if (!sc || sc.nodeType !== 1) continue;
      if (includeSelf && !seen.has(sc)) { seen.add(sc); out.push(sc); }
      try { nl = sc.querySelectorAll('*'); } catch (e) { continue; }
      for (j = 0; j < nl.length; j++) { if (!seen.has(nl[j])) { seen.add(nl[j]); out.push(nl[j]); } }
    }
    return out;
  }
  // Playwright's text engine prefers the smallest matching element, so keep only deepest matches.
  function deepest(list) {
    var set = new Set(list);
    return list.filter(function (el) {
      var d = allIn([el], false);
      for (var i = 0; i < d.length; i++) { if (set.has(d[i])) return false; }
      return true;
    });
  }
  function applySelector(set, step, first) {
    var i, j, nl, out = [], seen = new Set();
    if (step.t === 'css') {
      var scopes = first ? [document] : set;
      for (i = 0; i < scopes.length; i++) {
        try { nl = scopes[i].querySelectorAll(step.css); } catch (e) { throw new Error('bad css selector: ' + step.css); }
        for (j = 0; j < nl.length; j++) { if (!seen.has(nl[j])) { seen.add(nl[j]); out.push(nl[j]); } }
      }
      return out;
    }
    var pool = allIn(first ? [document.documentElement] : set, true);
    if (step.t === 'role') return pool.filter(function (el) { return matchRole(el, step) && (!step.name || matchName(accName(el), step.name)); });
    if (step.t === 'text') return deepest(pool.filter(function (el) { return matchText(textOf(el), step.v); }));
    if (step.t === 'label') return deepest(pool.filter(function (el) { return matchText(labelOf(el), step.v); }));
    if (step.t === 'attr') return pool.filter(function (el) { var v = attr(el, step.attr); return v !== null && matchName(v, step.v); });
    return [];
  }
  function resolveAll(selector) {
    var chain = splitChain(selector), set = null, started = false;
    function base() { return set || allIn([document.documentElement], true); }
    for (var i = 0; i < chain.length; i++) {
      var step = parsePart(chain[i]);
      if (step.t === 'nth') {
        var b = base(), idx = step.n < 0 ? b.length + step.n : step.n;
        set = idx >= 0 && idx < b.length ? [b[idx]] : [];
      } else if (step.t === 'visible') {
        set = base().filter(function (el) { return isVisible(el) === step.v; });
      } else if (step.t === 'hasText') {
        set = deepest(base().filter(function (el) { return matchText(textOf(el), step.v) !== step.neg; }));
      } else { set = applySelector(set || [], step, !started); }
      started = true;
    }
    return set || [];
  }
  function resolve(selector, index) {
    try {
      var all = resolveAll(selector), count = all.length;
      var i = index === undefined || index === null ? 0 : Math.trunc(Number(index)) || 0;
      if (i < 0) i = count + i;
      if (!count || i < 0 || i >= count) return { ok: true, found: false, count: count };
      var el = all[i];
      return { ok: true, found: true, index: i, count: count, tag: el.tagName.toLowerCase(), role: roleOf(el),
        text: norm(textOf(el) || el.value || '').slice(0, 200), ref: attr(el, 'data-dsh-ref') };
    } catch (e) { return { ok: false, found: false, count: 0, error: String((e && e.message) || e) }; }
  }
  function describe(selector) {
    try {
      var all = resolveAll(selector);
      return { ok: true, count: all.length, texts: all.slice(0, 20).map(function (el) { return norm(textOf(el) || el.value || '').slice(0, 80); }) };
    } catch (e) { return { ok: false, count: 0, texts: [], error: String((e && e.message) || e) }; }
  }
  function snapshot() {
    try {
      var lines = [], refs = {}, n = 0, len = 0, truncated = false;
      function addLine(depth, line) {
        if (truncated) return;
        var piece = new Array(depth + 1).join('  ') + line + '\n';
        if (lines.length && (len + piece.length > MAX_SNAP || n > MAX_NODES)) { truncated = true; return; }
        lines.push(piece); len += piece.length;
      }
      function kidsOf(el) {
        var kids = [], i, k;
        for (i = 0; i < el.children.length; i++) { k = el.children[i]; if (!SKIP[k.tagName.toUpperCase()] && roleOf(k) && isVisible(k)) kids.push(k); }
        return kids;
      }
      function cursorPointer(el) {
        try {
          var tag = el.tagName.toLowerCase(), role = attr(el, 'role');
          if (tag !== 'a' && tag !== 'button' && role !== 'button' && role !== 'link') return false;
          if (el.hasAttribute('onclick') || typeof el.onclick === 'function') return true;
          var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
          return !!cs && cs.cursor === 'pointer';
        } catch (e) { return false; }
      }
      function absUrl(href) { try { return new URL(href, (window.location && window.location.href) || 'about:blank').href; } catch (e) { return href; } }
      function render(el, depth) {
        if (truncated) return;
        try {
          if (!el || el.nodeType !== 1 || SKIP[el.tagName.toUpperCase()] || !isVisible(el)) return;
          var role = roleOf(el);
          if (!role) return;
          var kids = kidsOf(el);
          if (role === 'generic' && !kids.length) return;
          var name = NAMEABLE[role] ? accName(el) : '', full = textOf(el), ref = 'e' + (++n);
          try { el.setAttribute('data-dsh-ref', ref); } catch (e) {}
          refs[ref] = { role: role, name: norm(name).slice(0, 120), tag: el.tagName.toLowerCase() };
          var inline = (kids.length || name) ? '' : (full.length > 60 ? full.slice(0, 60) + '…' : full);
          addLine(depth, '- ' + role + (name ? ' ' + JSON.stringify(norm(name)) : '') + ' [ref=' + ref + ']' +
            (cursorPointer(el) ? ' [cursor=pointer]' : '') + (kids.length ? ':' : inline ? ': ' + inline : ''));
          if (truncated) return;
          if (el.tagName.toLowerCase() === 'a' && attr(el, 'href')) addLine(depth + 1, '- /url: ' + absUrl(attr(el, 'href')));
          for (var i = 0; i < el.children.length; i++) render(el.children[i], depth + 1);
        } catch (e) {}
      }
      var root = document.body || document.documentElement;
      if (root) render(root, 0);
      var text = lines.join('');
      if (truncated) text += '…[truncated]';
      return { ok: true, snapshot: text, count: n, refs: refs };
    } catch (e) { return { ok: false, snapshot: '', count: 0, refs: {}, error: String((e && e.message) || e) }; }
  }
  return { resolve: resolve, resolveAll: resolveAll, describe: describe, snapshot: snapshot };
})()`;
/**
 * Evaluates in the page and installs `window.__dshSel = {resolve, resolveAll, describe, snapshot}`.
 * @type {string} Returns a small JSON ack.
 */
export const INSTALL_SOURCE = '(function(){try{var api=' + CORE_SRC + ';window.__dshSel=api;' +
  'return JSON.stringify({ok:true,installed:true,engines:["aria-ref","internal:role","internal:text","internal:label",' +
  '"internal:attr","internal:testid","internal:has-text","internal:has-not-text","css"]});' +
  '}catch(e){return JSON.stringify({ok:false,error:String((e&&e.message)||e)});}})()';
/** @type {string} Page prefix that installs the engine once (idempotent). */
const ENSURE = 'window.__dshSel||(window.__dshSel=' + CORE_SRC + ');';
/**
 * Resolve ONE element (Playwright-dialect selector). Negative index counts from the end.
 * @param {string} selector e.g. `internal:role=link[name="Learn more"i]`.
 * @param {number} [index=0] Zero-based match index.
 * @returns {string} Page source returning JSON `{"ok":true,"found":true,"index":0,"count":1,"tag":"button","text":"..."}`
 *   or `{"ok":true,"found":false,"count":0}`.
 */
export function buildResolveSource(selector, index = 0) {
  return '(function(){try{var api=' + ENSURE + 'var r=api.resolve(' + JSON.stringify(String(selector)) + ',' +
    JSON.stringify(Number(index) || 0) + ');return JSON.stringify(r);}' +
    'catch(e){return JSON.stringify({ok:false,found:false,count:0,error:String((e&&e.message)||e)});}})()';
}
/**
 * Count matches for a selector and return up to 20 visible texts.
 * @param {string} selector Selector string.
 * @returns {string} Page source returning JSON `{"ok":true,"count":N,"texts":["..."]}`.
 */
export function buildDescribeSource(selector) {
  return '(function(){try{var api=' + ENSURE + 'var r=api.describe(' + JSON.stringify(String(selector)) + ');return JSON.stringify(r);}' +
    'catch(e){return JSON.stringify({ok:false,count:0,texts:[],error:String((e&&e.message)||e)});}})()';
}
/**
 * ARIA-style snapshot source. Tags every emitted element with `data-dsh-ref="eN"`, so a ref resolves
 * later with the plain CSS selector `[data-dsh-ref="eN"]`. Returns
 * `{"ok":true,"snapshot":"<yaml-ish>","count":N,"refs":{...}}`.
 * @type {string}
 */
export const SNAPSHOT_SOURCE = '(function(){try{var api=' + ENSURE + 'var r=api.snapshot();return JSON.stringify(r);}' +
  'catch(e){return JSON.stringify({ok:false,snapshot:"",count:0,refs:{},error:String((e&&e.message)||e)});}})()';
/**
 * CSS selector for a snapshot ref.
 * @param {string} ref Ref such as `e12`.
 * @returns {string} `[data-dsh-ref="e12"]`
 * @throws {TypeError} When `ref` is not `/^e\d+$/`.
 */
export function refToSelector(ref) {
  const s = typeof ref === 'string' ? ref.trim() : '';
  if (!/^e\d+$/.test(s)) throw new TypeError(`invalid snapshot ref: ${JSON.stringify(ref)}`);
  return `[data-dsh-ref="${s}"]`;
}
/**
 * Whether a selector can go straight to plain CSS APIs (false for `internal:` / `aria-ref=`).
 * @param {string} selector Selector string.
 * @returns {boolean} True when the string looks like plain CSS.
 */
export function isPlainCssSelector(selector) {
  const s = typeof selector === 'string' ? selector.trim() : '';
  if (!s || s.startsWith('aria-ref=') || s.includes('internal:')) return false;
  return true;
}
