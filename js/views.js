/* Page views. Each render function fills <main> and may register a tick
   callback (called every animation frame while that view is showing). */
(function () {
  'use strict';

  const { LIB, byId, famById, esc, sample, canonical, nearestNote, compare, icon, playBtn, famDot, rangeText,
    copyPath, drawWave, cssVar, store, toast, copy, scoreInstruments } = window.UI;
  const P = window.Player;
  const DSP = window.DSP;

  const ready = LIB.instruments.filter(i => i.samples.length);
  const clipCount = ready.reduce((n, i) => n + i.samples.length, 0);
  const toneQ = LIB.questions.find(q => q.id === 'tone');
  const toneLabel = Object.fromEntries(toneQ.options.map(o => [o.value, o.label]));

  function famColor(el) { return getComputedStyle(el).getPropertyValue('--fam').trim() || cssVar('--text-3'); }

  function paintRowWaves(root) {
    root.querySelectorAll('canvas[data-wave]').forEach(c => {
      const r = window.UI.resolve(c.dataset.wave);
      if (r && r.sample) drawWave(c, DSP.decodePeaks(r.sample.peaks), { cold: famColor(c), alpha: 0.75, bar: 2, gap: 1.5 });
    });
  }

  /* ================================================================ library */

  function library(main, params) {
    const tones = new Set(store.get('lib.tones', []));
    let showWanted = store.get('lib.wanted', false);

    function matches(inst) {
      if (!showWanted && !inst.samples.length) return false;
      if (!tones.size) return true;
      return [...tones].every(t => inst.traits.tone.includes(t));
    }

    function draw() {
      const shown = LIB.instruments.filter(matches);
      const wantedCount = LIB.instruments.length - ready.length;
      main.innerHTML = `
        <header class="page-head">
          <h1 class="page-title">The <em>library</em></h1>
          <p class="page-lede">${ready.length} instruments, ${clipCount} reference clips. Every clip is level-matched, so what differs between them is the instrument, not the volume.</p>
        </header>
        <div class="lib-tools" role="toolbar" aria-label="Filter by texture">
          ${toneQ.options.map(o => `<button class="chip" type="button" data-tone="${o.value}" aria-pressed="${tones.has(o.value)}">${esc(o.label)}</button>`).join('')}
          <span class="spacer"></span>
          <label class="toggle"><input type="checkbox" data-wanted ${showWanted ? 'checked' : ''}> Show ${wantedCount} not yet recorded</label>
        </div>
        ${shown.length ? LIB.families.map(f => {
          const list = shown.filter(i => i.family === f.id);
          if (!list.length) return '';
          return `<section class="fam-block" id="fam-${f.id}" data-fam="${f.id}">
            <div class="fam-head"><h2>${esc(f.name)}</h2><p>${esc(f.blurb)}</p></div>
            <ul class="rows">${list.map(row).join('')}</ul>
          </section>`;
        }).join('') : `<p class="empty-note">Nothing has every texture you picked. Clear a filter or two; most instruments have one or two defining textures.</p>`}
      `;
      paintRowWaves(main);
      window.UI.syncPlaying();
    }

    function row(inst) {
      const s = canonical(inst);
      const sub = [inst.sub, ...(inst.aliases || []).slice(0, 3)].filter(Boolean).join(' · ');
      return `<li class="row" data-fam="${inst.family}" ${inst.samples.length ? '' : 'data-wanted'}>
        ${playBtn(inst, s)}
        <div class="row-name"><a href="#/i/${inst.id}">${esc(inst.name)}</a><div class="row-sub">${esc(sub)}</div></div>
        <div class="row-tags">${inst.samples.length ? inst.traits.tone.map(t => `<span class="tag">${esc(toneLabel[t] || t)}</span>`).join('') : '<span class="tag tag-wanted">No recording yet</span>'}</div>
        <div class="row-range">${rangeText(inst) || (inst.traits.pitched[0] === 'no' ? 'unpitched' : '')}</div>
        ${s ? `<canvas class="row-wave" data-wave="${inst.id}/${s.key}" aria-hidden="true"></canvas>` : '<span></span>'}
        ${icon('arrow', 'row-go')}
      </li>`;
    }

    main.addEventListener('click', e => {
      const chip = e.target.closest('[data-tone]');
      if (chip) {
        const t = chip.dataset.tone;
        tones.has(t) ? tones.delete(t) : tones.add(t);
        store.set('lib.tones', [...tones]);
        draw();
      }
    });
    main.addEventListener('change', e => {
      if (e.target.matches('[data-wanted]')) { showWanted = e.target.checked; store.set('lib.wanted', showWanted); draw(); }
    });

    draw();
    if (params.get('f')) {
      const el = document.getElementById('fam-' + params.get('f'));
      if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
    return { resize: () => paintRowWaves(main) };
  }

  /* ================================================================ instrument */

  const AXIS = [8000, 2000, 500, 125];

  function instrument(main, params, id) {
    const inst = byId.get(id);
    if (!inst) { main.innerHTML = `<p class="empty-note">No instrument called “${esc(id)}”. <a href="#/">Back to the library</a></p>`; return; }
    const fam = famById.get(inst.family);
    let current = sample(inst, params.get('s')) || canonical(inst);

    const groups = [
      ['Phrases and context', s => s.group === 'phrase' || s.group === 'context'],
      ['Techniques', s => s.group === 'technique'],
      ['Hits', s => s.group === 'hits'],
    ];
    const notes = inst.samples.filter(s => s.group === 'register');

    main.innerHTML = `
      <header class="inst-head" data-fam="${inst.family}">
        <div>
          <div class="eyebrow"><span class="dot"></span><a href="#/?f=${fam.id}">${esc(fam.name)}</a>${inst.sub ? ` <span aria-hidden="true">›</span> ${esc(inst.sub)}` : ''}</div>
          <h1 class="page-title" style="margin-top:10px">${esc(inst.name)}</h1>
          ${inst.aliases.length ? `<p class="inst-aka">Also called ${inst.aliases.map(esc).join(', ')}</p>` : ''}
          <p class="inst-summary">${esc(inst.summary)}</p>
        </div>
        <div class="inst-actions">
          <button class="btn" type="button" data-cmp-toggle aria-pressed="${compare.has(inst.id)}">${icon(compare.has(inst.id) ? 'check' : 'plus')}<span>${compare.has(inst.id) ? 'In compare' : 'Add to compare'}</span></button>
        </div>
      </header>

      <div class="inst-grid" data-fam="${inst.family}">
        <div>
          ${inst.samples.length ? `
          <div class="stage">
            <div class="stage-view" data-stage aria-label="Spectrogram. Click to play." role="button" tabindex="0">
              <img class="spec-future" alt="" data-spec>
              <img class="spec-past" alt="" data-spec>
              <div class="stage-axis" aria-hidden="true">${AXIS.map(f => `<span style="top:${(1 - Math.log(f / 40) / Math.log(400)) * 100}%">${f >= 1000 ? f / 1000 + 'k' : f} Hz</span>`).join('')}</div>
              <div class="playhead" data-playhead></div>
            </div>
            <div class="stage-bar">
              <span data-stage-play></span>
              <div class="stage-label"><strong data-stage-title></strong><span data-stage-credit></span></div>
              <div class="stage-meta" data-stage-meta></div>
            </div>
          </div>` : `
          <div class="stage"><div class="stage-view" style="display:grid;place-items:center;cursor:default">
            <div style="text-align:center;max-width:44ch;padding:24px;color:oklch(0.8 0.02 80)">
              <p style="font:400 26px/1.2 var(--f-serif);color:oklch(0.95 0.01 85)">No recording yet</p>
              <p style="margin-top:8px;font-size:14px">We only ship openly licensed audio, and haven't found a clean source for this one. The listening cues and the confusion map below still apply.</p>
            </div></div></div>`}

          ${notes.length ? `
          <section class="keys-strip">
            <div class="keys-strip-head"><h2 class="section-title">Across the range</h2><span>${rangeText(inst)} in these clips · click a note</span></div>
            <div class="keybed">
              <div class="keybed-keys" aria-hidden="true">${Array.from({ length: 88 }, (_, k) => `<i class="${(k + 21) % 12 === 0 ? 'c' : ''}"></i>`).join('')}</div>
              <div class="keybed-range" style="left:${(inst.range[0] - 21) / 88 * 100}%;width:${Math.max(1.2, (inst.range[1] - inst.range[0] + 1) / 88 * 100)}%"></div>
              ${notes.map(s => `<button class="keybed-note" type="button" data-pick="${s.key}" style="left:${(s.midi - 20.5) / 88 * 100}%" aria-pressed="${s.key === current.key}">${esc(s.note)}</button>`).join('')}
            </div>
            <div class="keybed-labels" aria-hidden="true" style="position:relative;height:14px">
              ${[21, 36, 48, 60, 72, 84, 96, 108].map(m => `<span style="position:absolute;left:${(m - 20.5) / 88 * 100}%;transform:translateX(-50%)">${DSP.noteName(m)}${m === 60 ? ' (middle C)' : ''}</span>`).join('')}
            </div>
          </section>` : ''}

          <div class="clip-groups">
            ${groups.map(([title, fn]) => {
              const list = inst.samples.filter(fn);
              if (!list.length) return '';
              return `<section class="clip-group"><h3 class="section-title">${title}</h3><div class="clip-list">
                ${list.map(s => `<button class="clip" type="button" data-pick="${s.key}" aria-pressed="${s.key === current.key}">
                  <span class="clip-text"><strong>${esc(s.label)}</strong><span>${s.dur.toFixed(1)} s${s.note && s.group !== 'register' ? ' · ' + s.note : ''}</span></span>
                  <canvas data-mini="${s.key}" aria-hidden="true"></canvas>
                </button>`).join('')}
              </div></section>`;
            }).join('')}
          </div>
        </div>

        <aside class="side">
          ${inst.listen.length ? `<section><h2 class="section-title">Listen for</h2><ol class="cues">${inst.listen.map(l => `<li>${esc(l)}</li>`).join('')}</ol></section>` : ''}
          <section>
            <h2 class="section-title">Profile</h2>
            <dl class="traits">
              <dt>Pitch</dt><dd>${inst.traits.pitched.includes('yes') ? 'Clear notes' : 'No settled pitch'}</dd>
              <dt>Notes</dt><dd>${inst.traits.sustain.map(v => v === 'held' ? 'hold steady' : 'fade away').join(' or ')}</dd>
              <dt>Attack</dt><dd>${inst.traits.attack.join(' or ')}</dd>
              <dt>Texture</dt><dd>${inst.traits.tone.map(t => (toneLabel[t] || t).toLowerCase()).join(', ')}</dd>
              <dt>Register</dt><dd>${inst.traits.register.join(', ')}</dd>
            </dl>
          </section>
          ${inst.note ? `<p class="inst-note">${esc(inst.note)}</p>` : ''}
        </aside>
      </div>

      ${inst.confusions.length ? `
      <section class="confusions" data-fam="${inst.family}">
        <div class="confusions-head"><h2>Often confused with</h2><p>Play buttons pick the closest note to the one selected above.</p></div>
        <div data-conf></div>
      </section>` : ''}
    `;

    function drawConf() {
      const box = main.querySelector('[data-conf]');
      if (!box) return;
      box.innerHTML = inst.confusions.map(c => {
        const o = byId.get(c.id);
        const s = o.samples.length ? (current.group === 'register' ? nearestNote(o, current.midi) : (sample(o, current.key) || canonical(o))) : null;
        return `<div class="conf" data-fam="${o.family}">
          ${playBtn(o, s)}
          <div class="conf-name"><a href="#/i/${o.id}">${esc(o.name)}</a><span>${esc(famById.get(o.family).name)}${o.samples.length ? '' : ' · no recording yet'}</span></div>
          <p class="conf-cue">${esc(c.cue)}</p>
          <div class="conf-actions">${o.samples.length && inst.samples.length ? `<button class="btn btn-sm" type="button" data-versus="${o.id}">${icon('flip')}Compare</button>` : ''}</div>
        </div>`;
      }).join('');
    }

    function select(key, play) {
      current = sample(inst, key) || current;
      main.querySelectorAll('[data-pick]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pick === current.key)));
      if (!inst.samples.length) return;
      main.querySelectorAll('[data-spec]').forEach(img => { img.src = current.spec; });
      main.querySelector('[data-stage-play]').innerHTML = playBtn(inst, current, 'play-lg');
      main.querySelector('[data-stage-title]').textContent = current.label + (current.note && current.group !== 'register' ? ` · ${current.note}` : '');
      const credit = esc(current.credit.join(', ') + ' · ' + current.license);
      main.querySelector('[data-stage-credit]').innerHTML = current.link
        ? `<a href="${esc(current.link)}" target="_blank" rel="noopener" style="color:inherit">${credit}</a>` : credit;
      main.querySelector('[data-stage-meta]').textContent = current.dur.toFixed(1) + ' s';
      history.replaceState(null, '', `#/i/${inst.id}?s=${current.key}`);
      drawConf();
      window.UI.syncPlaying();
      if (play) P.playSample(inst, current);
    }

    function paintMinis() {
      main.querySelectorAll('canvas[data-mini]').forEach(c => {
        const s = sample(inst, c.dataset.mini);
        drawWave(c, DSP.decodePeaks(s.peaks), { cold: famColor(c.closest('[data-fam]')), bar: 1.5, gap: 1 });
      });
    }

    main.addEventListener('click', e => {
      const pick = e.target.closest('[data-pick]');
      if (pick) { select(pick.dataset.pick, true); return; }
      if (e.target.closest('[data-stage]')) { P.playSample(inst, current); return; }
      const vs = e.target.closest('[data-versus]');
      if (vs) { compare.set([inst.id, vs.dataset.versus]); location.hash = '#/compare'; return; }
      const tgl = e.target.closest('[data-cmp-toggle]');
      if (tgl) {
        compare.has(inst.id) ? compare.remove(inst.id) : compare.add(inst.id);
        const on = compare.has(inst.id);
        tgl.setAttribute('aria-pressed', String(on));
        tgl.innerHTML = icon(on ? 'check' : 'plus') + `<span>${on ? 'In compare' : 'Add to compare'}</span>`;
        toast(on ? `${inst.name} added to Compare` : `${inst.name} removed from Compare`);
      }
    });
    main.addEventListener('keydown', e => {
      if (e.target.matches('[data-stage]') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); P.playSample(inst, current); }
    });

    if (inst.samples.length) select(current.key, false); else drawConf();
    paintMinis();

    const past = main.querySelector('.spec-past'), head = main.querySelector('[data-playhead]'), view = main.querySelector('[data-stage]');
    return {
      resize: paintMinis,
      tick() {
        if (!view) return;
        const cur = P.state.current;
        const mine = cur && cur.id === inst.id + '/' + current.key;
        const f = mine ? Math.min(1, P.position() / (P.element.duration || current.dur)) : 0;
        if (mine) view.setAttribute('data-playing', ''); else view.removeAttribute('data-playing');
        past.style.clipPath = `inset(0 ${(1 - (mine ? f : 1)) * 100}% 0 0)`;
        head.style.transform = `translateX(${f * view.clientWidth}px)`;
      },
    };
  }

  /* ================================================================ identify */

  function identify(main) {
    const qs = LIB.questions;
    let answers = store.get('id.answers', {});

    const others = id => Object.fromEntries(Object.entries(answers).filter(([k]) => k !== id));
    const pool = ans => scoreInstruments(ans).filter(r => r.inst.samples.length);

    /** Options that still separate the plausible candidates. */
    function relevantOptions(q) {
      const ranked = pool(others(q.id));
      const best = ranked.length ? ranked[0].score : 0;
      const live = ranked.filter(r => r.score >= best - 0.12).map(r => r.inst);
      return q.options.filter(o => live.some(i => (i.traits[q.id] || []).includes(o.value)));
    }
    // A question with fewer than two live options can't narrow anything, so it's skipped.
    const applies = i => relevantOptions(qs[i]).length >= 2;
    function seek(from, dir) {
      let i = from;
      while (i >= 0 && i < qs.length && !applies(i)) i += dir;
      return Math.max(0, Math.min(qs.length, i));
    }
    let step = seek(Math.min(store.get('id.step', 0), qs.length), 1);

    function save() { store.set('id.answers', answers); store.set('id.step', step); }

    const REGISTER_TARGET = { low: 40, mid: 62, high: 82 };

    /** An example for one option, drawn from instruments that fit the answers so far,
        so a drum question is illustrated with drums, not strings. */
    function example(q, o, used) {
      const ranked = pool({ ...others(q.id), [q.id]: o.value });
      if (!ranked.length) return null;
      const best = ranked[0].score;
      const has = (inst, primary) => {
        const t = inst.traits[q.id] || [];
        return primary ? t[0] === o.value : t.includes(o.value);
      };
      let inst = null, s = null;
      const curated = window.UI.resolve(o.example);
      if (curated && curated.sample && !used.has(curated.inst.id)) {
        const r = ranked.find(x => x.inst === curated.inst);
        if (r && r.score >= best * 0.9) { inst = curated.inst; s = curated.sample; }
      }
      if (!inst) {
        // Prefer instruments that fit every answer so far; fall back to anything with the trait.
        const near = ranked.filter(x => x.score >= best - 0.12 && !used.has(x.inst.id));
        const rest = ranked.filter(x => !used.has(x.inst.id));
        const r = near.find(x => has(x.inst, true)) || near.find(x => has(x.inst, false))
          || rest.find(x => has(x.inst, true)) || rest.find(x => has(x.inst, false));
        if (!r) return null;
        inst = r.inst;
        const pitched = inst.traits.pitched.includes('yes');
        if (q.id === 'register' && pitched) s = nearestNote(inst, REGISTER_TARGET[o.value]);
        else s = (pitched && sample(inst, 'note-3')) || sample(inst, 'hit-1') || canonical(inst);
      }
      used.add(inst.id);
      return { inst, sample: s };
    }

    function draw() {
      const q = qs[step];
      main.innerHTML = `
        <header class="page-head">
          <h1 class="page-title">Not sure? <em>Narrow it down</em></h1>
          <p class="page-lede">Answer by ear. Each option has a sound to compare against, taken from instruments that still fit your earlier answers. Skip anything you can't tell: a wrong answer only lowers a candidate, it never removes it.</p>
        </header>
        <div class="id-grid">
          <div>
            <div class="steps" role="list">${qs.map((x, i) => {
              const na = i !== step && !answers[x.id] && !applies(i);
              return `<button type="button" role="listitem" data-step="${i}" aria-label="Question ${i + 1}: ${esc(x.ask)}${na ? ' (not needed)' : ''}" ${answers[x.id] ? 'data-done' : ''} ${na ? 'data-na disabled' : ''} ${i === step ? 'aria-current="step"' : ''}></button>`;
            }).join('')}</div>
            ${q ? question(q) : finished()}
          </div>
          <aside class="cands" aria-label="Candidates">
            <div class="cands-head"><h2 class="section-title">Most likely</h2><span data-cands-note></span></div>
            <ol class="cand-list" data-cands></ol>
          </aside>
        </div>`;
      drawCands();
      window.UI.syncPlaying();
    }

    function question(q) {
      const opts = relevantOptions(q);
      const used = new Set();
      return `
        <h2 class="q-title">${esc(q.ask)}</h2>
        <p class="q-hint">${esc(q.hint)}</p>
        <div class="q-options" role="radiogroup" aria-label="${esc(q.ask)}">
          ${opts.map((o, i) => {
            const r = example(q, o, used);
            return `<div class="q-opt" role="radio" aria-checked="${answers[q.id] === o.value}" data-fam="${r ? r.inst.family : ''}">
              ${r && r.sample ? playBtn(r.inst, r.sample, '', `Example of “${o.label}”: ${r.inst.name}`) : '<span></span>'}
              <button class="q-pick" type="button" data-answer="${o.value}"><span>${esc(o.label)}</span>${r ? `<span class="q-ex">e.g. ${esc(r.inst.name)}</span>` : ''}</button>
              <kbd class="q-key">${i + 1}</kbd>
            </div>`;
          }).join('')}
        </div>
        <div class="q-nav">
          ${step > 0 ? `<button class="btn btn-ghost" type="button" data-nav-q="back">${icon('back')}Back</button>` : ''}
          <button class="btn" type="button" data-nav-q="skip">Can't tell</button>
          ${Object.keys(answers).length ? `<button class="btn btn-ghost" type="button" data-nav-q="reset">Start over</button>` : ''}
        </div>`;
    }

    function finished() {
      const top = pool(answers).slice(0, 4);
      const picked = qs.filter(q => answers[q.id]);
      return `<div class="q-done">
        <h2 class="q-title">Here's your shortlist.</h2>
        <p class="q-hint">It ranks what fits your answers; your ears make the final call. Put the top few side by side and listen for the differences.</p>
        ${picked.length ? `<div class="answer-chips" aria-label="Your answers">${picked.map(q => {
          const o = q.options.find(x => x.value === answers[q.id]);
          return `<button class="chip" type="button" data-step="${qs.indexOf(q)}" title="Change this answer">${esc(o ? o.label : answers[q.id])}</button>`;
        }).join('')}</div>` : ''}
        <div class="q-nav">
          <button class="btn btn-primary" type="button" data-top="${top.map(r => r.inst.id).join(',')}">${icon('compare')}Compare the top ${top.length}</button>
          <button class="btn btn-ghost" type="button" data-nav-q="back">${icon('back')}Back</button>
          <button class="btn btn-ghost" type="button" data-nav-q="reset">Start over</button>
        </div>
      </div>`;
    }

    function drawCands() {
      const list = main.querySelector('[data-cands]');
      const before = new Map([...list.children].map(li => [li.dataset.id, li.getBoundingClientRect().top]));
      const ranked = pool(answers).slice(0, 14);
      const best = ranked[0] ? ranked[0].score : 1;
      const answered = Object.values(answers).filter(Boolean).length;
      main.querySelector('[data-cands-note]').textContent = answered ? `${answered} answer${answered > 1 ? 's' : ''} so far` : 'Answer to rank';
      list.innerHTML = ranked.map(({ inst, score }) => `
        <li class="cand" data-id="${inst.id}" data-fam="${inst.family}" ${answered && score < best * 0.72 ? 'data-dim' : ''}>
          ${playBtn(inst, canonical(inst), 'play-sm')}
          <div class="cand-name"><a href="#/i/${inst.id}">${esc(inst.name)}</a><div class="cand-bar"><i style="width:${Math.round(score * 100)}%"></i></div></div>
          <span class="pct">${Math.round(score * 100)}</span>
          <button class="icon-btn" type="button" data-add="${inst.id}" aria-label="${compare.has(inst.id) ? 'In compare' : 'Add to compare'}">${icon(compare.has(inst.id) ? 'check' : 'plus')}</button>
        </li>`).join('');
      // FLIP: slide rows from their old position to the new one.
      [...list.children].forEach(li => {
        const old = before.get(li.dataset.id);
        if (old == null) return;
        const dy = old - li.getBoundingClientRect().top;
        if (!dy) return;
        li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      });
      window.UI.syncPlaying();
    }

    function answer(v) {
      const q = qs[step];
      if (v == null) delete answers[q.id]; else answers[q.id] = v;
      // Later answers that no longer fit (e.g. "holds steady" after switching to drums) are dropped.
      qs.forEach(x => { if (answers[x.id] && !relevantOptions(x).some(o => o.value === answers[x.id])) delete answers[x.id]; });
      step = seek(step + 1, 1);
      save(); draw();
    }

    function back() { step = seek(step - 1, -1); save(); draw(); }

    main.addEventListener('click', e => {
      const a = e.target.closest('[data-answer]');
      if (a) { answer(a.dataset.answer); return; }
      const s = e.target.closest('[data-step]');
      if (s) { step = +s.dataset.step; save(); draw(); return; }
      const n = e.target.closest('[data-nav-q]');
      if (n) {
        const k = n.dataset.navQ;
        if (k === 'back') { back(); return; }
        if (k === 'skip') { answer(null); return; }
        if (k === 'reset') { answers = {}; step = seek(0, 1); }
        save(); draw(); return;
      }
      const add = e.target.closest('[data-add]');
      if (add) {
        const id = add.dataset.add;
        compare.has(id) ? compare.remove(id) : compare.add(id);
        drawCands();
        toast(compare.has(id) ? `${byId.get(id).name} added to Compare` : 'Removed from Compare');
        return;
      }
      const top = e.target.closest('[data-top]');
      if (top) { compare.set(top.dataset.top.split(',')); location.hash = '#/compare'; }
    });

    draw();
    return {
      key(e) {
        const q = qs[step];
        if (!q || e.metaKey || e.ctrlKey || e.altKey) return false;
        const n = parseInt(e.key, 10);
        const opts = relevantOptions(q);
        if (n >= 1 && n <= opts.length) { answer(opts[n - 1].value); return true; }
        if (e.key === 'Backspace') { back(); return true; }
        return false;
      },
    };
  }

  /* ================================================================ compare */

  function compareView(main) {
    const verdicts = store.get('cmp.verdicts', {});
    const picks = store.get('cmp.picks', {});
    let confidence = store.get('cmp.conf', 'medium');
    let undetermined = false;
    let active = null;
    let mode = store.get('cmp.mode', 'phrase');
    const MODES = { phrase: ['Phrase', null], low: ['Low note', 43], mid: ['Middle note', 60], high: ['High note', 76] };

    function laneSample(inst) {
      const pinned = picks[inst.id] && sample(inst, picks[inst.id]);
      if (pinned) return pinned;
      const clip = P.state.clip;
      const pitched = inst.traits.pitched.includes('yes');
      if (clip && clip.pitch && pitched) return nearestNote(inst, clip.pitch.midi);
      // Without a recording to follow, every lane plays the same kind of clip so you compare like with like.
      if (mode !== 'phrase' && pitched) return nearestNote(inst, MODES[mode][1]);
      return canonical(inst);
    }

    function draw() {
      const ids = compare.ids;
      main.innerHTML = `
        <header class="page-head">
          <h1 class="page-title">Compare <em>by ear</em></h1>
          <p class="page-lede">Put instruments side by side and flip between them with the number keys. Every lane plays the same kind of clip, so the only thing that changes is the instrument.</p>
        </header>
        ${P.state.clip ? '<div data-clip-panel></div>' : ''}
        ${ids.length && !(P.state.clip && P.state.clip.pitch) ? `<div class="cmp-mode">
          <span class="section-title">Play</span>
          <div class="seg" role="group" aria-label="What every lane plays">
            ${Object.entries(MODES).map(([k, [label]]) => `<button type="button" data-mode="${k}" aria-pressed="${mode === k}">${label}</button>`).join('')}
          </div>
          ${Object.keys(picks).length ? '<button class="btn btn-ghost btn-sm" type="button" data-unpin>Reset lane choices</button>' : ''}
        </div>` : ''}
        <div class="lanes" data-lanes></div>
        <div class="lane-add">
          <input list="cmp-all" placeholder="Add an instrument…" data-add-input aria-label="Add an instrument to compare">
          <datalist id="cmp-all">${ready.filter(i => !ids.includes(i.id)).map(i => `<option value="${esc(i.name)}">`).join('')}</datalist>
          ${ids.length ? '<button class="btn btn-ghost btn-sm" type="button" data-clear>Clear all</button>' : ''}
        </div>
        <div class="cmp-keys"><span><kbd>1</kbd>–<kbd>${Math.max(1, ids.length)}</kbd> play a lane</span>${P.state.clip ? '<span><kbd>0</kbd> your recording</span>' : ''}<span><kbd>space</kbd> stop</span><span><kbd>L</kbd> loop</span></div>
        ${P.state.clip ? '' : `<button class="cmp-clip-compact" type="button" data-action="load-clip">${icon('wave')}<span><strong>Have a recording?</strong> Drop it anywhere on the page, or click here, to compare it against these. It never leaves your device.</span></button>`}
        ${ids.length ? verdictBox() : ''}
      `;
      drawClip();
      drawLanes();
    }

    /* ---- your clip ---- */

    function drawClip() {
      const box = main.querySelector('[data-clip-panel]');
      const clip = P.state.clip;
      if (!clip || !box) return;
      box.innerHTML = `<div class="cmp-clip">
        <div class="cmp-clip-view" data-clip-view aria-label="Your recording. Drag to select the part to compare."><canvas data-clip-canvas></canvas></div>
        <div class="cmp-clip-bar">
          <button class="play" type="button" data-play="clip" aria-label="Play your recording selection">${icon('play', 'i-play')}${icon('stop', 'i-stop')}</button>
          <div class="stage-label"><strong>${esc(clip.name)}</strong><span data-sel-text></span></div>
          <span class="pitch-read" data-pitch></span>
          <button class="btn btn-sm" type="button" data-match aria-pressed="${P.state.matchLevel}" title="Turn your recording up or down to the level of the reference clips">Match level</button>
          <button class="btn btn-sm" type="button" data-action="load-clip">Replace</button>
        </div>
      </div>`;
      paintClip();
      readout();
    }

    function paintClip() {
      const c = main.querySelector('[data-clip-canvas]');
      const clip = P.state.clip;
      if (!c || !clip) return;
      const { w, h, g, dpr } = window.UI.fit(c);
      g.clearRect(0, 0, w, h);
      const [a, b] = clip.sel;
      const x0 = a / clip.dur * w, x1 = b / clip.dur * w;
      g.fillStyle = 'oklch(0.77 0.155 58 / 0.12)';
      g.fillRect(x0, 0, x1 - x0, h);
      const n = Math.floor(w / (3 * dpr));
      for (let i = 0; i < n; i++) {
        const p = clip.peaks[Math.floor(i / n * clip.peaks.length)];
        const amp = Math.max(dpr, Math.pow(p, 0.8) * h * 0.42);
        const x = i * 3 * dpr;
        g.fillStyle = x >= x0 && x <= x1 ? 'oklch(0.8 0.14 60)' : 'oklch(0.55 0.02 70)';
        g.fillRect(x, h / 2 - amp, 2 * dpr, amp * 2);
      }
      g.fillStyle = 'oklch(0.85 0.14 60)';
      g.fillRect(x0 - dpr, 0, 2 * dpr, h);
      g.fillRect(x1 - dpr, 0, 2 * dpr, h);
      const cur = P.state.current;
      if (cur && cur.id === 'clip') {
        const px = x0 + (P.position() / (b - a)) * (x1 - x0);
        g.fillStyle = 'oklch(0.97 0.02 85)';
        g.fillRect(px, 0, 1.5 * dpr, h);
      }
    }

    function readout() {
      const clip = P.state.clip;
      const t = main.querySelector('[data-sel-text]'), p = main.querySelector('[data-pitch]');
      if (!clip || !t) return;
      t.textContent = `Selection ${P.fmt(clip.sel[0])}–${P.fmt(clip.sel[1])} · drag on the waveform to change`;
      p.innerHTML = clip.pitch
        ? `Pitch ≈ <strong>${DSP.noteName(clip.pitch.midi)}</strong> <span>(${Math.round(clip.pitch.hz)} Hz)</span>`
        : 'No steady pitch found';
    }

    function bindDrag() {
      main.addEventListener('pointerdown', e => {
        const view = e.target.closest('[data-clip-view]');
        const clip = P.state.clip;
        if (!view || !clip) return;
        const r = view.getBoundingClientRect();
        const t0 = (e.clientX - r.left) / r.width * clip.dur;
        let moved = false;
        view.setPointerCapture(e.pointerId);
        const move = ev => {
          const t1 = (ev.clientX - r.left) / r.width * clip.dur;
          if (Math.abs(t1 - t0) < 0.05) return;
          moved = true;
          clip.sel = [Math.max(0, Math.min(t0, t1)), Math.min(clip.dur, Math.max(t0, t1))];
          paintClip();
        };
        const up = () => {
          view.removeEventListener('pointermove', move);
          view.removeEventListener('pointerup', up);
          if (moved) {
            P.setSelection(clip.sel[0], clip.sel[1]);
          } else {
            // A click moves the current window to start there.
            const len = clip.sel[1] - clip.sel[0];
            P.setSelection(t0, Math.min(clip.dur, t0 + len));
          }
        };
        view.addEventListener('pointermove', move);
        view.addEventListener('pointerup', up);
      });
    }

    /* ---- lanes ---- */

    function drawLanes() {
      const box = main.querySelector('[data-lanes]');
      const ids = compare.ids;
      const clip = P.state.clip;
      if (!ids.length) {
        box.innerHTML = `<p class="empty-note">No candidates yet. Add instruments from the library, from “Not sure?”, or type a name below. Two to four is the sweet spot.</p>`;
        return;
      }
      box.innerHTML = (clip ? `<div class="lane" data-lane="clip" style="--fam:var(--accent)">
          <button class="lane-key" type="button" data-play="clip" aria-label="Play your recording">0</button>
          <div class="lane-name"><strong>Your recording</strong><div class="row-sub">${P.fmt(clip.sel[0])}–${P.fmt(clip.sel[1])}${clip.pitch ? ' · ≈ ' + DSP.noteName(clip.pitch.midi) : ''}</div></div>
          <div class="lane-view" data-play="clip"><canvas data-clip-spec></canvas><canvas data-lane-wave="clip"></canvas></div>
          <div class="lane-actions"></div>
        </div>` : '') + ids.map((id, i) => {
        const inst = byId.get(id);
        const s = laneSample(inst);
        const v = verdicts[id];
        const cues = ids.filter(o => o !== id).map(o => {
          const c = inst.confusions.find(x => x.id === o);
          return c ? `vs <b>${esc(byId.get(o).name)}</b>: ${esc(c.cue)}` : null;
        }).filter(Boolean).slice(0, 2);
        return `<div class="lane" data-lane="${id}" data-fam="${inst.family}" ${v ? `data-verdict="${v}"` : ''}>
          <button class="lane-key" type="button" data-play="${id}/${s.key}" aria-label="Play ${esc(inst.name)} (key ${i + 1})">${i + 1}</button>
          <div class="lane-name">
            <a href="#/i/${id}">${esc(inst.name)}</a>
            <select data-pick-lane="${id}" aria-label="Clip for ${esc(inst.name)}">
              ${inst.samples.map(x => `<option value="${x.key}" ${x.key === s.key ? 'selected' : ''}>${esc(x.group === 'register' ? 'Note ' + x.note : x.label)}</option>`).join('')}
            </select>
          </div>
          <div class="lane-view" data-play="${id}/${s.key}"><img src="${s.spec}" alt=""><canvas data-lane-wave="${id}"></canvas></div>
          <div class="lane-actions">
            <button class="verdict" type="button" data-kind="yes" data-verdict-btn="${id}" aria-pressed="${v === 'yes'}" aria-label="This is it">${icon('check')}</button>
            <button class="verdict" type="button" data-kind="no" data-verdict-btn="${id}" aria-pressed="${v === 'no'}" aria-label="Not this">${icon('x')}</button>
            <button class="btn btn-ghost btn-sm" type="button" data-remove="${id}">Remove</button>
          </div>
          ${cues.length ? `<p class="lane-cue">${cues.join('<br>')}</p>` : ''}
        </div>`;
      }).join('');
      paintLanes();
      if (clip) paintClipSpec();
      window.UI.syncPlaying();
    }

    function paintClipSpec() {
      const c = main.querySelector('[data-clip-spec]');
      const clip = P.state.clip;
      if (!c || !clip) return;
      const w = 360, h = 128;
      c.width = w; c.height = h;
      const img = DSP.spectrogram(clip.data, clip.sr, Math.floor(clip.sel[0] * clip.sr), Math.floor(clip.sel[1] * clip.sr), w, h);
      c.getContext('2d').putImageData(img, 0, 0);
    }

    function paintLanes() {
      main.querySelectorAll('[data-lane-wave]').forEach(c => {
        const id = c.dataset.laneWave;
        const cur = P.state.current;
        let peaks, playing = false;
        if (id === 'clip') {
          peaks = P.state.clip && P.state.clip.selPeaks;
          playing = cur && cur.id === 'clip';
        } else {
          const inst = byId.get(id);
          const s = laneSample(inst);
          peaks = DSP.decodePeaks(s.peaks);
          playing = cur && cur.id === id + '/' + s.key;
        }
        const f = playing ? P.position() / (cur.kind === 'clip' ? cur.dur : (P.element.duration || cur.dur)) : -1;
        drawWave(c, peaks, { cold: 'oklch(0.95 0.01 85 / 0.55)', hot: 'oklch(0.97 0.03 85)', progress: f, bar: 2, gap: 2 });
        const lane = c.closest('.lane');
        if (playing) lane.setAttribute('data-active', ''); else lane.removeAttribute('data-active');
      });
    }

    /* ---- verdict ---- */

    function verdictBox() {
      const sure = { high: 'Very sure', medium: 'Fairly sure', low: 'Not very sure' };
      return `<section class="verdict-box" aria-labelledby="verdict-h">
        <h2 id="verdict-h">What you're hearing</h2>
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">
          <div class="seg" role="group" aria-label="How sure are you?">
            ${['high', 'medium', 'low'].map(c => `<button type="button" data-conf-btn="${c}" aria-pressed="${confidence === c}">${sure[c]}</button>`).join('')}
          </div>
          <button class="btn btn-sm" type="button" data-undetermined aria-pressed="${undetermined}">Can't tell from this recording</button>
        </div>
        <div class="label-out"><code data-label-out></code><button class="btn btn-sm" type="button" data-copy-out>${icon('copy')}Copy</button></div>
        <p class="credit">Mark candidates with ✓ or ✕. If two instruments from one family still both fit, the answer names the family instead of guessing.</p>
      </section>`;
    }

    function labelText() {
      const ids = compare.ids;
      const name = id => byId.get(id).name;
      const lower = id => name(id).toLowerCase();
      const sure = { high: 'Very sure', medium: 'Fairly sure', low: 'Not very sure' }[confidence];
      const yes = ids.filter(id => verdicts[id] === 'yes');
      const open = ids.filter(id => !verdicts[id]);
      if (undetermined) return `Can't tell from this recording. Considered: ${ids.map(name).join(', ')}.`;
      if (yes.length === 1) {
        const inst = byId.get(yes[0]);
        return `${inst.name} (${copyPath(inst).split(' › ').slice(0, -1).join(' › ')}). ${sure}.${open.length ? ` Could also be: ${open.map(name).join(', ')}.` : ''}`;
      }
      if (!yes.length && !open.length) return 'Every candidate is ruled out. Add more, or try “Not sure?”.';
      if (!yes.length) return `Still open: ${open.map(name).join(', ')}. Mark ✓ on the one that matches.`;
      const fams = [...new Set(yes.map(id => byId.get(id).family))];
      if (fams.length === 1) return `${famById.get(fams[0]).name}: ${yes.map(lower).join(' or ')}. ${sure}.`;
      return `One of: ${yes.map(name).join(', ')}. ${sure}.`;
    }

    function refreshLabel() {
      const out = main.querySelector('[data-label-out]');
      if (out) out.textContent = labelText();
    }

    /* ---- events ---- */

    main.addEventListener('click', e => {
      const md = e.target.closest('[data-mode]');
      if (md) { mode = md.dataset.mode; store.set('cmp.mode', mode); draw(); refreshLabel(); return; }
      if (e.target.closest('[data-unpin]')) { Object.keys(picks).forEach(k => delete picks[k]); store.set('cmp.picks', picks); draw(); refreshLabel(); return; }
      const vb = e.target.closest('[data-verdict-btn]');
      if (vb) {
        const id = vb.dataset.verdictBtn, kind = vb.dataset.kind;
        verdicts[id] = verdicts[id] === kind ? undefined : kind;
        if (!verdicts[id]) delete verdicts[id];
        store.set('cmp.verdicts', verdicts);
        drawLanes(); refreshLabel(); return;
      }
      const rm = e.target.closest('[data-remove]');
      if (rm) { compare.remove(rm.dataset.remove); delete verdicts[rm.dataset.remove]; store.set('cmp.verdicts', verdicts); draw(); return; }
      if (e.target.closest('[data-clear]')) { compare.set([]); Object.keys(verdicts).forEach(k => delete verdicts[k]); store.set('cmp.verdicts', verdicts); draw(); return; }
      const cb = e.target.closest('[data-conf-btn]');
      if (cb) { confidence = cb.dataset.confBtn; store.set('cmp.conf', confidence); main.querySelectorAll('[data-conf-btn]').forEach(b => b.setAttribute('aria-pressed', String(b === cb))); refreshLabel(); return; }
      const un = e.target.closest('[data-undetermined]');
      if (un) { undetermined = !undetermined; un.setAttribute('aria-pressed', String(undetermined)); refreshLabel(); return; }
      if (e.target.closest('[data-copy-out]')) { copy(labelText()); return; }
      const m = e.target.closest('[data-match]');
      if (m) { P.setMatchLevel(!P.state.matchLevel); m.setAttribute('aria-pressed', String(P.state.matchLevel)); }
    });
    main.addEventListener('change', e => {
      const sel = e.target.closest('[data-pick-lane]');
      if (sel) {
        picks[sel.dataset.pickLane] = sel.value;
        store.set('cmp.picks', picks);
        drawLanes();
        const inst = byId.get(sel.dataset.pickLane);
        P.playSample(inst, sample(inst, sel.value));
        return;
      }
      if (e.target.matches('[data-add-input]')) {
        const v = e.target.value.trim().toLowerCase();
        const inst = ready.find(i => i.name.toLowerCase() === v) || ready.find(i => i.name.toLowerCase().startsWith(v));
        if (inst) { compare.add(inst.id); draw(); main.querySelector('[data-add-input]').focus(); }
      }
    });
    bindDrag();

    let alive = true;
    P.on('clip', () => { if (!alive) return; Object.keys(picks).forEach(k => delete picks[k]); store.set('cmp.picks', picks); draw(); refreshLabel(); });
    P.on('selection', () => { if (!alive) return; paintClip(); readout(); drawLanes(); });

    draw();
    refreshLabel();
    return {
      destroy() { alive = false; },
      resize() { if (alive) { paintClip(); paintLanes(); } },
      tick() {
        if (!alive || !main.isConnected) return;
        if (P.state.current) { paintLanes(); if (P.state.current.id === 'clip') paintClip(); }
        else if (active !== null) { paintLanes(); paintClip(); }
        active = P.state.current ? P.state.current.id : null;
      },
      key(e) {
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= compare.ids.length) {
          const inst = byId.get(compare.ids[n - 1]);
          P.playSample(inst, laneSample(inst));
          return true;
        }
        return false;
      },
    };
  }

  /* ================================================================ quiz */

  const MASK = { title: 'Mystery sound', sub: 'Quiz' };

  function quiz(main) {
    const LEVELS = {
      easy: { label: 'Easy', hint: 'Phrases, three choices', choices: 3 },
      normal: { label: 'Normal', hint: 'Single notes too, four choices', choices: 4 },
      hard: { label: 'Hard', hint: 'Busy mixes and small speakers', choices: 4 },
    };
    const settings = Object.assign({ level: 'normal', family: 'all' }, store.get('quiz.settings', {}));
    const stats = Object.assign({ total: 0, correct: 0, streak: 0, best: 0 }, store.get('quiz.stats', {}));
    const misses = store.get('quiz.misses', {});     // target id -> times missed
    const mixups = store.get('quiz.mixups', {});     // "target|picked" -> count
    let round = null;
    let lastTarget = null;

    const pickOne = arr => arr[Math.floor(Math.random() * arr.length)];
    const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

    function clipFor(inst, level) {
      const s = inst.samples;
      const by = g => s.filter(x => x.group === g);
      let pool;
      if (level === 'easy') pool = s.filter(x => x.key === 'phrase' || x.key === 'groove');
      else if (level === 'normal') pool = [...by('register'), ...s.filter(x => x.key === 'phrase' || x.key === 'groove'), ...by('hits')];
      else pool = [...by('context'), ...by('register'), ...by('technique'), ...by('hits')];
      return pickOne(pool.length ? pool : s);
    }

    /** What an option instrument sounds like in the same situation, for the "listen and learn" step. */
    function matching(inst, clip) {
      if (clip.group === 'register' && clip.midi != null) return nearestNote(inst, clip.midi);
      return sample(inst, clip.key) || canonical(inst);
    }

    function newRound() {
      const lvl = LEVELS[settings.level];
      let targets = ready.filter(i => settings.family === 'all' || i.family === settings.family);
      // Only quiz instruments that have at least one recorded look-alike to confuse them with.
      targets = targets.filter(i => i.confusions.some(c => byId.get(c.id).samples.length));
      if (!targets.length) { round = null; return; }
      const weighted = targets.flatMap(i => Array(1 + 3 * Math.min(misses[i.id] || 0, 4)).fill(i));
      let target = pickOne(weighted);
      if (target.id === lastTarget && targets.length > 1) target = pickOne(targets.filter(i => i.id !== lastTarget));
      lastTarget = target.id;
      const look = shuffle(target.confusions.map(c => byId.get(c.id)).filter(i => i.samples.length));
      const kin = shuffle(ready.filter(i => i.family === target.family && i !== target && !look.includes(i)));
      const options = shuffle([target, ...[...look, ...kin].slice(0, lvl.choices - 1)]);
      round = { target, options, clip: clipFor(target, settings.level), picked: null };
    }

    function draw() {
      const pct = stats.total ? Math.round(stats.correct / stats.total * 100) : 0;
      main.innerHTML = `
        <header class="page-head">
          <h1 class="page-title">Train <em>your ear</em></h1>
          <p class="page-lede">Listen, then pick the instrument. The choices are always ones that are easy to mix up, and instruments you miss come back more often.</p>
        </header>
        <div class="quiz-bar">
          <div class="seg" role="group" aria-label="Difficulty">
            ${Object.entries(LEVELS).map(([k, v]) => `<button type="button" data-level="${k}" aria-pressed="${settings.level === k}" title="${v.hint}">${v.label}</button>`).join('')}
          </div>
          <select data-family aria-label="Family">
            <option value="all">All families</option>
            ${LIB.families.map(f => `<option value="${f.id}" ${settings.family === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
          </select>
          <span class="quiz-score num" aria-live="polite">${stats.correct}/${stats.total}${stats.total ? ` · ${pct}%` : ''} · streak ${stats.streak}${stats.best ? ` (best ${stats.best})` : ''}</span>
        </div>
        ${round ? roundView() : `<p class="empty-note">No instruments in this family have a recorded look-alike yet. Pick another family.</p>`}
        ${trickiest()}
      `;
      window.UI.syncPlaying();
    }

    function roundView() {
      const { target, options, clip, picked } = round;
      const done = picked != null;
      const right = picked === target.id;
      const pickedInst = done ? byId.get(picked) : null;
      const cue = done && !right ? (target.confusions.find(c => c.id === picked) || {}).cue : null;
      return `
        <section class="quiz-stage">
          <button class="quiz-play" type="button" data-play="${target.id}/${clip.key}" ${done ? '' : 'data-mask'} aria-label="Play the mystery sound">
            ${icon('play', 'i-play')}${icon('stop', 'i-stop')}
          </button>
          <div class="quiz-prompt">
            <h2 class="q-title">${done ? (right ? 'Yes, that was the ' + esc(target.name.toLowerCase()) + '.' : 'That was the ' + esc(target.name.toLowerCase()) + '.') : 'What is playing?'}</h2>
            <p class="q-hint">${!done ? 'Press <kbd>R</kbd> to replay. Answer with the number keys.'
              : right ? 'Play the others below to hear what set it apart.'
              : cue ? `How to tell them apart: ${esc(cue)}` : `Play both below and listen for the difference.`}</p>
          </div>
        </section>
        <div class="quiz-options">
          ${options.map((o, i) => {
            const state = !done ? '' : o === target ? 'correct' : o.id === picked ? 'wrong' : 'other';
            const s = matching(o, clip);
            return `<div class="quiz-opt" data-fam="${o.family}" ${state ? `data-state="${state}"` : ''}>
              <button class="quiz-pick" type="button" data-pick-opt="${o.id}" ${done ? 'disabled' : ''}>
                <kbd>${i + 1}</kbd><span><strong>${esc(o.name)}</strong><small>${esc(famById.get(o.family).name)}</small></span>
                ${state === 'correct' ? icon('check') : state === 'wrong' ? icon('x') : ''}
              </button>
              ${done ? `<div class="quiz-learn">${playBtn(o, s, 'play-sm', `Hear ${o.name}`)}<a href="#/i/${o.id}">Open</a></div>` : ''}
            </div>`;
          }).join('')}
        </div>
        ${done ? `<div class="q-nav">
          <button class="btn btn-primary" type="button" data-next>Next ${icon('arrow')}</button>
          ${!right ? `<button class="btn btn-ghost" type="button" data-versus="${target.id},${picked}">${icon('flip')}Compare these two</button>` : ''}
          <span class="credit">or press <kbd>N</kbd></span>
        </div>` : ''}`;
    }

    function trickiest() {
      const rows = Object.entries(mixups).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (!rows.length) return '';
      return `<section class="quiz-tricky">
        <div class="confusions-head"><h2>Your trickiest pairs</h2><button class="btn btn-ghost btn-sm" type="button" data-reset-stats>Reset</button></div>
        ${rows.map(([k, n]) => {
          const [a, b] = k.split('|');
          return `<div class="conf" data-fam="${byId.get(a).family}">
            ${playBtn(byId.get(a), canonical(byId.get(a)), 'play-sm')}
            <div class="conf-name"><a href="#/i/${a}">${esc(byId.get(a).name)}</a><span>heard as ${esc(byId.get(b).name)}</span></div>
            <p class="conf-cue num">${n} time${n > 1 ? 's' : ''}</p>
            <div class="conf-actions"><button class="btn btn-sm" type="button" data-versus="${a},${b}">${icon('flip')}Compare</button></div>
          </div>`;
        }).join('')}
      </section>`;
    }

    function answer(id) {
      if (!round || round.picked) return;
      round.picked = id;
      const right = id === round.target.id;
      stats.total++;
      if (right) {
        stats.correct++; stats.streak++; stats.best = Math.max(stats.best, stats.streak);
        if (misses[round.target.id]) misses[round.target.id]--;
      } else {
        stats.streak = 0;
        misses[round.target.id] = (misses[round.target.id] || 0) + 1;
        const k = round.target.id + '|' + id;
        mixups[k] = (mixups[k] || 0) + 1;
      }
      store.set('quiz.stats', stats); store.set('quiz.misses', misses); store.set('quiz.mixups', mixups);
      draw();
    }

    function next(autoplay) {
      newRound();
      draw();
      if (autoplay && round) P.playSample(round.target, round.clip, MASK);
    }

    main.addEventListener('click', e => {
      const o = e.target.closest('[data-pick-opt]');
      if (o) { answer(o.dataset.pickOpt); return; }
      if (e.target.closest('[data-next]')) { next(true); return; }
      const lv = e.target.closest('[data-level]');
      if (lv) { settings.level = lv.dataset.level; store.set('quiz.settings', settings); next(false); return; }
      const vs = e.target.closest('[data-versus]');
      if (vs) { compare.set(vs.dataset.versus.split(',')); location.hash = '#/compare'; return; }
      if (e.target.closest('[data-reset-stats]')) {
        Object.assign(stats, { total: 0, correct: 0, streak: 0, best: 0 });
        [misses, mixups].forEach(m => Object.keys(m).forEach(k => delete m[k]));
        store.set('quiz.stats', stats); store.set('quiz.misses', misses); store.set('quiz.mixups', mixups);
        draw();
      }
    });
    main.addEventListener('change', e => {
      if (e.target.matches('[data-family]')) { settings.family = e.target.value; store.set('quiz.settings', settings); next(false); }
    });

    next(false);
    return {
      key(e) {
        if (!round || e.metaKey || e.ctrlKey || e.altKey) return false;
        const k = e.key.toLowerCase();
        if (k === 'r') { P.stop(); P.playSample(round.target, round.clip, round.picked ? {} : MASK); return true; }
        if (round.picked && (k === 'n' || k === 'enter')) { next(true); return true; }
        const n = parseInt(e.key, 10);
        if (!round.picked && n >= 1 && n <= round.options.length) { answer(round.options[n - 1].id); return true; }
        return false;
      },
    };
  }

  /* ================================================================ about */

  function about(main) {
    const counts = {};
    ready.forEach(i => i.samples.forEach(s => s.credit.forEach(c => { counts[c] = (counts[c] || 0) + 1; })));
    const lic = {};
    ready.forEach(i => i.samples.forEach(s => s.credit.forEach(c => { lic[c] = s.license; })));
    main.innerHTML = `
      <header class="page-head">
        <h1 class="page-title">About <em>Instrumedia</em></h1>
        <p class="page-lede">A free tool for working out which instrument you're hearing. Browse what each one sounds like, narrow down by ear when you're unsure, and put a recording side by side with the candidates.</p>
        <p class="credit" style="font-size:14px">Made by Tarek Gara.</p>
      </header>
      <div class="prose">
        <h2>How to use it</h2>
        <p><strong>Library</strong> is for when you roughly know the family. <strong>Not sure?</strong> ranks every instrument from a few questions you answer by ear. <strong>Quiz</strong> trains your ear on instruments that are easy to mix up. <strong>Compare</strong> puts instruments side by side: press <kbd>1</kbd>–<kbd>6</kbd> to flip between them.</p>
        <p>Every reference clip is loudness-matched (about −20 LUFS), so you hear the instrument rather than the volume. Single notes are spread across each instrument's range, and Compare can play the same register on every lane.</p>
        <p>If you have a recording of your own, drop it anywhere on the page. It's decoded in your browser, never uploaded; <kbd>0</kbd> plays it from any page, and Compare adds it as an extra lane, matched in level and, when it has a clear pitch, in register.</p>
        <p>“Buried in a busy mix” adds a drum groove, speech-shaped noise and room reverb. “Through a small speaker” band-limits the phrase like a phone or TV speaker. Recordings in the wild rarely sound like a studio, and these help you recognise an instrument when it isn't front and centre.</p>
        <h2>Keyboard</h2>
        <table>
          <tr><th>Key</th><th>Action</th></tr>
          <tr><td><kbd>/</kbd> or <kbd>Ctrl</kbd>+<kbd>K</kbd></td><td>Search</td></tr>
          <tr><td><kbd>1</kbd>–<kbd>6</kbd></td><td>Compare: play a lane. Not sure? and Quiz: choose an answer</td></tr>
          <tr><td><kbd>R</kbd> / <kbd>N</kbd></td><td>Quiz: replay the sound / next question</td></tr>
          <tr><td><kbd>0</kbd></td><td>Play your recording, if you loaded one</td></tr>
          <tr><td><kbd>Space</kbd></td><td>Stop</td></tr>
          <tr><td><kbd>L</kbd></td><td>Loop on or off</td></tr>
        </table>
        <h2>Offline</h2>
        <p>On the website, the download button in the sidebar saves every clip for offline use. You can also download the repository as a ZIP, unzip it, and open <code>index.html</code>. Everything works from disk, including loading your own clips.</p>
        <h2>Where the sounds come from</h2>
        <p>Only openly licensed recordings are used, and every clip's origin is recorded in <code>data/provenance.json</code>. Phrases are assembled from individually recorded notes. Electronic sounds are synthesized in code.</p>
        <table>
          <tr><th>Source</th><th>License</th><th>Clips</th></tr>
          ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `<tr><td>${esc(c)}</td><td>${esc(lic[c])}</td><td class="num">${n}</td></tr>`).join('')}
        </table>
        <p>MuldjordKit by Lars Muldjord is used under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. The steel-string guitar samples are by Gary Campion (FlameStudios), distributed by FreePats under GPL-3.0-or-later with the FreePats exception. The Versilian libraries (VCSL and VSCO 2 CE) are CC0, and we credit them anyway. Recordings from Wikimedia Commons are credited to their authors in the table above and on each clip, under the license shown.</p>
        <p class="credit">© Tarek Gara. Code under the MIT license; each recording keeps its own license. Library build ${esc(LIB.version)} · ${ready.length} instruments with audio · ${LIB.instruments.length - ready.length} listed without.</p>
      </div>`;
  }

  window.Views = { library, instrument, identify, compare: compareView, quiz, about };
})();
