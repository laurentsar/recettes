/*
 * update-check.js — vérification de mise à jour via flux Atom GitHub.
 * Utilise /releases.atom (pas de rate-limiting, inclut les notes de version)
 * plutôt que l'API JSON. L'URL de l'APK est construite depuis le numéro de
 * version (pattern du workflow CI : recettes-{version}.apk).
 *
 * Config (dans index.html, avant ce script) :
 *   window.UPDATE_REPO = 'laurentsar/<repo>';
 *   window.APP_VERSION = '1.2';
 *
 * Anti-spam : 1 requête / 6 h. Échec réseau silencieux.
 */
(function () {
  'use strict';
  var REPO = window.UPDATE_REPO;
  var CURRENT = window.APP_VERSION;
  if (!REPO || !CURRENT) return;

  var POLL_INTERVAL = 6 * 3600 * 1000;
  var KEY_POLL    = 'updPoll:'  + REPO;
  var KEY_DISMISS = 'updDismiss:' + REPO;
  var KEY_NOTES   = 'updNotes:' + REPO;

  function ls(get, k, v) {
    try { return get ? localStorage.getItem(k) : localStorage.setItem(k, v); }
    catch (e) { return null; }
  }

  function cmp(va, vb) {
    var a = String(va).replace(/^v/, '').split('.');
    var b = String(vb).replace(/^v/, '').split('.');
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var d = (parseInt(a[i], 10) || 0) - (parseInt(b[i], 10) || 0);
      if (d) return d;
    }
    return 0;
  }

  var last = parseInt(ls(true, KEY_POLL), 10) || 0;
  if (Date.now() - last < POLL_INTERVAL) return;

  fetch('https://github.com/' + REPO + '/releases.atom?_=' + Date.now(), {
    headers: { Accept: 'application/atom+xml, text/xml, */*' }
  })
    .then(function (r) { return r.ok ? r.text() : null; })
    .then(function (xml) {
      if (!xml) return;
      var doc = new DOMParser().parseFromString(xml, 'text/xml');
      var entry = doc.querySelector('entry');
      if (!entry) return;

      var titleEl = entry.querySelector('title');
      if (!titleEl) return;
      var tagName = (titleEl.textContent || '').trim();

      var contentEl = entry.querySelector('content');
      var notesHtml = contentEl ? (contentEl.textContent || '').trim() : '';

      var linkEl = entry.querySelector('link[rel="alternate"]') || entry.querySelector('link');
      var pageUrl = linkEl ? (linkEl.getAttribute('href') || '') : ('https://github.com/' + REPO + '/releases/latest');

      ls(false, KEY_POLL, Date.now());
      var latest = tagName.replace(/^v/, '');
      if (cmp(latest, CURRENT) <= 0) return;
      if (ls(true, KEY_DISMISS) === latest) return;

      var apkUrl = 'https://github.com/' + REPO + '/releases/download/v' + latest + '/recettes-' + latest + '.apk';
      ls(false, KEY_NOTES, JSON.stringify({ ver: latest, notes: notesHtml, url: pageUrl }));
      showBanner(latest, apkUrl, pageUrl, notesHtml);
    })
    .catch(function () {});

  function parseNoteItems(html) {
    if (!html) return [];
    var div = document.createElement('div');
    div.innerHTML = html;
    var items = [];
    div.querySelectorAll('li').forEach(function (li) {
      var t = (li.textContent || '').trim();
      if (t) items.push(t);
    });
    if (!items.length) {
      items = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').split(/[;\n]/)
        .map(function (s) { return s.trim(); }).filter(Boolean);
    }
    return items.slice(0, 5);
  }

  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function showBanner(version, apkUrl, pageUrl, notesHtml) {
    if (document.getElementById('update-banner')) return;

    var css = document.createElement('style');
    css.textContent =
      '#update-banner{position:fixed;left:10px;right:10px;bottom:10px;z-index:99999;' +
      'border-radius:16px;background:#1a2332;color:#e5e7eb;' +
      'box-shadow:0 8px 32px rgba(0,0,0,.5);' +
      'font:14px/1.45 system-ui,-apple-system,Roboto,sans-serif;' +
      'max-width:520px;margin:0 auto;overflow:hidden;border:1px solid rgba(255,255,255,.08)}' +
      '#update-banner .ub-head{display:flex;align-items:center;gap:12px;padding:13px 14px 11px}' +
      '#update-banner .ub-icon{font-size:1.5em;flex:none;line-height:1}' +
      '#update-banner .ub-txt{flex:1;min-width:0}' +
      '#update-banner .ub-title{font-weight:700;font-size:1em;color:#fff}' +
      '#update-banner .ub-sub{color:#9ca3af;font-size:.8em;margin-top:2px}' +
      '#update-banner .ub-notes{padding:9px 14px;border-top:1px solid rgba(255,255,255,.07);' +
      'max-height:110px;overflow-y:auto}' +
      '#update-banner .ub-notes ul{margin:0;padding-left:16px}' +
      '#update-banner .ub-notes li{color:#d1d5db;font-size:.82em;line-height:1.5;margin:1px 0}' +
      '#update-banner .ub-actions{display:flex;gap:8px;padding:10px 14px 13px;' +
      'border-top:1px solid rgba(255,255,255,.07)}' +
      '#update-banner .ub-act{flex:1;text-align:center;background:#22c55e;color:#05210e;' +
      'font-weight:800;font-size:.9em;padding:10px 12px;border-radius:10px;' +
      'border:0;cursor:pointer;text-decoration:none;display:inline-block}' +
      '#update-banner .ub-skip{flex:none;background:transparent;color:#6b7280;font-size:.85em;' +
      'border:1px solid rgba(255,255,255,.12);padding:10px 14px;border-radius:10px;cursor:pointer}';
    document.head.appendChild(css);

    var items = parseNoteItems(notesHtml);
    var notesBlock = items.length
      ? '<div class="ub-notes"><ul>' +
        items.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') +
        '</ul></div>'
      : '';

    var canInstall = typeof window.installApkUpdate === 'function' &&
      window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.UpdatePlugin;

    var actHtml = canInstall
      ? '<button class="ub-act" id="ub-install-btn">⬇ Installer v' + esc(version) + '</button>'
      : '<a class="ub-act" href="' + esc(pageUrl) + '" target="_blank" rel="noopener">⬇ v' + esc(version) + ' — Télécharger</a>';

    var b = document.createElement('div');
    b.id = 'update-banner';
    b.innerHTML =
      '<div class="ub-head">' +
        '<span class="ub-icon">📡</span>' +
        '<div class="ub-txt">' +
          '<div class="ub-title">Mise à jour disponible</div>' +
          '<div class="ub-sub">Version ' + esc(version) + ' prête</div>' +
        '</div>' +
      '</div>' +
      notesBlock +
      '<div class="ub-actions">' + actHtml + '<button class="ub-skip">Plus tard</button></div>';

    (document.body || document.documentElement).appendChild(b);

    b.querySelector('.ub-skip').onclick = function () {
      ls(false, KEY_DISMISS, version); b.remove();
    };

    var installBtn = b.querySelector('#ub-install-btn');
    if (installBtn && canInstall) {
      installBtn.onclick = function () {
        installBtn.disabled = true; installBtn.textContent = '⏳ Installation…';
        window.installApkUpdate(apkUrl, installBtn, function () {
          installBtn.disabled = false; installBtn.textContent = '⬇ Installer v' + version;
        });
      };
    }
  }
})();
