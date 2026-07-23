/* ──────────────────────────────────────────────────────────────────────────
   Mise — staff announcement modal
   Add to any staff page with one line, just before </body>:
       <script src="/announce.js"></script>

   Shows the current announcement once per person per day (Singapore date).
   Fails silently: if the API is down or there is nothing to show, the page
   behaves exactly as it did before.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // Singapore date, so "once a day" rolls over at midnight SGT — not UTC.
  function sgToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  }

  function alreadySeenToday(id) {
    try {
      return localStorage.getItem('mise_ann_' + id) === sgToday();
    } catch (e) { return false; }   // private browsing / storage disabled
  }

  function markSeen(id) {
    try { localStorage.setItem('mise_ann_' + id, sgToday()); } catch (e) {}
  }

  function ensureFonts() {
    if (document.querySelector('link[href*="DM+Serif+Display"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;700&display=swap';
    document.head.appendChild(l);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render(a) {
    ensureFonts();

    var style = document.createElement('style');
    style.textContent = [
      '.mise-ann-back{position:fixed;inset:0;background:rgba(27,42,65,.55);backdrop-filter:blur(3px);',
      'display:flex;align-items:center;justify-content:center;padding:20px;z-index:99999;',
      'opacity:0;transition:opacity .22s ease}',
      '.mise-ann-back.in{opacity:1}',
      '.mise-ann{background:#FAF7F0;border-radius:16px;max-width:400px;width:100%;overflow:hidden;',
      'box-shadow:0 24px 60px rgba(0,0,0,.34);font-family:"DM Sans",system-ui,sans-serif;',
      'transform:translateY(12px) scale(.98);transition:transform .22s ease}',
      '.mise-ann-back.in .mise-ann{transform:none}',
      '.mise-ann img{width:100%;display:block;max-height:210px;object-fit:cover;background:#EDE8DC}',
      '.mise-ann-in{padding:24px}',
      '.mise-ann h2{font-family:"DM Serif Display",Georgia,serif;font-size:1.45rem;line-height:1.22;',
      'color:#1B2A41;margin:0 0 10px}',
      '.mise-ann p{font-size:.94rem;line-height:1.55;color:#4E5560;margin:0 0 20px;white-space:pre-wrap}',
      '.mise-ann-btns{display:flex;gap:10px;flex-wrap:wrap}',
      '.mise-ann-btn{flex:1 1 auto;border:0;cursor:pointer;border-radius:999px;padding:12px 18px;',
      'font-family:inherit;font-size:.92rem;font-weight:500;text-align:center;text-decoration:none}',
      '.mise-ann-go{background:#C4552D;color:#fff}',
      '.mise-ann-go:hover{background:#A9451F}',
      '.mise-ann-ok{background:#1B2A41;color:#fff}',
      '.mise-ann-ok:hover{background:#101d2e}',
      '@media(prefers-reduced-motion:reduce){.mise-ann-back,.mise-ann{transition:none}}'
    ].join('');
    document.head.appendChild(style);

    var back = document.createElement('div');
    back.className = 'mise-ann-back';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-label', a.title);

    var link = '';
    if (a.link_url) {
      link = '<a class="mise-ann-btn mise-ann-go" href="' + esc(a.link_url) +
             '" target="_blank" rel="noopener">' + esc(a.link_label || 'Find out more') + '</a>';
    }

    back.innerHTML =
      '<div class="mise-ann">' +
        (a.image_url ? '<img src="' + esc(a.image_url) + '" alt="">' : '') +
        '<div class="mise-ann-in">' +
          '<h2>' + esc(a.title) + '</h2>' +
          (a.body ? '<p>' + esc(a.body) + '</p>' : '') +
          '<div class="mise-ann-btns">' + link +
            '<button type="button" class="mise-ann-btn mise-ann-ok">Close</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(back);
    requestAnimationFrame(function () { back.classList.add('in'); });

    var btn = back.querySelector('.mise-ann-ok');
    function close() {
      markSeen(a.id);
      back.classList.remove('in');
      setTimeout(function () { back.remove(); }, 220);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    btn.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    btn.focus();
    // Deliberately no backdrop-click-to-close: it must be dismissed.
  }

  function start() {
    fetch('/api/announcements/active', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (a) {
        if (!a || !a.id) return;
        if (alreadySeenToday(a.id)) return;
        render(a);
      })
      .catch(function () { /* silent — never block the page */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
