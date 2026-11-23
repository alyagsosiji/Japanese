// 天の川 (Amanogawa) — Main Interactive Application
(function () {
  'use strict';

  const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
  const LEVEL_COUNTS = { N5: 674, N4: 630, N3: 1659, N2: 1778, N1: 3068 };
  const TOTAL_WORDS = 7809;
  const LEVEL_COLORS = {
    N5: 'var(--lvl-n5)',
    N4: 'var(--lvl-n4)',
    N3: 'var(--lvl-n3)',
    N2: 'var(--lvl-n2)',
    N1: 'var(--lvl-n1)'
  };
  const STORAGE_KEY = 'amanogawa_jp_progress_v1';

  // =========================================================================
  // Utilities & Safe Escaping
  // =========================================================================
  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Convert OpenJLPT "{漢字|かんじ}" syntax into safe HTML <ruby> tags
  function renderFuriganaHtml(str) {
    if (!str) return '';
    const tokenRe = /\{([^|{}]+)\|([^|{}]+)\}/g;
    let out = '';
    let lastIndex = 0;
    let match;
    while ((match = tokenRe.exec(str)) !== null) {
      if (match.index > lastIndex) {
        out += escHtml(str.slice(lastIndex, match.index));
      }
      out += `<ruby>${escHtml(match[1])}<rt>${escHtml(match[2])}</rt></ruby>`;
      lastIndex = tokenRe.lastIndex;
    }
    if (lastIndex < str.length) {
      out += escHtml(str.slice(lastIndex));
    }
    return out;
  }

  function stripFurigana(str) {
    if (!str) return '';
    return str.replace(/\{([^|{}]+)\|[^|{}]+\}/g, '$1');
  }

  function hasKanji(str) {
    return /[\u4E00-\u9FFF\u3400-\u4DBF々]/.test(str);
  }

  function shuffleArray(arr) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2400);
  }

  // =========================================================================
  // Speech Synthesis (Native Japanese Audio)
  // =========================================================================
  const speechState = {
    rate: 1.0,
    jaVoice: null,
    warnedNoSpeech: false
  };

  function pickJaVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    const jaVoices = voices.filter((v) => /^ja([-_]|$)/i.test(v.lang));
    if (!jaVoices.length) return null;
    // Prefer natural local or Google/Apple/Microsoft Japanese voices
    return (
      jaVoices.find((v) => /Kyoko|Otoya|Nanami|Google 日本語|Haruka|O-Ren/i.test(v.name)) ||
      jaVoices.find((v) => v.localService) ||
      jaVoices[0]
    );
  }

  if ('speechSynthesis' in window) {
    speechState.jaVoice = pickJaVoice();
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      speechState.jaVoice = pickJaVoice();
    });
  }

  function speakJa(text, rateOverride) {
    const clean = stripFurigana(text).trim();
    if (!clean) return;
    if (!('speechSynthesis' in window)) {
      if (!speechState.warnedNoSpeech) {
        speechState.warnedNoSpeech = true;
        showToast('이 브라우저에서는 음성 합성(TTS)을 지원하지 않습니다.');
      }
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(clean);
      utter.lang = 'ja-JP';
      utter.rate = rateOverride || speechState.rate;
      if (!speechState.jaVoice) speechState.jaVoice = pickJaVoice();
      if (speechState.jaVoice) utter.voice = speechState.jaVoice;
      window.speechSynthesis.speak(utter);
    } catch (_) {
      showToast('음성 재생 중 문제가 발생했습니다.');
    }
  }

  // =========================================================================
  // Progress Persistence (localStorage)
  // =========================================================================
  const progress = {
    mastered: new Set(),
    bookmarks: new Set()
  };

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.mastered)) progress.mastered = new Set(parsed.mastered);
      if (Array.isArray(parsed.bookmarks)) progress.bookmarks = new Set(parsed.bookmarks);
    } catch (_) {
      // Ignore corrupt storage
    }
  }

  function saveProgress() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          mastered: Array.from(progress.mastered),
          bookmarks: Array.from(progress.bookmarks)
        })
      );
    } catch (_) {
      // Ignore quota errors
    }
    updateHeaderProgress();
  }

  function toggleMastered(id) {
    if (progress.mastered.has(id)) {
      progress.mastered.delete(id);
    } else {
      progress.mastered.add(id);
    }
    saveProgress();
    return progress.mastered.has(id);
  }

  function toggleBookmark(id) {
    if (progress.bookmarks.has(id)) {
      progress.bookmarks.delete(id);
    } else {
      progress.bookmarks.add(id);
    }
    saveProgress();
    return progress.bookmarks.has(id);
  }

  function updateHeaderProgress() {
    const el = document.getElementById('header-progress-count');
    if (el) {
      el.textContent = `${progress.mastered.size.toLocaleString()} / ${TOTAL_WORDS.toLocaleString()}`;
    }
  }

  // =========================================================================
  // Vocabulary Data Manager (Lazy Script Injection + Instant Search Indexing)
  // =========================================================================
  const vocabStore = {
    byLevel: {},
    loading: {},
    allLoaded: false,
    allList: [],
    byId: new Map()
  };

  function indexLevel(lvl, rawList) {
    if (vocabStore.byLevel[lvl]) return vocabStore.byLevel[lvl];
    const processed = rawList.map((item, idx) => {
      const entry = {
        ...item,
        _idx: idx,
        _search: `${item.w}\t${item.r}\t${item.m.toLowerCase()}\t${item.k.toLowerCase()}`
      };
      vocabStore.byId.set(entry.i, entry);
      return entry;
    });
    vocabStore.byLevel[lvl] = processed;
    rebuildAllList();
    return processed;
  }

  function rebuildAllList() {
    const combined = [];
    let allReady = true;
    for (const lvl of LEVELS) {
      if (vocabStore.byLevel[lvl]) {
        combined.push(...vocabStore.byLevel[lvl]);
      } else {
        allReady = false;
      }
    }
    vocabStore.allList = combined;
    vocabStore.allLoaded = allReady;
  }

  function loadLevelData(lvl) {
    if (vocabStore.byLevel[lvl]) {
      return Promise.resolve(vocabStore.byLevel[lvl]);
    }
    if (window.AMANOGAWA_VOCAB && window.AMANOGAWA_VOCAB[lvl]) {
      return Promise.resolve(indexLevel(lvl, window.AMANOGAWA_VOCAB[lvl]));
    }
    if (vocabStore.loading[lvl]) {
      return vocabStore.loading[lvl];
    }
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `data/vocab-${lvl.toLowerCase()}.js`;
      script.async = true;
      script.onload = () => {
        if (window.AMANOGAWA_VOCAB && window.AMANOGAWA_VOCAB[lvl]) {
          resolve(indexLevel(lvl, window.AMANOGAWA_VOCAB[lvl]));
        } else {
          reject(new Error(`Failed to parse ${lvl}`));
        }
      };
      script.onerror = () => reject(new Error(`Failed to load ${lvl}`));
      document.head.appendChild(script);
    });
    vocabStore.loading[lvl] = promise;
    return promise;
  }

  function ensureAllLevelsLoaded() {
    return Promise.all(LEVELS.map((lvl) => loadLevelData(lvl))).then(() => vocabStore.allList);
  }

  function getWordsForScope(scope) {
    if (scope === 'ALL') return ensureAllLevelsLoaded();
    if (scope === 'BOOKMARKS') {
      return ensureAllLevelsLoaded().then((all) =>
        all.filter((w) => progress.bookmarks.has(w.i))
      );
    }
    if (scope === 'UNMASTERED') {
      return ensureAllLevelsLoaded().then((all) =>
        all.filter((w) => !progress.mastered.has(w.i))
      );
    }
    if (LEVELS.includes(scope)) return loadLevelData(scope);
    return loadLevelData('N5');
  }

  // =========================================================================
  // Navigation State
  // =========================================================================
  const appState = {
    view: 'kana' // 'kana' | 'vocab' | 'flashcards' | 'quiz'
  };

  function switchView(viewName, opts = {}) {
    appState.view = viewName;
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      const active = btn.dataset.view === viewName;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.view-section').forEach((sec) => {
      sec.classList.toggle('is-active', sec.id === `view-${viewName}`);
    });

    if (viewName === 'vocab') {
      if (opts.level) {
        vocabState.level = opts.level;
        vocabState.page = 1;
        syncVocabLevelButtons();
      }
      if (opts.status) {
        vocabState.status = opts.status;
        vocabState.page = 1;
        const stSel = document.getElementById('vocab-status-filter');
        if (stSel) stSel.value = opts.status;
      }
      renderVocabView();
    } else if (viewName === 'flashcards') {
      if (!fcState.deck.length) initFlashcardDeck();
    } else if (viewName === 'kana') {
      if (opts.subtab) {
        kanaState.subtab = opts.subtab;
        renderKanaView();
      }
    }
  }

  // =========================================================================
  // VIEW 1: KANA OBSERVATORY (기본 발음)
  // =========================================================================
  const kanaState = {
    subtab: 'seion',   // 'seion' | 'dakuon' | 'yoon' | 'rules' | 'quiz'
    script: 'both',    // 'hiragana' | 'katakana' | 'both'
    selected: null,
    quiz: {
      active: false,
      scope: 'seion_hira',
      mode: 'char_to_sound',
      count: 10,
      questions: [],
      index: 0,
      score: 0,
      streak: 0,
      bestStreak: 0,
      answered: false
    }
  };

  function getAllKanaFlat(scope) {
    const K = window.AMANOGAWA_KANA;
    const flatten = (rows) => rows.flatMap((r) => r.items.filter(Boolean));
    if (scope === 'seion_hira' || scope === 'seion_kata') return flatten(K.seionRows);
    if (scope === 'dakuon') return [...flatten(K.dakuonRows), ...flatten(K.handakuonRows)];
    if (scope === 'yoon') return flatten(K.yoonRows);
    return [...flatten(K.seionRows), ...flatten(K.dakuonRows), ...flatten(K.handakuonRows), ...flatten(K.yoonRows)];
  }

  function renderKanaView() {
    document.querySelectorAll('#kana-subtabs .seg-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.kanaTab === kanaState.subtab);
    });

    const scriptSwitch = document.getElementById('kana-script-switch');
    const isChart = ['seion', 'dakuon', 'yoon'].includes(kanaState.subtab);
    if (scriptSwitch) scriptSwitch.style.display = isChart ? 'inline-flex' : 'none';

    document.querySelectorAll('#kana-script-switch .seg-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.script === kanaState.script);
    });

    const container = document.getElementById('kana-stage');
    if (!container) return;

    if (isChart) {
      renderKanaChartLayout(container);
    } else if (kanaState.subtab === 'rules') {
      renderKanaRules(container);
    } else if (kanaState.subtab === 'quiz') {
      renderKanaQuiz(container);
    }
  }

  function renderKanaTile(item, categoryLabel) {
    const isSel = kanaState.selected && kanaState.selected.h === item.h;
    let glyphsHtml = '';
    if (kanaState.script === 'hiragana') {
      glyphsHtml = `<span class="kana-main">${escHtml(item.h)}</span>`;
    } else if (kanaState.script === 'katakana') {
      glyphsHtml = `<span class="kana-main">${escHtml(item.k)}</span>`;
    } else {
      glyphsHtml = `<span class="kana-main">${escHtml(item.h)}</span><span class="kana-pair-sub">${escHtml(item.k)}</span>`;
    }
    return `
      <button type="button" class="kana-tile ${isSel ? 'is-selected' : ''}" data-kana-h="${escHtml(item.h)}" data-kana-cat="${escHtml(categoryLabel)}" aria-label="${escHtml(item.h)} ${escHtml(item.k)} (${escHtml(item.r)}, ${escHtml(item.ko)})">
        <div class="kana-glyphs">${glyphsHtml}</div>
        <div class="kana-romaji">${escHtml(item.r)}</div>
        <div class="kana-ko">${escHtml(item.ko.split('/')[0].trim())}</div>
      </button>
    `;
  }

  function renderKanaChartLayout(container) {
    const K = window.AMANOGAWA_KANA;
    let title = '';
    let note = '';
    let colHeaders = [];
    let isYoon = false;
    let rowsHtml = '';

    if (kanaState.subtab === 'seion') {
      title = '청음 50음도 (清音 · 46자)';
      note = '각 글자를 클릭하면 원어민 발음과 상세 설명을 확인할 수 있습니다.';
      colHeaders = ['あ단 (a)', 'い단 (i)', 'う단 (u)', 'え단 (e)', 'お단 (o)'];
      if (!kanaState.selected) kanaState.selected = { ...K.seionRows[0].items[0], _cat: '청음' };

      rowsHtml = K.seionRows
        .map((row) => {
          const cells = row.items
            .map((item) => (item ? renderKanaTile(item, '청음') : '<div class="kana-empty" aria-hidden="true"></div>'))
            .join('');
          return `
            <div class="kana-row">
              <div class="kana-row-label">
                <span class="kana-row-name">${escHtml(row.row)}</span>
                <span class="kana-row-sub">${escHtml(row.consonant)}</span>
              </div>
              ${cells}
            </div>
          `;
        })
        .join('');
    } else if (kanaState.subtab === 'dakuon') {
      title = '탁음 (20자) · 반탁음 (5자)';
      note = '청음 오른쪽 위에 탁점(゛) 또는 반탁점(゜)을 붙여 유성음·파열음을 표기합니다.';
      colHeaders = ['a 단', 'i 단', 'u 단', 'e 단', 'o 단'];
      if (!kanaState.selected) kanaState.selected = { ...K.dakuonRows[0].items[0], _cat: '탁음' };

      const dakuHtml = K.dakuonRows
        .map((row) => {
          const cells = row.items.map((item) => renderKanaTile(item, '탁음')).join('');
          return `
            <div class="kana-row">
              <div class="kana-row-label">
                <span class="kana-row-name">${escHtml(row.row)}</span>
                <span class="kana-row-sub">${escHtml(row.base)}</span>
              </div>
              ${cells}
            </div>
          `;
        })
        .join('');

      const handakuHtml = K.handakuonRows
        .map((row) => {
          const cells = row.items.map((item) => renderKanaTile(item, '반탁음')).join('');
          return `
            <div class="kana-row">
              <div class="kana-row-label">
                <span class="kana-row-name">${escHtml(row.row)}</span>
                <span class="kana-row-sub">${escHtml(row.base)}</span>
              </div>
              ${cells}
            </div>
          `;
        })
        .join('');

      rowsHtml = `
        <div class="kana-group-divider">탁음 (濁音 · ゛) — か · さ · た · は행</div>
        ${dakuHtml}
        <div class="kana-group-divider">반탁음 (半濁音 · ゜) — は행 전용</div>
        ${handakuHtml}
      `;
    } else if (kanaState.subtab === 'yoon') {
      title = '요음 (拗音 · 33자)';
      note = 'い단 글자 뒤에 작은 ゃ·ゅ·ょ(ャ·ュ·ョ)를 붙여 두 글자를 합쳐 한 박자로 발음합니다.';
      colHeaders = ['+ ゃ / ャ (ya)', '+ ゅ / ュ (yu)', '+ ょ / ョ (yo)'];
      isYoon = true;
      if (!kanaState.selected) kanaState.selected = { ...K.yoonRows[0].items[0], _cat: '청음 요음' };

      let currentGroup = '';
      rowsHtml = K.yoonRows
        .map((row) => {
          let divider = '';
          if (row.group !== currentGroup) {
            currentGroup = row.group;
            divider = `<div class="kana-group-divider">${escHtml(currentGroup)}</div>`;
          }
          const cells = row.items.map((item) => renderKanaTile(item, row.group)).join('');
          return `
            ${divider}
            <div class="kana-row is-yoon">
              <div class="kana-row-label">
                <span class="kana-row-name">${escHtml(row.row)}</span>
              </div>
              ${cells}
            </div>
          `;
        })
        .join('');
    }

    container.innerHTML = `
      <div class="kana-layout">
        <div class="glass-panel kana-chart-panel">
          <div class="kana-chart-header">
            <h2 class="kana-chart-title">${escHtml(title)}</h2>
            <p class="kana-chart-note">${escHtml(note)}</p>
          </div>
          <div class="kana-col-headers ${isYoon ? 'is-yoon' : ''}">
            <div></div>
            ${colHeaders.map((c) => `<div class="kana-col-head">${escHtml(c)}</div>`).join('')}
          </div>
          <div class="kana-rows" id="kana-grid-rows">
            ${rowsHtml}
          </div>
        </div>
        <aside class="glass-panel kana-inspector" id="kana-inspector" aria-live="polite">
          ${renderKanaInspectorHtml(kanaState.selected)}
        </aside>
      </div>
    `;
  }

  function renderKanaInspectorHtml(item) {
    if (!item) return '';
    const originHtml = item.baseH
      ? `<div class="inspector-origin">구성 원리: <strong>${escHtml(item.baseH)}</strong> + ${escHtml(item.mark)} → <strong>${escHtml(item.h)}</strong> (${escHtml(item._cat || '')})</div>`
      : '';

    return `
      <div class="inspector-top">
        <span class="inspector-badge">${escHtml(item._cat || '기본 발음')}</span>
        <div style="display:flex;gap:0.4rem;">
          <button type="button" class="btn-ghost-sm" id="btn-kana-speak-normal" data-speak="${escHtml(item.h)}">
            ${iconSpeaker()} 발음 듣기
          </button>
          <button type="button" class="btn-ghost-sm" id="btn-kana-speak-slow" data-speak="${escHtml(item.h)}" data-rate="0.65">
            천천히
          </button>
        </div>
      </div>

      <div class="inspector-glyph-box">
        <div class="inspector-glyph-cell">
          <span class="inspector-glyph-label">히라가나 (平仮名)</span>
          <span class="inspector-glyph-char">${escHtml(item.h)}</span>
        </div>
        <div class="inspector-glyph-cell">
          <span class="inspector-glyph-label">가타가나 (片仮名)</span>
          <span class="inspector-glyph-char">${escHtml(item.k)}</span>
        </div>
      </div>

      <div class="inspector-phonetics">
        <span class="inspector-romaji-big">${escHtml(item.r)}</span>
        <span class="inspector-ko-big">${escHtml(item.ko)}</span>
      </div>

      ${originHtml}

      <p class="inspector-tip">${escHtml(item.tip)}</p>

      <div class="inspector-ex">
        <div>
          <div class="inspector-ex-label">대표 단어 예시</div>
          <div class="inspector-ex-word">${escHtml(item.ex.w)}</div>
          <div class="inspector-ex-ko">${escHtml(item.ex.ko)}</div>
        </div>
        <button type="button" class="icon-btn" data-speak="${escHtml(item.ex.r)}" aria-label="예시 단어 발음 듣기">
          ${iconSpeaker()}
        </button>
      </div>
    `;
  }

  function findKanaByH(h) {
    const K = window.AMANOGAWA_KANA;
    const allGroups = [
      ...K.seionRows.map((r) => ({ cat: '청음', items: r.items })),
      ...K.dakuonRows.map((r) => ({ cat: '탁음', items: r.items })),
      ...K.handakuonRows.map((r) => ({ cat: '반탁음', items: r.items })),
      ...K.yoonRows.map((r) => ({ cat: r.group, items: r.items }))
    ];
    for (const g of allGroups) {
      for (const it of g.items) {
        if (it && it.h === h) return { ...it, _cat: g.cat };
      }
    }
    return null;
  }

  function renderKanaRules(container) {
    const rules = window.AMANOGAWA_KANA.specialRules;
    const cardsHtml = rules
      .map((rule) => {
        let bodyHtml = '';
        if (rule.rulesTable) {
          bodyHtml = `
            <table class="chouon-table">
              <thead>
                <tr>
                  <th>표기 규칙</th>
                  <th>예시 단어 (클릭 시 발음)</th>
                  <th>뜻</th>
                  <th>비교 · 참고</th>
                </tr>
              </thead>
              <tbody>
                ${rule.rulesTable
                  .map(
                    (row) => `
                  <tr>
                    <td class="chouon-pattern">${escHtml(row.pattern)}</td>
                    <td>
                      <button type="button" class="btn-ghost-sm" data-speak="${escHtml(row.r)}">
                        ${iconSpeaker()} ${escHtml(row.ex)}
                      </button>
                    </td>
                    <td>${escHtml(row.ko)}</td>
                    <td style="color:var(--ink-mist);font-size:0.82rem;">${escHtml(row.pair)}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          `;
        } else if (rule.examples) {
          bodyHtml = `
            <div class="rule-chips">
              ${rule.examples
                .map(
                  (ex) => `
                <button type="button" class="rule-chip" data-speak="${escHtml(ex.r)}">
                  <div class="rule-chip-body">
                    <div class="rule-chip-jp">${escHtml(ex.w)}</div>
                    <div class="rule-chip-rm">${escHtml(ex.m)}</div>
                    <div class="rule-chip-ko">${escHtml(ex.ko)}</div>
                    <div class="rule-chip-note">${escHtml(ex.note)}</div>
                  </div>
                  <span class="icon-btn" aria-hidden="true">${iconSpeaker()}</span>
                </button>
              `
                )
                .join('')}
            </div>
          `;
        }

        return `
          <article class="glass-panel rule-card">
            <div class="rule-head">
              <h2 class="rule-title">${escHtml(rule.title)}</h2>
              <p class="rule-sub">${escHtml(rule.subtitle)}</p>
              <p class="rule-desc">${escHtml(rule.desc)}</p>
            </div>
            ${bodyHtml}
          </article>
        `;
      })
      .join('');

    container.innerHTML = `<div class="rules-stack">${cardsHtml}</div>`;
  }

  // ---- Kana Interactive Quiz ----
  function startKanaQuiz() {
    const q = kanaState.quiz;
    const pool = getAllKanaFlat(q.scope);
    const chosen = shuffleArray(pool).slice(0, Math.min(q.count, pool.length));
    const useKata = q.scope === 'seion_kata';

    q.questions = chosen.map((target) => {
      // Ensure distinct answer values for distractors (important because ぢ=じ, づ=ず share romaji!)
      const getAnswerKey = (it) => {
        if (q.mode === 'char_to_sound') return it.r.split(' ')[0];
        if (q.mode === 'hira_to_kata') return it.k;
        return useKata ? it.k : it.h;
      };
      const correctKey = getAnswerKey(target);
      const usedKeys = new Set([correctKey]);
      const distractors = [];
      for (const cand of shuffleArray(pool)) {
        const ck = getAnswerKey(cand);
        if (!usedKeys.has(ck)) {
          usedKeys.add(ck);
          distractors.push(cand);
        }
        if (distractors.length === 3) break;
      }
      const options = shuffleArray([target, ...distractors]).map((opt) => ({
        item: opt,
        isCorrect: opt.h === target.h,
        label:
          q.mode === 'char_to_sound'
            ? `${opt.r}  (${opt.ko.split('/')[0].trim()})`
            : q.mode === 'hira_to_kata'
              ? opt.k
              : useKata
                ? opt.k
                : opt.h
      }));
      return { target, options, useKata };
    });

    q.active = true;
    q.index = 0;
    q.score = 0;
    q.streak = 0;
    q.bestStreak = 0;
    q.answered = false;
    renderKanaView();

    if (q.mode === 'listen_to_char' && q.questions[0]) {
      setTimeout(() => speakJa(q.questions[0].target.h), 180);
    }
  }

  function renderKanaQuiz(container) {
    const q = kanaState.quiz;
    if (!q.active) {
      container.innerHTML = `
        <div class="quiz-container">
          <div class="glass-panel quiz-setup">
            <h2 class="quiz-setup-title">가나 발음 퀴즈</h2>
            <p class="quiz-setup-desc">히라가나·가타가나·탁음·반탁음·요음을 듣고 보며 빠르게 익혀 보세요.</p>

            <div class="quiz-field">
              <span class="quiz-field-label">출제 범위</span>
              <div class="choice-pills" data-kq-group="scope">
                ${[
                  ['seion_hira', '히라가나 청음 (46)'],
                  ['seion_kata', '가타가나 청음 (46)'],
                  ['dakuon', '탁음 · 반탁음 (25)'],
                  ['yoon', '요음 (33)'],
                  ['all', '전체 종합 (104)']
                ]
                  .map(
                    ([val, lbl]) =>
                      `<button type="button" class="choice-pill ${q.scope === val ? 'is-selected' : ''}" data-kq-scope="${val}">${lbl}</button>`
                  )
                  .join('')}
              </div>
            </div>

            <div class="quiz-field">
              <span class="quiz-field-label">퀴즈 방식</span>
              <div class="choice-pills" data-kq-group="mode">
                ${[
                  ['char_to_sound', '문자 → 발음 맞추기'],
                  ['listen_to_char', '발음 듣고 문자 찾기'],
                  ['hira_to_kata', '히라가나 → 가타가나 짝짓기']
                ]
                  .map(
                    ([val, lbl]) =>
                      `<button type="button" class="choice-pill ${q.mode === val ? 'is-selected' : ''}" data-kq-mode="${val}">${lbl}</button>`
                  )
                  .join('')}
              </div>
            </div>

            <div class="quiz-field">
              <span class="quiz-field-label">문항 수</span>
              <div class="choice-pills" data-kq-group="count">
                ${[10, 20, 30]
                  .map(
                    (n) =>
                      `<button type="button" class="choice-pill ${q.count === n ? 'is-selected' : ''}" data-kq-count="${n}">${n}문제</button>`
                  )
                  .join('')}
              </div>
            </div>

            <button type="button" class="btn-primary" id="btn-start-kana-quiz">가나 퀴즈 시작</button>
          </div>
        </div>
      `;
      return;
    }

    if (q.index >= q.questions.length) {
      const pct = Math.round((q.score / q.questions.length) * 100);
      container.innerHTML = `
        <div class="quiz-container">
          <div class="glass-panel quiz-summary">
            <div class="inspector-badge">가나 퀴즈 완료</div>
            <div class="summary-score">${pct}%</div>
            <p style="color:var(--ink-silver);margin-bottom:1.4rem;">
              ${q.questions.length}문제 중 <strong style="color:var(--ink-star);">${q.score}문제</strong> 정답 · 최고 연속 정답 <strong style="color:var(--gold);">${q.bestStreak}회</strong>
            </p>
            <div style="display:flex;justify-content:center;gap:0.75rem;flex-wrap:wrap;">
              <button type="button" class="btn-primary" id="btn-retry-kana-quiz">다시 풀기</button>
              <button type="button" class="btn-secondary" id="btn-reset-kana-quiz">설정 바꾸기</button>
            </div>
          </div>
        </div>
      `;
      return;
    }

    const cur = q.questions[q.index];
    const pct = Math.round((q.index / q.questions.length) * 100);
    let promptHtml = '';
    if (q.mode === 'char_to_sound') {
      const glyph = cur.useKata ? cur.target.k : cur.target.h;
      promptHtml = `
        <div class="quiz-prompt-label">다음 글자의 올바른 발음은?</div>
        <div class="quiz-prompt-main">${escHtml(glyph)}</div>
        <div style="margin-top:0.7rem;">
          <button type="button" class="btn-ghost-sm" data-speak="${escHtml(cur.target.h)}">${iconSpeaker()} 발음 힌트 듣기</button>
        </div>
      `;
    } else if (q.mode === 'listen_to_char') {
      promptHtml = `
        <div class="quiz-prompt-label">발음을 듣고 알맞은 글자를 고르세요</div>
        <div style="margin:0.8rem 0;">
          <button type="button" class="btn-primary" data-speak="${escHtml(cur.target.h)}">${iconSpeaker()} 발음 다시 듣기</button>
        </div>
      `;
    } else {
      promptHtml = `
        <div class="quiz-prompt-label">다음 히라가나에 대응하는 가타가나는?</div>
        <div class="quiz-prompt-main">${escHtml(cur.target.h)}</div>
        <div class="quiz-prompt-sub">${escHtml(cur.target.r)} · ${escHtml(cur.target.ko)}</div>
      `;
    }

    container.innerHTML = `
      <div class="quiz-container">
        <div class="glass-panel quiz-card">
          <div class="quiz-top">
            <span>문제 <strong>${q.index + 1}</strong> / ${q.questions.length}</span>
            <span class="quiz-streak">연속 정답 ${q.streak}</span>
            <button type="button" class="btn-ghost-sm" id="btn-reset-kana-quiz">그만하기</button>
          </div>
          <div class="fc-track"><div class="fc-track-fill" style="width:${pct}%"></div></div>

          <div class="quiz-prompt-box">${promptHtml}</div>

          <div class="quiz-options" id="kana-quiz-options">
            ${cur.options
              .map(
                (opt, i) => `
              <button type="button" class="quiz-opt" data-kq-opt="${i}">
                <span class="quiz-opt-num">${i + 1}</span>
                <span style="${q.mode !== 'char_to_sound' ? 'font-family:var(--font-serif);font-size:1.5rem;' : ''}">${escHtml(opt.label)}</span>
              </button>
            `
              )
              .join('')}
          </div>
          <div id="kana-quiz-feedback"></div>
        </div>
      </div>
    `;
  }

  function handleKanaQuizAnswer(optIdx) {
    const q = kanaState.quiz;
    if (!q.active || q.answered) return;
    q.answered = true;

    const cur = q.questions[q.index];
    const picked = cur.options[optIdx];
    const buttons = document.querySelectorAll('#kana-quiz-options .quiz-opt');
    buttons.forEach((btn, i) => {
      btn.disabled = true;
      if (cur.options[i].isCorrect) btn.classList.add('is-correct');
      else if (i === optIdx) btn.classList.add('is-wrong');
    });

    if (picked.isCorrect) {
      q.score++;
      q.streak++;
      if (q.streak > q.bestStreak) q.bestStreak = q.streak;
    } else {
      q.streak = 0;
    }
    speakJa(cur.target.h);

    const fb = document.getElementById('kana-quiz-feedback');
    if (fb) {
      fb.innerHTML = `
        <div class="quiz-feedback">
          <div>
            <strong style="color:${picked.isCorrect ? 'var(--ok)' : 'var(--err)'};">
              ${picked.isCorrect ? '정답입니다!' : '아쉬워요!'}
            </strong>
            <span style="color:var(--ink-silver);margin-left:0.5rem;">
              ${escHtml(cur.target.h)} / ${escHtml(cur.target.k)} · ${escHtml(cur.target.r)} (${escHtml(cur.target.ko)})
            </span>
          </div>
          <button type="button" class="btn-primary" id="btn-kana-quiz-next">
            ${q.index + 1 >= q.questions.length ? '결과 보기' : '다음 문제'}
          </button>
        </div>
      `;
    }
  }

  // =========================================================================
  // VIEW 2: JLPT VOCABULARY LEXICON (7,809 Words)
  // =========================================================================
  const vocabState = {
    level: 'N5',
    query: '',
    pos: 'ALL',
    status: 'ALL',
    sort: 'default',
    showFurigana: true,
    hideMeanings: false,
    page: 1,
    pageSize: 48,
    filtered: [],
    shuffledOrder: null
  };

  function syncVocabLevelButtons() {
    document.querySelectorAll('#vocab-level-tabs .level-tab').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.level === vocabState.level);
    });
  }

  async function renderVocabView() {
    const grid = document.getElementById('vocab-grid');
    const meta = document.getElementById('vocab-results-meta');
    const pagEl = document.getElementById('vocab-pagination');
    if (!grid) return;

    grid.classList.toggle('hide-furigana', !vocabState.showFurigana);
    grid.classList.toggle('hide-meanings', vocabState.hideMeanings);

    // Load required level(s)
    const needAll = vocabState.level === 'ALL' || vocabState.status === 'BOOKMARKS';
    if ((needAll && !vocabStore.allLoaded) || (!needAll && !vocabStore.byLevel[vocabState.level])) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-title">별자리 단어를 불러오는 중...</div></div>';
    }

    let source;
    try {
      source = needAll ? await ensureAllLevelsLoaded() : await loadLevelData(vocabState.level);
    } catch (_) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-title">단어 데이터를 불러오지 못했습니다.</div></div>';
      return;
    }

    // Apply filters
    const q = vocabState.query.trim().toLowerCase();
    let list = source.filter((item) => {
      if (vocabState.level !== 'ALL' && item.l !== vocabState.level) return false;
      if (vocabState.pos !== 'ALL' && item.c !== vocabState.pos) return false;
      if (vocabState.status === 'MASTERED' && !progress.mastered.has(item.i)) return false;
      if (vocabState.status === 'UNMASTERED' && progress.mastered.has(item.i)) return false;
      if (vocabState.status === 'BOOKMARKS' && !progress.bookmarks.has(item.i)) return false;
      if (q && !item._search.includes(q)) return false;
      return true;
    });

    if (vocabState.sort === 'kana') {
      list = list.slice().sort((a, b) => a.r.localeCompare(b.r, 'ja'));
    } else if (vocabState.sort === 'random') {
      if (!vocabState.shuffledOrder) {
        vocabState.shuffledOrder = new Map();
      }
      list = list.slice().sort((a, b) => {
        if (!vocabState.shuffledOrder.has(a.i)) vocabState.shuffledOrder.set(a.i, Math.random());
        if (!vocabState.shuffledOrder.has(b.i)) vocabState.shuffledOrder.set(b.i, Math.random());
        return vocabState.shuffledOrder.get(a.i) - vocabState.shuffledOrder.get(b.i);
      });
    }

    vocabState.filtered = list;
    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / vocabState.pageSize));
    if (vocabState.page > totalPages) vocabState.page = totalPages;

    const start = (vocabState.page - 1) * vocabState.pageSize;
    const pageItems = list.slice(start, start + vocabState.pageSize);

    if (meta) {
      const masteredInScope = list.reduce((acc, w) => acc + (progress.mastered.has(w.i) ? 1 : 0), 0);
      meta.innerHTML = `
        <span>검색 결과 <strong>${total.toLocaleString()}</strong>단어 · 암기 완료 <strong>${masteredInScope.toLocaleString()}</strong>단어</span>
        <span>페이지 <strong>${vocabState.page}</strong> / ${totalPages}</span>
      `;
    }

    if (!pageItems.length) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1;">
          <div class="empty-state-title">조건에 맞는 단어가 없습니다</div>
          <p>검색어나 필터 조건을 조정해 보세요.</p>
        </div>
      `;
      if (pagEl) pagEl.innerHTML = '';
      return;
    }

    grid.innerHTML = pageItems
      .map((item, localIdx) => {
        const globalIdx = start + localIdx;
        const isStar = progress.bookmarks.has(item.i);
        const isDone = progress.mastered.has(item.i);
        const showReading = item.w !== item.r;
        return `
          <article class="word-card ${isDone ? 'is-mastered' : ''}" data-word-idx="${globalIdx}" data-word-id="${escHtml(item.i)}" tabindex="0" role="button" aria-label="${escHtml(item.w)} ${escHtml(item.k)} 상세 보기">
            <div>
              <div class="word-card-top">
                <div class="word-badges">
                  <span class="lvl-badge" data-level="${item.l}">${item.l}</span>
                  <span class="pos-tag">${escHtml(item.p)}</span>
                </div>
                <div class="word-actions">
                  <button type="button" class="icon-btn" data-action="speak" data-speak="${escHtml(item.r)}" aria-label="발음 듣기" title="발음 듣기">${iconSpeaker()}</button>
                  <button type="button" class="icon-btn ${isStar ? 'is-starred' : ''}" data-action="star" data-word-id="${escHtml(item.i)}" aria-label="별표 저장" title="별표 저장">${iconStar(isStar)}</button>
                  <button type="button" class="icon-btn ${isDone ? 'is-mastered' : ''}" data-action="master" data-word-id="${escHtml(item.i)}" aria-label="암기 완료" title="암기 완료">${iconCheck()}</button>
                </div>
              </div>
              <div class="word-main-area">
                <div class="word-reading">${showReading ? escHtml(item.r) : '&nbsp;'}</div>
                <div class="word-kanji">${escHtml(item.w)}</div>
                <div class="word-romaji">${escHtml(item.m)}</div>
              </div>
            </div>
            <div class="word-meaning-row">
              <div class="word-ko">${escHtml(item.k)}</div>
              ${item.ej ? '<span class="word-ex-indicator">예문</span>' : ''}
            </div>
          </article>
        `;
      })
      .join('');

    renderPagination(pagEl, vocabState.page, totalPages);
  }

  function renderPagination(container, current, totalPages) {
    if (!container) return;
    if (totalPages <= 1) {
      container.innerHTML = '';
      return;
    }

    const pages = [];
    const add = (p) => {
      if (!pages.includes(p)) pages.push(p);
    };
    add(1);
    for (let p = Math.max(2, current - 2); p <= Math.min(totalPages - 1, current + 2); p++) add(p);
    add(totalPages);
    pages.sort((a, b) => a - b);

    let html = `<button type="button" class="page-btn" data-page="${current - 1}" ${current === 1 ? 'disabled' : ''}>이전</button>`;
    let prev = 0;
    for (const p of pages) {
      if (prev && p - prev > 1) {
        html += `<span style="color:var(--ink-dim);padding:0 0.25rem;">…</span>`;
      }
      html += `<button type="button" class="page-btn ${p === current ? 'is-current' : ''}" data-page="${p}">${p}</button>`;
      prev = p;
    }
    html += `<button type="button" class="page-btn" data-page="${current + 1}" ${current === totalPages ? 'disabled' : ''}>다음</button>`;
    html += `
      <form class="page-jump" id="page-jump-form">
        <label for="page-jump-input">이동</label>
        <input id="page-jump-input" type="number" min="1" max="${totalPages}" value="${current}" aria-label="페이지 번호 입력" />
      </form>
    `;
    container.innerHTML = html;
  }

  // ---- Word Detail Modal ----
  const modalState = {
    open: false,
    index: -1
  };

  function openWordModal(filteredIdx) {
    const item = vocabState.filtered[filteredIdx];
    if (!item) return;
    modalState.open = true;
    modalState.index = filteredIdx;

    const backdrop = document.getElementById('word-modal');
    const body = document.getElementById('word-modal-body');
    if (!backdrop || !body) return;

    const isStar = progress.bookmarks.has(item.i);
    const isDone = progress.mastered.has(item.i);
    const total = vocabState.filtered.length;

    body.innerHTML = `
      <div class="modal-header">
        <div class="word-badges">
          <span class="lvl-badge" data-level="${item.l}">${item.l}</span>
          <span class="pos-tag" style="font-size:0.82rem;color:var(--ink-silver);">${escHtml(item.p)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:0.4rem;">
          <button type="button" class="icon-btn ${isStar ? 'is-starred' : ''}" id="modal-star-btn" data-word-id="${escHtml(item.i)}" aria-label="별표 저장">${iconStar(isStar)}</button>
          <button type="button" class="icon-btn ${isDone ? 'is-mastered' : ''}" id="modal-master-btn" data-word-id="${escHtml(item.i)}" aria-label="암기 완료">${iconCheck()}</button>
          <button type="button" class="icon-btn" id="modal-close-btn" aria-label="닫기">${iconClose()}</button>
        </div>
      </div>

      <div class="modal-word-hero">
        <div class="modal-word-jp">${escHtml(item.w)}</div>
        <div class="modal-word-reading">${escHtml(item.r)}</div>
        <div class="modal-word-romaji">${escHtml(item.m)}</div>
        <div class="modal-audio-row">
          <button type="button" class="btn-secondary" data-speak="${escHtml(item.r)}">${iconSpeaker()} 발음 듣기</button>
          <button type="button" class="btn-ghost-sm" data-speak="${escHtml(item.r)}" data-rate="0.7">천천히 (0.7x)</button>
        </div>
      </div>

      <div class="modal-meaning-block">
        <div class="modal-label">한국어 뜻</div>
        <div class="modal-meaning-text">${escHtml(item.k)}</div>
      </div>

      ${
        item.ej
          ? `
        <div class="modal-example-block">
          <div class="modal-ex-header">
            <span class="modal-label" style="margin:0;">예문 (후리가나 포함)</span>
            <button type="button" class="btn-ghost-sm" data-speak="${escHtml(stripFurigana(item.ej))}">
              ${iconSpeaker()} 예문 듣기
            </button>
          </div>
          <div class="modal-ex-ja">${renderFuriganaHtml(item.ej)}</div>
          <div class="modal-ex-ko">${escHtml(item.ek)}</div>
        </div>
      `
          : ''
      }

      <div class="modal-nav-footer">
        <button type="button" class="btn-secondary" id="modal-prev-btn" ${filteredIdx <= 0 ? 'disabled' : ''}>← 이전 단어</button>
        <span style="font-family:var(--font-mono);font-size:0.78rem;color:var(--ink-mist);">${filteredIdx + 1} / ${total}</span>
        <button type="button" class="btn-secondary" id="modal-next-btn" ${filteredIdx >= total - 1 ? 'disabled' : ''}>다음 단어 →</button>
      </div>
    `;

    backdrop.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closeWordModal() {
    modalState.open = false;
    const backdrop = document.getElementById('word-modal');
    if (backdrop) backdrop.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  // =========================================================================
  // VIEW 3: FLASHCARDS (별자리 암기)
  // =========================================================================
  const fcState = {
    scope: 'N5',
    count: 20,
    dir: 'ja_ko', // 'ja_ko' | 'ko_ja'
    autoSpeak: true,
    deck: [],
    doneCount: 0,
    initialTotal: 0,
    flipped: false,
    showReadingHint: false
  };

  async function initFlashcardDeck() {
    const stage = document.getElementById('flashcard-stage');
    if (stage) {
      stage.innerHTML = '<div class="empty-state"><div class="empty-state-title">별자리 카드를 준비하는 중...</div></div>';
    }

    let pool = await getWordsForScope(fcState.scope);
    if (!pool.length) {
      fcState.deck = [];
      if (stage) {
        stage.innerHTML = `
          <div class="glass-panel empty-state">
            <div class="empty-state-title">선택한 범위에 단어가 없습니다</div>
            <p style="margin-top:0.4rem;">다른 급수를 선택하거나 단어장에서 별표(★)를 추가해 보세요.</p>
          </div>
        `;
      }
      return;
    }

    const shuffled = shuffleArray(pool);
    fcState.deck = fcState.count === 0 ? shuffled : shuffled.slice(0, Math.min(fcState.count, shuffled.length));
    fcState.initialTotal = fcState.deck.length;
    fcState.doneCount = 0;
    fcState.flipped = false;
    fcState.showReadingHint = false;
    renderFlashcard();

    if (fcState.autoSpeak && fcState.dir === 'ja_ko' && fcState.deck[0]) {
      setTimeout(() => speakJa(fcState.deck[0].r), 220);
    }
  }

  function renderFlashcard() {
    const stage = document.getElementById('flashcard-stage');
    if (!stage) return;

    if (!fcState.deck.length) {
      stage.innerHTML = `
        <div class="glass-panel quiz-summary">
          <div class="inspector-badge">별자리 회독 완료</div>
          <div class="summary-score">${fcState.initialTotal}</div>
          <p style="color:var(--ink-silver);margin-bottom:1.5rem;">
            준비된 <strong>${fcState.initialTotal}개</strong>의 단어를 모두 학습했습니다!
          </p>
          <button type="button" class="btn-primary" id="fc-restart-done">새 카드 세트 시작</button>
        </div>
      `;
      return;
    }

    const card = fcState.deck[0];
    const pct = Math.min(100, Math.round((fcState.doneCount / Math.max(1, fcState.initialTotal)) * 100));
    const isStar = progress.bookmarks.has(card.i);
    const isJaFront = fcState.dir === 'ja_ko';

    stage.innerHTML = `
      <div class="fc-progress-row">
        <span>남은 카드 <strong>${fcState.deck.length}</strong>장 · 완료 <strong>${fcState.doneCount}</strong> / ${fcState.initialTotal}</span>
        <span>${pct}%</span>
      </div>
      <div class="fc-track"><div class="fc-track-fill" style="width:${pct}%"></div></div>

      <div class="fc-scene">
        <div class="fc-card ${fcState.flipped ? 'is-flipped' : ''}" id="fc-card-el" tabindex="0" role="button" aria-label="플래시카드 뒤집기">
          <!-- FRONT -->
          <div class="fc-face fc-front">
            <div class="fc-face-top">
              <div class="word-badges">
                <span class="lvl-badge" data-level="${card.l}">${card.l}</span>
                <span class="pos-tag">${escHtml(card.p)}</span>
              </div>
              <div style="display:flex;gap:0.35rem;">
                ${isJaFront ? `<button type="button" class="icon-btn" data-fc-speak="${escHtml(card.r)}" aria-label="발음 듣기">${iconSpeaker()}</button>` : ''}
                <button type="button" class="icon-btn ${isStar ? 'is-starred' : ''}" data-fc-star="${escHtml(card.i)}" aria-label="별표 저장">${iconStar(isStar)}</button>
              </div>
            </div>

            <div class="fc-center">
              ${
                isJaFront
                  ? `
                <div class="fc-word-big">${escHtml(card.w)}</div>
                ${
                  card.w !== card.r
                    ? fcState.showReadingHint
                      ? `<div class="fc-reading-big">${escHtml(card.r)}</div><div class="fc-romaji-big">${escHtml(card.m)}</div>`
                      : `<button type="button" class="btn-ghost-sm" id="fc-hint-btn" style="margin-top:0.5rem;">읽기(후리가나) 힌트</button>`
                    : `<div class="fc-romaji-big">${escHtml(card.m)}</div>`
                }
              `
                  : `
                <div class="fc-meaning-big" style="font-size:clamp(1.5rem,3.6vw,2.15rem);">${escHtml(card.k)}</div>
                <div style="font-size:0.84rem;color:var(--ink-mist);">${escHtml(card.p)}</div>
              `
              }
            </div>

            <div class="fc-hint-footer">카드를 클릭하거나 <kbd>Space</kbd>를 눌러 정답 확인</div>
          </div>

          <!-- BACK -->
          <div class="fc-face fc-back">
            <div class="fc-face-top">
              <div class="word-badges">
                <span class="lvl-badge" data-level="${card.l}">${card.l}</span>
                <span class="pos-tag">${escHtml(card.p)}</span>
              </div>
              <div style="display:flex;gap:0.35rem;">
                <button type="button" class="icon-btn" data-fc-speak="${escHtml(card.r)}" aria-label="발음 듣기">${iconSpeaker()}</button>
                <button type="button" class="icon-btn ${isStar ? 'is-starred' : ''}" data-fc-star="${escHtml(card.i)}" aria-label="별표 저장">${iconStar(isStar)}</button>
              </div>
            </div>

            <div class="fc-center" style="padding:0.5rem 0;">
              <div class="fc-word-big" style="font-size:clamp(1.85rem,4.4vw,2.6rem);margin-bottom:0.2rem;">${escHtml(card.w)}</div>
              <div class="fc-reading-big">${escHtml(card.r)} <span class="fc-romaji-big">(${escHtml(card.m)})</span></div>
              <div class="fc-meaning-big" style="margin-top:0.55rem;">${escHtml(card.k)}</div>
              ${
                card.ej
                  ? `
                <div class="fc-example-box">
                  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.5rem;">
                    <div class="fc-ex-ja">${renderFuriganaHtml(card.ej)}</div>
                    <button type="button" class="icon-btn" style="width:28px;height:28px;" data-fc-speak="${escHtml(stripFurigana(card.ej))}" aria-label="예문 듣기">${iconSpeaker()}</button>
                  </div>
                  <div class="fc-ex-ko">${escHtml(card.ek)}</div>
                </div>
              `
                  : ''
              }
            </div>

            <div class="fc-hint-footer">기억 정도를 선택하면 다음 카드로 이동합니다</div>
          </div>
        </div>
      </div>

      <div class="fc-actions">
        <button type="button" class="fc-grade-btn grade-again" data-fc-grade="again">
          <span class="fc-grade-title">다시 보기 (1)</span>
          <span class="fc-grade-sub">곧 다시 출제</span>
        </button>
        <button type="button" class="fc-grade-btn grade-hard" data-fc-grade="hard">
          <span class="fc-grade-title">애매함 (2)</span>
          <span class="fc-grade-sub">뒤에 한 번 더</span>
        </button>
        <button type="button" class="fc-grade-btn grade-good" data-fc-grade="good">
          <span class="fc-grade-title">암기 완료 (3)</span>
          <span class="fc-grade-sub">암기 목록 저장</span>
        </button>
      </div>
      <div class="fc-shortcuts">
        <kbd>Space</kbd> 뒤집기 · <kbd>A</kbd> 발음 듣기 · <kbd>1</kbd> 다시 보기 · <kbd>2</kbd> 애매함 · <kbd>3</kbd> 암기 완료
      </div>
    `;
  }

  function gradeFlashcard(grade) {
    if (!fcState.deck.length) return;
    const current = fcState.deck.shift();
    if (grade === 'again') {
      const insertAt = Math.min(3, fcState.deck.length);
      fcState.deck.splice(insertAt, 0, current);
    } else if (grade === 'hard') {
      const insertAt = Math.min(7, fcState.deck.length);
      fcState.deck.splice(insertAt, 0, current);
    } else {
      fcState.doneCount++;
      progress.mastered.add(current.i);
      saveProgress();
    }

    fcState.flipped = false;
    fcState.showReadingHint = false;
    renderFlashcard();

    if (fcState.autoSpeak && fcState.dir === 'ja_ko' && fcState.deck[0]) {
      setTimeout(() => speakJa(fcState.deck[0].r), 180);
    }
  }

  // =========================================================================
  // VIEW 4: JLPT VOCABULARY QUIZ (성운 테스트)
  // =========================================================================
  const quizState = {
    active: false,
    scope: 'N5',
    mode: 'meaning', // 'meaning' | 'reading' | 'listening'
    count: 10,
    questions: [],
    index: 0,
    score: 0,
    streak: 0,
    bestStreak: 0,
    answered: false,
    wrongs: []
  };

  async function startVocabQuiz() {
    const stage = document.getElementById('quiz-stage');
    if (stage) {
      stage.innerHTML = '<div class="glass-panel empty-state"><div class="empty-state-title">문제를 출제하는 중...</div></div>';
    }

    let pool = await getWordsForScope(quizState.scope);
    if (quizState.mode === 'reading') {
      pool = pool.filter((w) => hasKanji(w.w) && w.w !== w.r);
    }

    if (pool.length < 4) {
      showToast('퀴즈를 출제하려면 최소 4개 이상의 단어가 필요합니다.');
      quizState.active = false;
      renderVocabQuiz();
      return;
    }

    // Use broader distractor pool if scope is bookmarks and small
    let distractorPool = pool;
    if (distractorPool.length < 20) {
      distractorPool = await loadLevelData('N5');
    }

    const targets = shuffleArray(pool).slice(0, Math.min(quizState.count, pool.length));
    const getAnswerStr = (w) => (quizState.mode === 'reading' ? w.r : w.k);

    quizState.questions = targets.map((target) => {
      const correctAns = getAnswerStr(target);
      const used = new Set([correctAns]);
      const distractors = [];
      for (const cand of shuffleArray(distractorPool)) {
        if (cand.i === target.i) continue;
        const ans = getAnswerStr(cand);
        if (!used.has(ans)) {
          used.add(ans);
          distractors.push(cand);
        }
        if (distractors.length === 3) break;
      }
      const options = shuffleArray([target, ...distractors]).map((opt) => ({
        word: opt,
        isCorrect: opt.i === target.i,
        label: getAnswerStr(opt)
      }));
      return { target, options };
    });

    quizState.active = true;
    quizState.index = 0;
    quizState.score = 0;
    quizState.streak = 0;
    quizState.bestStreak = 0;
    quizState.answered = false;
    quizState.wrongs = [];
    renderVocabQuiz();

    if (quizState.mode === 'listening' && quizState.questions[0]) {
      setTimeout(() => speakJa(quizState.questions[0].target.r), 220);
    }
  }

  function renderVocabQuiz() {
    const stage = document.getElementById('quiz-stage');
    if (!stage) return;

    if (!quizState.active) {
      stage.innerHTML = `
        <div class="quiz-container">
          <div class="glass-panel quiz-setup">
            <h2 class="quiz-setup-title">JLPT 성운 단어 테스트</h2>
            <p class="quiz-setup-desc">원하는 급수와 유형을 선택해 실력을 점검해 보세요. 오답은 마지막에 한 번에 복습할 수 있습니다.</p>

            <div class="quiz-field">
              <span class="quiz-field-label">출제 급수</span>
              <div class="choice-pills">
                ${[
                  ['N5', 'N5 (674)'],
                  ['N4', 'N4 (630)'],
                  ['N3', 'N3 (1,659)'],
                  ['N2', 'N2 (1,778)'],
                  ['N1', 'N1 (3,068)'],
                  ['ALL', '전 급수 종합'],
                  ['BOOKMARKS', `별표 단어 (${progress.bookmarks.size})`]
                ]
                  .map(
                    ([val, lbl]) =>
                      `<button type="button" class="choice-pill ${quizState.scope === val ? 'is-selected' : ''}" data-vq-scope="${val}">${lbl}</button>`
                  )
                  .join('')}
              </div>
            </div>

            <div class="quiz-field">
              <span class="quiz-field-label">문제 유형</span>
              <div class="choice-pills">
                ${[
                  ['meaning', '뜻 맞추기 (일 → 한)'],
                  ['reading', '읽기 맞추기 (한자 → 히라가나)'],
                  ['listening', '듣고 뜻 맞추기 (음성)']
                ]
                  .map(
                    ([val, lbl]) =>
                      `<button type="button" class="choice-pill ${quizState.mode === val ? 'is-selected' : ''}" data-vq-mode="${val}">${lbl}</button>`
                  )
                  .join('')}
              </div>
            </div>

            <div class="quiz-field">
              <span class="quiz-field-label">문항 수</span>
              <div class="choice-pills">
                ${[10, 20, 30]
                  .map(
                    (n) =>
                      `<button type="button" class="choice-pill ${quizState.count === n ? 'is-selected' : ''}" data-vq-count="${n}">${n}문제</button>`
                  )
                  .join('')}
              </div>
            </div>

            <button type="button" class="btn-primary" id="btn-start-vq">테스트 시작</button>
          </div>
        </div>
      `;
      return;
    }

    if (quizState.index >= quizState.questions.length) {
      const pct = Math.round((quizState.score / quizState.questions.length) * 100);
      const wrongHtml = quizState.wrongs.length
        ? `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:1.75rem;">
            <h3 style="font-size:0.95rem;color:var(--gold);">오답 노트 (${quizState.wrongs.length}개)</h3>
            <button type="button" class="btn-ghost-sm" id="btn-star-all-wrongs">★ 오답 전부 별표 저장</button>
          </div>
          <div class="wrong-list">
            ${quizState.wrongs
              .map(
                (w) => `
              <div class="wrong-item">
                <div>
                  <div style="display:flex;align-items:center;gap:0.45rem;">
                    <span class="lvl-badge" data-level="${w.l}">${w.l}</span>
                    <strong style="font-family:var(--font-jp);font-size:1.05rem;">${escHtml(w.w)}</strong>
                    <span style="font-family:var(--font-jp);color:var(--gold);font-size:0.85rem;">${escHtml(w.r)}</span>
                  </div>
                  <div style="font-size:0.86rem;color:var(--ink-silver);margin-top:0.15rem;">${escHtml(w.k)}</div>
                </div>
                <button type="button" class="icon-btn" data-speak="${escHtml(w.r)}" aria-label="발음 듣기">${iconSpeaker()}</button>
              </div>
            `
              )
              .join('')}
          </div>
        `
        : '<p style="color:var(--ok);margin-top:1rem;font-weight:500;">모든 문제를 완벽하게 맞혔습니다!</p>';

      stage.innerHTML = `
        <div class="quiz-container">
          <div class="glass-panel quiz-summary">
            <div class="inspector-badge">성운 테스트 결과</div>
            <div class="summary-score">${pct}%</div>
            <p style="color:var(--ink-silver);">
              ${quizState.questions.length}문제 중 <strong style="color:var(--ink-star);">${quizState.score}문제</strong> 정답 · 최고 연속 정답 <strong style="color:var(--gold);">${quizState.bestStreak}회</strong>
            </p>
            <div style="display:flex;justify-content:center;gap:0.7rem;margin-top:1.3rem;flex-wrap:wrap;">
              <button type="button" class="btn-primary" id="btn-retry-vq">같은 설정으로 다시 풀기</button>
              <button type="button" class="btn-secondary" id="btn-reset-vq">설정으로 돌아가기</button>
            </div>
            ${wrongHtml}
          </div>
        </div>
      `;
      return;
    }

    const cur = quizState.questions[quizState.index];
    const t = cur.target;
    const pct = Math.round((quizState.index / quizState.questions.length) * 100);

    let promptHtml = '';
    if (quizState.mode === 'meaning') {
      promptHtml = `
        <div class="quiz-prompt-label">${t.l} · ${escHtml(t.p)} — 올바른 한국어 뜻은?</div>
        <div class="quiz-prompt-main">${escHtml(t.w)}</div>
        ${t.w !== t.r ? `<div class="quiz-prompt-sub">${escHtml(t.r)}</div>` : ''}
        <div style="margin-top:0.75rem;">
          <button type="button" class="btn-ghost-sm" data-speak="${escHtml(t.r)}">${iconSpeaker()} 발음 듣기</button>
        </div>
      `;
    } else if (quizState.mode === 'reading') {
      promptHtml = `
        <div class="quiz-prompt-label">${t.l} · ${escHtml(t.p)} — 이 한자 단어의 올바른 읽기는?</div>
        <div class="quiz-prompt-main">${escHtml(t.w)}</div>
        <div style="font-size:0.9rem;color:var(--ink-silver);margin-top:0.4rem;">뜻: ${escHtml(t.k)}</div>
      `;
    } else {
      promptHtml = `
        <div class="quiz-prompt-label">${t.l} · 발음을 듣고 올바른 뜻을 고르세요</div>
        <div style="margin:0.85rem 0;">
          <button type="button" class="btn-primary" data-speak="${escHtml(t.r)}">${iconSpeaker()} 발음 다시 듣기 (R)</button>
        </div>
      `;
    }

    stage.innerHTML = `
      <div class="quiz-container">
        <div class="glass-panel quiz-card">
          <div class="quiz-top">
            <span>문제 <strong>${quizState.index + 1}</strong> / ${quizState.questions.length}</span>
            <span class="quiz-streak">연속 정답 ${quizState.streak}</span>
            <button type="button" class="btn-ghost-sm" id="btn-reset-vq">그만하기</button>
          </div>
          <div class="fc-track"><div class="fc-track-fill" style="width:${pct}%"></div></div>

          <div class="quiz-prompt-box">${promptHtml}</div>

          <div class="quiz-options" id="vq-options">
            ${cur.options
              .map(
                (opt, i) => `
              <button type="button" class="quiz-opt" data-vq-opt="${i}">
                <span class="quiz-opt-num">${i + 1}</span>
                <span style="${quizState.mode === 'reading' ? 'font-family:var(--font-jp);font-size:1.1rem;' : ''}">${escHtml(opt.label)}</span>
              </button>
            `
              )
              .join('')}
          </div>
          <div id="vq-feedback"></div>
        </div>
      </div>
    `;
  }

  function handleVocabQuizAnswer(optIdx) {
    if (!quizState.active || quizState.answered) return;
    quizState.answered = true;

    const cur = quizState.questions[quizState.index];
    const picked = cur.options[optIdx];
    const t = cur.target;

    document.querySelectorAll('#vq-options .quiz-opt').forEach((btn, i) => {
      btn.disabled = true;
      if (cur.options[i].isCorrect) btn.classList.add('is-correct');
      else if (i === optIdx) btn.classList.add('is-wrong');
    });

    if (picked.isCorrect) {
      quizState.score++;
      quizState.streak++;
      if (quizState.streak > quizState.bestStreak) quizState.bestStreak = quizState.streak;
    } else {
      quizState.streak = 0;
      quizState.wrongs.push(t);
    }

    speakJa(t.r);

    const fb = document.getElementById('vq-feedback');
    if (fb) {
      fb.innerHTML = `
        <div class="quiz-feedback">
          <div>
            <div style="margin-bottom:0.2rem;">
              <strong style="color:${picked.isCorrect ? 'var(--ok)' : 'var(--err)'};">
                ${picked.isCorrect ? '정답입니다!' : '오답입니다'}
              </strong>
              <span style="font-family:var(--font-jp);margin-left:0.45rem;color:var(--ink-star);">${escHtml(t.w)}${t.w !== t.r ? ` (${escHtml(t.r)})` : ''}</span>
            </div>
            <div style="font-size:0.86rem;color:var(--ink-silver);">${escHtml(t.k)}</div>
          </div>
          <button type="button" class="btn-primary" id="btn-vq-next">
            ${quizState.index + 1 >= quizState.questions.length ? '결과 보기' : '다음 문제'}
          </button>
        </div>
      `;
    }
  }

  // =========================================================================
  // Progress Modal (내 별자리)
  // =========================================================================
  async function openProgressModal() {
    const backdrop = document.getElementById('progress-modal');
    const body = document.getElementById('progress-modal-body');
    if (!backdrop || !body) return;

    backdrop.classList.add('is-open');
    document.body.style.overflow = 'hidden';

    await ensureAllLevelsLoaded();

    const levelStatsHtml = LEVELS.map((lvl) => {
      const list = vocabStore.byLevel[lvl] || [];
      const done = list.reduce((acc, w) => acc + (progress.mastered.has(w.i) ? 1 : 0), 0);
      const pct = list.length ? Math.round((done / list.length) * 100) : 0;
      return `
        <div class="progress-lvl-item">
          <div class="progress-lvl-head">
            <span><strong style="color:${LEVEL_COLORS[lvl]};">${lvl}</strong></span>
            <span style="font-family:var(--font-mono);color:var(--ink-silver);">${done.toLocaleString()} / ${list.length.toLocaleString()} (${pct}%)</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width:${pct}%;background:${LEVEL_COLORS[lvl]};"></div>
          </div>
        </div>
      `;
    }).join('');

    const totalPct = ((progress.mastered.size / TOTAL_WORDS) * 100).toFixed(1);

    body.innerHTML = `
      <div class="modal-header">
        <div>
          <h2 style="font-family:var(--font-serif);font-size:1.3rem;">내 별자리 학습 현황</h2>
          <p style="font-size:0.82rem;color:var(--ink-mist);">브라우저에 자동 저장됩니다 (총 ${TOTAL_WORDS.toLocaleString()}단어)</p>
        </div>
        <button type="button" class="icon-btn" id="progress-close-btn" aria-label="닫기">${iconClose()}</button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:0.5rem;">
        <div class="modal-meaning-block" style="margin:0;text-align:center;">
          <div class="modal-label">암기 완료</div>
          <div style="font-family:var(--font-mono);font-size:1.5rem;color:var(--ok);font-weight:600;">${progress.mastered.size.toLocaleString()}</div>
          <div style="font-size:0.76rem;color:var(--ink-mist);">전체 ${totalPct}%</div>
        </div>
        <div class="modal-meaning-block" style="margin:0;text-align:center;">
          <div class="modal-label">별표 단어</div>
          <div style="font-family:var(--font-mono);font-size:1.5rem;color:var(--gold);font-weight:600;">${progress.bookmarks.size.toLocaleString()}</div>
          <button type="button" class="btn-ghost-sm" id="btn-jump-bookmarks" style="margin-top:0.35rem;">단어장에서 보기</button>
        </div>
      </div>

      <div class="progress-level-list">${levelStatsHtml}</div>

      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.6rem;padding-top:0.85rem;border-top:1px solid var(--border-hairline);">
        <button type="button" class="btn-secondary" id="btn-export-progress">학습 기록 내보내기 (JSON)</button>
        <button type="button" class="btn-ghost-sm" id="btn-reset-progress" style="color:var(--err);">기록 초기화</button>
      </div>
    `;
  }

  function closeProgressModal() {
    const backdrop = document.getElementById('progress-modal');
    if (backdrop) backdrop.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  // =========================================================================
  // Clean Inline SVG Icons
  // =========================================================================
  function iconSpeaker() {
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
  }

  function iconStar(filled) {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  }

  function iconCheck() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
  }

  function iconClose() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  }

  // =========================================================================
  // Event Binding
  // =========================================================================
  function bindEvents() {
    // Top Navigation Tabs
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Hero Constellation Quick Jumps
    document.querySelectorAll('.star-jump').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.jump;
        if (target === 'kana') {
          switchView('kana', { subtab: 'seion' });
        } else {
          switchView('vocab', { level: target });
        }
        const mainEl = document.getElementById('workspace-anchor');
        if (mainEl) mainEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    // Global Speech Speed Toggle
    const speedBtn = document.getElementById('btn-speed-toggle');
    if (speedBtn) {
      speedBtn.addEventListener('click', () => {
        speechState.rate = speechState.rate === 1.0 ? 0.75 : 1.0;
        speedBtn.textContent = `음성 ${speechState.rate.toFixed(speechState.rate === 1 ? 1 : 2)}x`;
        speedBtn.classList.toggle('is-active', speechState.rate !== 1.0);
        showToast(speechState.rate === 1.0 ? '음성 속도: 보통 (1.0x)' : '음성 속도: 천천히 (0.75x)');
      });
    }

    // Progress Modal Trigger
    const progBtn = document.getElementById('btn-open-progress');
    if (progBtn) progBtn.addEventListener('click', openProgressModal);

    // Kana Subtabs & Script Toggle
    document.getElementById('kana-subtabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-kana-tab]');
      if (!btn) return;
      kanaState.subtab = btn.dataset.kanaTab;
      kanaState.selected = null;
      renderKanaView();
    });

    document.getElementById('kana-script-switch')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-script]');
      if (!btn) return;
      kanaState.script = btn.dataset.script;
      renderKanaView();
    });

    // Kana Stage Delegated Clicks
    document.getElementById('kana-stage')?.addEventListener('click', (e) => {
      // Speak buttons inside inspector or rules
      const speakBtn = e.target.closest('[data-speak]');
      if (speakBtn) {
        const rate = speakBtn.dataset.rate ? parseFloat(speakBtn.dataset.rate) : undefined;
        speakJa(speakBtn.dataset.speak, rate);
        return;
      }

      // Kana tile click
      const tile = e.target.closest('.kana-tile');
      if (tile) {
        const h = tile.dataset.kanaH;
        const found = findKanaByH(h);
        if (found) {
          kanaState.selected = found;
          document.querySelectorAll('.kana-tile.is-selected').forEach((t) => t.classList.remove('is-selected'));
          tile.classList.add('is-selected', 'is-speaking');
          setTimeout(() => tile.classList.remove('is-speaking'), 180);
          const insp = document.getElementById('kana-inspector');
          if (insp) insp.innerHTML = renderKanaInspectorHtml(found);
          speakJa(found.h);
        }
        return;
      }

      // Kana Quiz controls
      const scopePill = e.target.closest('[data-kq-scope]');
      if (scopePill) {
        kanaState.quiz.scope = scopePill.dataset.kqScope;
        renderKanaView();
        return;
      }
      const modePill = e.target.closest('[data-kq-mode]');
      if (modePill) {
        kanaState.quiz.mode = modePill.dataset.kqMode;
        renderKanaView();
        return;
      }
      const cntPill = e.target.closest('[data-kq-count]');
      if (cntPill) {
        kanaState.quiz.count = parseInt(cntPill.dataset.kqCount, 10);
        renderKanaView();
        return;
      }
      if (e.target.closest('#btn-start-kana-quiz') || e.target.closest('#btn-retry-kana-quiz')) {
        startKanaQuiz();
        return;
      }
      if (e.target.closest('#btn-reset-kana-quiz')) {
        kanaState.quiz.active = false;
        renderKanaView();
        return;
      }
      const kqOpt = e.target.closest('[data-kq-opt]');
      if (kqOpt) {
        handleKanaQuizAnswer(parseInt(kqOpt.dataset.kqOpt, 10));
        return;
      }
      if (e.target.closest('#btn-kana-quiz-next')) {
        kanaState.quiz.index++;
        kanaState.quiz.answered = false;
        renderKanaView();
        const q = kanaState.quiz;
        if (q.mode === 'listen_to_char' && q.index < q.questions.length) {
          setTimeout(() => speakJa(q.questions[q.index].target.h), 180);
        }
      }
    });

    // Vocab Level Tabs
    document.getElementById('vocab-level-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.level-tab');
      if (!btn) return;
      vocabState.level = btn.dataset.level;
      vocabState.page = 1;
      syncVocabLevelButtons();
      renderVocabView();
    });

    // Vocab Search (debounced)
    const searchInput = document.getElementById('vocab-search');
    const clearBtn = document.getElementById('vocab-search-clear');
    let searchTimer = null;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        vocabState.query = searchInput.value;
        vocabState.page = 1;
        if (clearBtn) clearBtn.classList.toggle('is-visible', Boolean(vocabState.query));
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => renderVocabView(), 110);
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        vocabState.query = '';
        vocabState.page = 1;
        clearBtn.classList.remove('is-visible');
        renderVocabView();
        searchInput?.focus();
      });
    }

    // Vocab Filters & Toggles
    document.getElementById('vocab-pos-filter')?.addEventListener('change', (e) => {
      vocabState.pos = e.target.value;
      vocabState.page = 1;
      renderVocabView();
    });
    document.getElementById('vocab-status-filter')?.addEventListener('change', (e) => {
      vocabState.status = e.target.value;
      vocabState.page = 1;
      renderVocabView();
    });
    document.getElementById('vocab-sort')?.addEventListener('change', (e) => {
      vocabState.sort = e.target.value;
      if (vocabState.sort === 'random') vocabState.shuffledOrder = new Map();
      vocabState.page = 1;
      renderVocabView();
    });

    document.getElementById('btn-toggle-furigana')?.addEventListener('click', (e) => {
      vocabState.showFurigana = !vocabState.showFurigana;
      e.currentTarget.classList.toggle('is-active', vocabState.showFurigana);
      document.getElementById('vocab-grid')?.classList.toggle('hide-furigana', !vocabState.showFurigana);
    });

    document.getElementById('btn-toggle-blur')?.addEventListener('click', (e) => {
      vocabState.hideMeanings = !vocabState.hideMeanings;
      e.currentTarget.classList.toggle('is-active', vocabState.hideMeanings);
      document.getElementById('vocab-grid')?.classList.toggle('hide-meanings', vocabState.hideMeanings);
    });

    // Vocab Grid Delegated Clicks
    document.getElementById('vocab-grid')?.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.stopPropagation();
        const act = actionBtn.dataset.action;
        if (act === 'speak') {
          speakJa(actionBtn.dataset.speak);
        } else if (act === 'star') {
          const on = toggleBookmark(actionBtn.dataset.wordId);
          actionBtn.classList.toggle('is-starred', on);
          actionBtn.innerHTML = iconStar(on);
        } else if (act === 'master') {
          const on = toggleMastered(actionBtn.dataset.wordId);
          actionBtn.classList.toggle('is-mastered', on);
          actionBtn.closest('.word-card')?.classList.toggle('is-mastered', on);
        }
        return;
      }

      if (vocabState.hideMeanings) {
        const koEl = e.target.closest('.word-ko');
        if (koEl && !koEl.classList.contains('is-revealed')) {
          e.stopPropagation();
          koEl.classList.add('is-revealed');
          return;
        }
      }

      const card = e.target.closest('.word-card');
      if (card) {
        openWordModal(parseInt(card.dataset.wordIdx, 10));
      }
    });

    document.getElementById('vocab-grid')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('word-card')) {
        openWordModal(parseInt(e.target.dataset.wordIdx, 10));
      }
    });

    // Pagination Click & Page Jump
    document.getElementById('vocab-pagination')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-page]');
      if (!btn || btn.disabled) return;
      vocabState.page = parseInt(btn.dataset.page, 10);
      renderVocabView();
      document.getElementById('workspace-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    document.getElementById('vocab-pagination')?.addEventListener('submit', (e) => {
      if (e.target.id !== 'page-jump-form') return;
      e.preventDefault();
      const input = document.getElementById('page-jump-input');
      const p = parseInt(input?.value || '1', 10);
      if (!isNaN(p) && p >= 1) {
        vocabState.page = p;
        renderVocabView();
        document.getElementById('workspace-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    // Word Detail Modal Events
    const wordModal = document.getElementById('word-modal');
    wordModal?.addEventListener('click', (e) => {
      if (e.target === wordModal || e.target.closest('#modal-close-btn')) {
        closeWordModal();
        return;
      }
      const speakBtn = e.target.closest('[data-speak]');
      if (speakBtn) {
        const rate = speakBtn.dataset.rate ? parseFloat(speakBtn.dataset.rate) : undefined;
        speakJa(speakBtn.dataset.speak, rate);
        return;
      }
      const starBtn = e.target.closest('#modal-star-btn');
      if (starBtn) {
        const on = toggleBookmark(starBtn.dataset.wordId);
        starBtn.classList.toggle('is-starred', on);
        starBtn.innerHTML = iconStar(on);
        renderVocabView();
        return;
      }
      const masterBtn = e.target.closest('#modal-master-btn');
      if (masterBtn) {
        const on = toggleMastered(masterBtn.dataset.wordId);
        masterBtn.classList.toggle('is-mastered', on);
        renderVocabView();
        return;
      }
      if (e.target.closest('#modal-prev-btn') && modalState.index > 0) {
        openWordModal(modalState.index - 1);
        return;
      }
      if (e.target.closest('#modal-next-btn') && modalState.index < vocabState.filtered.length - 1) {
        openWordModal(modalState.index + 1);
      }
    });

    // Progress Modal Events
    const progModal = document.getElementById('progress-modal');
    progModal?.addEventListener('click', (e) => {
      if (e.target === progModal || e.target.closest('#progress-close-btn')) {
        closeProgressModal();
        return;
      }
      if (e.target.closest('#btn-jump-bookmarks')) {
        closeProgressModal();
        switchView('vocab', { level: 'ALL', status: 'BOOKMARKS' });
        return;
      }
      if (e.target.closest('#btn-export-progress')) {
        const data = JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            mastered: Array.from(progress.mastered),
            bookmarks: Array.from(progress.bookmarks)
          },
          null,
          2
        );
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'amanogawa-progress.json';
        a.click();
        URL.revokeObjectURL(url);
        showToast('학습 기록을 JSON 파일로 저장했습니다.');
        return;
      }
      if (e.target.closest('#btn-reset-progress')) {
        if (window.confirm('암기 완료 및 별표 저장 기록을 모두 초기화할까요?')) {
          progress.mastered.clear();
          progress.bookmarks.clear();
          saveProgress();
          openProgressModal();
          if (appState.view === 'vocab') renderVocabView();
          showToast('학습 기록이 초기화되었습니다.');
        }
      }
    });

    // Flashcards Controls & Stage
    document.getElementById('fc-scope')?.addEventListener('change', (e) => {
      fcState.scope = e.target.value;
      initFlashcardDeck();
    });
    document.getElementById('fc-count')?.addEventListener('change', (e) => {
      fcState.count = parseInt(e.target.value, 10);
      initFlashcardDeck();
    });
    document.getElementById('fc-dir')?.addEventListener('change', (e) => {
      fcState.dir = e.target.value;
      fcState.flipped = false;
      renderFlashcard();
    });
    document.getElementById('fc-auto-speak')?.addEventListener('click', (e) => {
      fcState.autoSpeak = !fcState.autoSpeak;
      e.currentTarget.classList.toggle('is-active', fcState.autoSpeak);
    });
    document.getElementById('fc-shuffle-btn')?.addEventListener('click', () => initFlashcardDeck());

    document.getElementById('flashcard-stage')?.addEventListener('click', (e) => {
      if (e.target.closest('#fc-restart-done')) {
        initFlashcardDeck();
        return;
      }
      const sp = e.target.closest('[data-fc-speak]');
      if (sp) {
        e.stopPropagation();
        speakJa(sp.dataset.fcSpeak);
        return;
      }
      const st = e.target.closest('[data-fc-star]');
      if (st) {
        e.stopPropagation();
        const on = toggleBookmark(st.dataset.fcStar);
        st.classList.toggle('is-starred', on);
        st.innerHTML = iconStar(on);
        return;
      }
      if (e.target.closest('#fc-hint-btn')) {
        e.stopPropagation();
        fcState.showReadingHint = true;
        renderFlashcard();
        return;
      }
      const gradeBtn = e.target.closest('[data-fc-grade]');
      if (gradeBtn) {
        gradeFlashcard(gradeBtn.dataset.fcGrade);
        return;
      }
      if (e.target.closest('#fc-card-el')) {
        fcState.flipped = !fcState.flipped;
        document.getElementById('fc-card-el')?.classList.toggle('is-flipped', fcState.flipped);
        if (fcState.flipped && fcState.autoSpeak && fcState.dir === 'ko_ja' && fcState.deck[0]) {
          speakJa(fcState.deck[0].r);
        }
      }
    });

    // Vocab Quiz Delegated Events
    document.getElementById('quiz-stage')?.addEventListener('click', (e) => {
      const sp = e.target.closest('[data-speak]');
      if (sp) {
        speakJa(sp.dataset.speak);
        return;
      }
      const sc = e.target.closest('[data-vq-scope]');
      if (sc) {
        quizState.scope = sc.dataset.vqScope;
        renderVocabQuiz();
        return;
      }
      const md = e.target.closest('[data-vq-mode]');
      if (md) {
        quizState.mode = md.dataset.vqMode;
        renderVocabQuiz();
        return;
      }
      const cn = e.target.closest('[data-vq-count]');
      if (cn) {
        quizState.count = parseInt(cn.dataset.vqCount, 10);
        renderVocabQuiz();
        return;
      }
      if (e.target.closest('#btn-start-vq') || e.target.closest('#btn-retry-vq')) {
        startVocabQuiz();
        return;
      }
      if (e.target.closest('#btn-reset-vq')) {
        quizState.active = false;
        renderVocabQuiz();
        return;
      }
      const opt = e.target.closest('[data-vq-opt]');
      if (opt) {
        handleVocabQuizAnswer(parseInt(opt.dataset.vqOpt, 10));
        return;
      }
      if (e.target.closest('#btn-vq-next')) {
        quizState.index++;
        quizState.answered = false;
        renderVocabQuiz();
        if (quizState.mode === 'listening' && quizState.index < quizState.questions.length) {
          setTimeout(() => speakJa(quizState.questions[quizState.index].target.r), 180);
        }
        return;
      }
      if (e.target.closest('#btn-star-all-wrongs')) {
        for (const w of quizState.wrongs) progress.bookmarks.add(w.i);
        saveProgress();
        showToast(`오답 ${quizState.wrongs.length}개를 별표 단어에 저장했습니다.`);
      }
    });

    // Global Keyboard Shortcuts
    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (e.key === 'Escape') {
        if (modalState.open) closeWordModal();
        closeProgressModal();
        return;
      }

      if (modalState.open) {
        if (e.key === 'ArrowLeft' && modalState.index > 0) {
          e.preventDefault();
          openWordModal(modalState.index - 1);
        } else if (e.key === 'ArrowRight' && modalState.index < vocabState.filtered.length - 1) {
          e.preventDefault();
          openWordModal(modalState.index + 1);
        } else if (e.key === ' ' && !inInput) {
          e.preventDefault();
          const cur = vocabState.filtered[modalState.index];
          if (cur) speakJa(cur.r);
        }
        return;
      }

      if (inInput) return;

      // Flashcards shortcuts
      if (appState.view === 'flashcards' && fcState.deck.length) {
        if (e.key === ' ') {
          e.preventDefault();
          fcState.flipped = !fcState.flipped;
          document.getElementById('fc-card-el')?.classList.toggle('is-flipped', fcState.flipped);
        } else if (e.key.toLowerCase() === 'a') {
          speakJa(fcState.deck[0].r);
        } else if (e.key === '1') {
          gradeFlashcard('again');
        } else if (e.key === '2') {
          gradeFlashcard('hard');
        } else if (e.key === '3') {
          gradeFlashcard('good');
        }
        return;
      }

      // Vocab Quiz shortcuts
      if (appState.view === 'quiz' && quizState.active && quizState.index < quizState.questions.length) {
        if (['1', '2', '3', '4'].includes(e.key) && !quizState.answered) {
          handleVocabQuizAnswer(parseInt(e.key, 10) - 1);
        } else if (e.key === 'Enter' && quizState.answered) {
          quizState.index++;
          quizState.answered = false;
          renderVocabQuiz();
          if (quizState.mode === 'listening' && quizState.index < quizState.questions.length) {
            setTimeout(() => speakJa(quizState.questions[quizState.index].target.r), 180);
          }
        } else if (e.key.toLowerCase() === 'r') {
          speakJa(quizState.questions[quizState.index].target.r);
        }
        return;
      }

      // Kana Quiz shortcuts
      if (appState.view === 'kana' && kanaState.subtab === 'quiz' && kanaState.quiz.active && kanaState.quiz.index < kanaState.quiz.questions.length) {
        if (['1', '2', '3', '4'].includes(e.key) && !kanaState.quiz.answered) {
          handleKanaQuizAnswer(parseInt(e.key, 10) - 1);
        } else if (e.key === 'Enter' && kanaState.quiz.answered) {
          kanaState.quiz.index++;
          kanaState.quiz.answered = false;
          renderKanaView();
        }
      }
    });
  }

  // =========================================================================
  // Initialization
  // =========================================================================
  function init() {
    loadProgress();
    updateHeaderProgress();
    bindEvents();
    renderKanaView();
    renderVocabQuiz();

    // Index N5 immediately if preloaded, and quietly preload remaining levels in background
    loadLevelData('N5').then(() => {
      const preloadRest = () => {
        ['N4', 'N3', 'N2', 'N1'].forEach((lvl) => loadLevelData(lvl).catch(() => {}));
      };
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(preloadRest, { timeout: 1500 });
      } else {
        setTimeout(preloadRest, 400);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
