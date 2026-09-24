/* App shell: routing, rail, search palette, transport, keyboard, drag-and-drop, offline. */
(function () {
  'use strict';

  const { LIB, byId, famById, esc, canonical, compare, syncPlaying, drawWave, toast, cssVar } = window.UI;
  const P = window.Player;
  const $ = s => document.querySelector(s);

  /* ---------------------------------------------------------- rail */

  $('[data-families]').innerHTML = LIB.families.map(f => {
    const n = LIB.instruments.filter(i => i.family === f.id && i.samples.length).length;
    return `<li><a href="#/?f=${f.id}" data-fam="${f.id}"><span class="dot"></span>${esc(f.name)}<span class="n">${n}</span></a></li>`;
  }).join('');

  function updateCompareCount() {
    const el = $('[data-compare-count]');
    el.textContent = compare.ids.length;
    el.hidden = !compare.ids.length;
  }
  document.addEventListener('compare-change', updateCompareCount);
  updateCompareCount();

  /* ---------------------------------------------------------- router */

  let view = null;

  function route() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, query] = raw.split('?');
    const params = new URLSearchParams(query || '');
    const parts = path.split('/').filter(Boolean);
    if (view && view.destroy) view.destroy();
    const old = document.getElementById('main');
    const fresh = old.cloneNode(false); // a fresh element drops the previous view's listeners
    old.replaceWith(fresh);

    let nav = 'library';
    let title = 'Instrumedia';
    if (parts[0] === 'i' && parts[1]) {
      view = window.Views.instrument(fresh, params, parts[1]);
      const inst = byId.get(parts[1]);
      title = inst ? `${inst.name} · Instrumedia` : title;
      nav = null;
    } else if (parts[0] === 'identify') {
      view = window.Views.identify(fresh, params); nav = 'identify'; title = 'Not sure? · Instrumedia';
    } else if (parts[0] === 'compare') {
      view = window.Views.compare(fresh, params); nav = 'compare'; title = 'Compare · Instrumedia';
    } else if (parts[0] === 'quiz') {
      view = window.Views.quiz(fresh, params); nav = 'quiz'; title = 'Quiz · Instrumedia';
    } else if (parts[0] === 'about') {
      view = window.Views.about(fresh, params); nav = null; title = 'About · Instrumedia';
    } else {
      view = window.Views.library(fresh, params);
    }
    view = view || {};
    document.title = title;
    document.querySelectorAll('[data-nav]').forEach(a => {
      if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (!params.get('f') && !params.get('s')) window.scrollTo(0, 0);
    syncPlaying();
    if (typeof kick === 'function') kick();
  }
  window.addEventListener('hashchange', route);

  /* ---------------------------------------------------------- global clicks */

  document.addEventListener('click', e => {
    const play = e.target.closest('[data-play]');
    if (play) {
      e.preventDefault();
      const ref = play.dataset.play;
      if (ref === 'clip') { P.playClip(); return; }
      const r = window.UI.resolve(ref);
      if (r && r.sample) P.playSample(r.inst, r.sample, play.hasAttribute('data-mask') ? { title: 'Mystery sound', sub: 'Quiz' } : {});
      return;
    }
    const act = e.target.closest('[data-action]');
    if (!act) return;
    const a = act.dataset.action;
    if (a === 'search') openPalette();
    else if (a === 'close-palette') closePalette();
    else if (a === 'toggle') P.toggle();
    else if (a === 'loop') setLoop(!P.state.loop);
    else if (a === 'theme') toggleTheme();
    else if (a === 'load-clip') $('[data-clip-input]').click();
    else if (a === 'offline') saveOffline(act);
  });

  // Row click (anywhere on a library row) opens the instrument.
  document.addEventListener('click', e => {
    const row = e.target.closest('.row');
    if (row && !e.target.closest('button, a')) {
      const link = row.querySelector('.row-name a');
      if (link) location.hash = link.getAttribute('href');
    }
  });

  /* ---------------------------------------------------------- transport */

  const transport = $('[data-transport]');
  const tWave = $('[data-t-wave]');
  const tTitle = $('[data-t-title]'), tSub = $('[data-t-sub]'), tTime = $('[data-t-time]');
  const loopBtn = $('[data-action="loop"]');
  const vol = $('[data-volume]');
  vol.value = P.state.volume;
  vol.addEventListener('input', () => P.setVolume(parseFloat(vol.value)));

  function setLoop(v) {
    P.setLoop(v);
    loopBtn.setAttribute('aria-pressed', String(v));
    toast(v ? 'Loop on' : 'Loop off');
  }

  let lastPeaks = null;
  P.on('change', cur => {
    if (cur) {
      transport.setAttribute('data-playing', '');
      tTitle.textContent = cur.title;
      tSub.textContent = cur.sub;
      lastPeaks = cur.peaks;
    } else {
      transport.removeAttribute('data-playing');
    }
    syncPlaying();
  });
  P.on('toggle-idle', () => {
    // Space with nothing playing replays the last thing, if any.
    const last = lastRef;
    if (last === 'clip') P.playClip();
    else if (last) { const r = window.UI.resolve(last); if (r) P.playSample(r.inst, r.sample); }
  });
  let lastRef = null;
  P.on('change', cur => { if (cur) lastRef = cur.id; });
  P.on('need-clip', () => { toast('No recording loaded. Drop an audio or video file anywhere to add one'); });
  P.on('error', () => toast('That clip could not be played'));

  tWave.addEventListener('click', e => {
    const r = tWave.getBoundingClientRect();
    P.seekFraction((e.clientX - r.left) / r.width);
  });

  // Animate only while something plays; one extra frame settles the stopped state.
  let raf = 0;
  function frame() {
    raf = 0;
    const cur = P.state.current;
    if (lastPeaks) {
      const f = cur ? P.position() / (cur.kind === 'clip' ? cur.dur : (P.element.duration || cur.dur)) : 0;
      drawWave(tWave, lastPeaks, { progress: cur ? f : -1, bar: 2, gap: 1.5, alpha: cur ? 1 : 0.6 });
      tTime.textContent = cur ? P.fmt(P.position()).replace(/\.\d$/, '') + ' / ' + P.fmt(cur.dur).replace(/\.\d$/, '') : '';
    }
    if (view && view.tick) view.tick();
    if (cur) raf = requestAnimationFrame(frame);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }
  P.on('change', kick);

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (view && view.resize) view.resize(); kick(); }, 120);
  });

  /* ---------------------------------------------------------- your clip */

  const clipInput = $('[data-clip-input]');
  clipInput.addEventListener('change', () => { if (clipInput.files[0]) loadClip(clipInput.files[0]); clipInput.value = ''; });

  async function loadClip(file) {
    const slot = $('[data-clip-slot]');
    $('[data-clip-hint]').textContent = 'Decoding…';
    try {
      const clip = await P.loadClip(file);
      slot.setAttribute('data-loaded', '');
      $('[data-clip-name]').textContent = clip.name;
      $('[data-clip-hint]').textContent = `${P.fmt(clip.dur)} · press 0 to play`;
      toast('Recording loaded. Press 0 to play it from anywhere');
    } catch (err) {
      $('[data-clip-hint]').textContent = 'Optional · drop audio or video';
      toast(err.message || 'Could not read that file');
    }
  }
  P.on('selection', clip => {
    $('[data-clip-hint]').textContent = `${P.fmt(clip.sel[0])}–${P.fmt(clip.sel[1])}${clip.pitch ? ' · ≈ ' + window.DSP.noteName(clip.pitch.midi) : ''} · press 0`;
  });

  const veil = $('[data-drop-veil]');
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; veil.hidden = false; });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) veil.hidden = true; });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; veil.hidden = true;
    const f = e.dataTransfer.files[0];
    if (f) loadClip(f);
  });

  /* ---------------------------------------------------------- search palette */

  const palette = $('[data-palette]');
  const pInput = $('[data-palette-input]');
  const pList = $('[data-palette-results]');
  let results = [], sel = 0, lastFocus = null;

  const index = LIB.instruments.map(i => ({
    inst: i,
    hay: [i.name, i.sub, ...(i.aliases || []), famById.get(i.family).name, ...i.traits.tone].join(' ').toLowerCase(),
  }));

  function search(q) {
    q = q.trim().toLowerCase();
    if (!q) return LIB.instruments.filter(i => i.samples.length).slice(0, 12);
    const terms = q.split(/\s+/);
    return index
      .map(({ inst, hay }) => {
        if (!terms.every(t => hay.includes(t))) return null;
        const name = inst.name.toLowerCase();
        let s = name.startsWith(q) ? 3 : name.includes(q) ? 2 : 1;
        if (inst.samples.length) s += 0.5;
        return { inst, s };
      })
      .filter(Boolean).sort((a, b) => b.s - a.s).slice(0, 12).map(r => r.inst);
  }

  function drawResults() {
    results = search(pInput.value);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    pList.innerHTML = results.length ? results.map((i, k) => `
      <li role="option" id="pr-${k}" data-idx="${k}" data-fam="${i.family}" aria-selected="${k === sel}">
        <span class="dot"></span>
        <span><strong>${esc(i.name)}</strong><small>${esc(famById.get(i.family).name)}${i.aliases.length ? ' · ' + esc(i.aliases.slice(0, 2).join(', ')) : ''}</small></span>
        ${i.samples.length ? '' : '<span class="tag tag-wanted">No recording yet</span>'}
      </li>`).join('') : `<li class="empty">No match. Try a texture like “buzzy” or “bell”.</li>`;
    pInput.setAttribute('aria-activedescendant', results.length ? 'pr-' + sel : '');
  }

  function openPalette() {
    lastFocus = document.activeElement;
    palette.hidden = false;
    pInput.value = '';
    sel = 0;
    drawResults();
    pInput.focus();
  }
  function closePalette() {
    palette.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function choose(k, addOnly) {
    const inst = results[k];
    if (!inst) return;
    if (addOnly) { compare.add(inst.id); toast(`${inst.name} added to Compare`); return; }
    closePalette();
    location.hash = '#/i/' + inst.id;
  }

  pInput.addEventListener('input', () => { sel = 0; drawResults(); });
  pInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); drawResults(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); drawResults(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel, e.shiftKey); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    else if (e.key === ' ' && !pInput.value.trim()) {
      e.preventDefault();
      const inst = results[sel];
      if (inst && inst.samples.length) P.playSample(inst, canonical(inst));
    }
  });
  pList.addEventListener('mousemove', e => {
    const li = e.target.closest('[data-idx]');
    if (li && +li.dataset.idx !== sel) { sel = +li.dataset.idx; drawResults(); }
  });
  pList.addEventListener('click', e => {
    const li = e.target.closest('[data-idx]');
    if (li) choose(+li.dataset.idx, e.shiftKey);
  });
  palette.addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); pInput.focus(); } // keep focus in the dialog
  });

  /* ---------------------------------------------------------- keyboard */

  document.addEventListener('keydown', e => {
    if (!palette.hidden) return;
    const t = e.target.closest ? e.target : document.body;
    const typing = t.closest('input, textarea, select, [contenteditable]');
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); openPalette(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (t.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === ' ') { e.preventDefault(); P.toggle(); return; }
    if (e.key === '0') { e.preventDefault(); P.playClip(); return; }
    if (e.key === 'l' || e.key === 'L') { setLoop(!P.state.loop); return; }
    if (view && view.key && view.key(e)) e.preventDefault();
  });

  /* ---------------------------------------------------------- theme */

  function toggleTheme() {
    const root = document.documentElement;
    const now = root.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = now === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('im.theme', next); } catch (e) { /* ignore */ }
    if (view && view.resize) view.resize();
  }

  /* ---------------------------------------------------------- offline */

  const offlineBtn = $('[data-offline-btn]');
  const canCache = 'serviceWorker' in navigator && 'caches' in window && location.protocol.startsWith('http');
  if (!canCache) {
    offlineBtn.hidden = true;
  } else {
    navigator.serviceWorker.register('sw.js').catch(() => { offlineBtn.hidden = true; });
    caches.has('im-audio-' + LIB.version).then(has => { if (has) markOffline(); });
  }
  function markOffline() {
    offlineBtn.setAttribute('data-state', 'done');
    offlineBtn.setAttribute('aria-label', 'Library saved for offline use');
    offlineBtn.innerHTML = '<svg aria-hidden="true"><use href="#i-check"/></svg>';
  }

  async function saveOffline(btn) {
    if (btn.getAttribute('data-state') === 'done') { toast('Already saved for offline use'); return; }
    const urls = [];
    LIB.instruments.forEach(i => i.samples.forEach(s => urls.push(s.src, s.spec)));
    const cache = await caches.open('im-audio-' + LIB.version);
    let done = 0;
    const queue = urls.slice();
    const workers = Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const u = queue.shift();
        try { if (!(await cache.match(u))) await cache.add(u); } catch (e) { /* retry on next save */ }
        done++;
        if (done % 20 === 0) toast(`Saving for offline… ${Math.round(done / urls.length * 100)}%`);
      }
    });
    await Promise.all(workers);
    // old versions are dead weight
    (await caches.keys()).filter(k => k.startsWith('im-audio-') && k !== 'im-audio-' + LIB.version).forEach(k => caches.delete(k));
    markOffline();
    toast('Saved. The whole library now works offline');
  }

  route();
})();
