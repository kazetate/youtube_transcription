(() => {
  'use strict';

  const PANEL_ID = 'ytt-panel';
  const TS_KEY = 'ytt-show-timestamps';

  let segments = []; // { start: seconds, text }
  let tracks = [];
  let loadedVideoId = null;

  const videoId = () =>
    location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- transcript retrieval ----------

  async function tracksFromWatchPage(id) {
    const html = await (await fetch(`/watch?v=${id}`, { credentials: 'include' })).text();
    const m = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});\s*(?:var\s|<\/script>)/s);
    if (!m) return [];
    const pr = JSON.parse(m[1]);
    return pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  }

  async function tracksFromInnertube(id) {
    const res = await fetch('/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: id,
        context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'ja' } },
      }),
    });
    const pr = await res.json();
    return pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  }

  async function fetchTrack(track) {
    const url = new URL(track.baseUrl);
    url.searchParams.set('fmt', 'json3');
    const text = await (await fetch(url.toString())).text();
    if (!text) throw new Error('empty timedtext response');
    const data = JSON.parse(text);
    return (data.events || [])
      .filter((e) => e.segs)
      .map((e) => ({
        start: (e.tStartMs || 0) / 1000,
        text: e.segs.map((s) => s.utf8).join('').replace(/\s*\n\s*/g, ' ').trim(),
      }))
      .filter((s) => s.text);
  }

  // Fallback: open YouTube's own transcript panel and scrape it.
  const SEG_SEL = 'transcript-segment-view-model, ytd-transcript-segment-renderer';

  async function segmentsFromDom() {
    if (!document.querySelector(SEG_SEL)) {
      const btn = document.querySelector(
        'ytd-video-description-transcript-section-renderer button'
      ) || [...document.querySelectorAll('button')].find((b) =>
        /文字起こし|transcript/i.test(b.getAttribute('aria-label') || b.textContent)
      );
      if (!btn) return [];
      btn.click();
      for (let i = 0; i < 40 && !document.querySelector(SEG_SEL); i++) await sleep(200);
    }
    const found = [...document.querySelectorAll(SEG_SEL)]
      .map((el) => {
        const tsEl = el.querySelector('[class*="imestamp"]');
        const textEl =
          el.querySelector('span.yt-core-attributed-string') ||
          el.querySelector('.segment-text');
        return {
          ts: (tsEl?.textContent || '').trim(),
          text: (textEl?.textContent || '').replace(/\s+/g, ' ').trim(),
        };
      })
      .filter((s) => s.text);

    // Generic fallback: anchor on timestamp elements inside the transcript panel.
    if (!found.length) {
      const root =
        document.querySelector('ytd-engagement-panel-section-list-renderer[target-id*="transcript"]') ||
        document;
      const stamps = [...root.querySelectorAll('[class*="imestamp"]')].filter(
        (el) => !el.querySelector('[class*="imestamp"]') && /\d+:\d{2}/.test(el.textContent)
      );
      for (const el of stamps) {
        const tsText = el.textContent.trim();
        let seg = el.parentElement;
        while (seg && seg.textContent.trim().length <= tsText.length) seg = seg.parentElement;
        if (!seg) continue;
        const text = seg.textContent
          .replace(tsText, '')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/^(?:\d+\s*時間\s*)?(?:\d+\s*分\s*)?\d+\s*秒\s*/, '')
          .replace(/^(?:\d+\s*hours?,?\s*)?(?:\d+\s*minutes?,?\s*)?\d+\s*seconds?\s*/i, '');
        if (text) found.push({ ts: tsText, text });
      }
      console.log('[ytt] generic scrape:', stamps.length, 'timestamps,', found.length, 'segments');
    }

    return found.map(({ ts, text }) => {
      const m = ts.match(/\d+(?::\d+)+/);
      const start = m ? m[0].split(':').map(Number).reduce((a, n) => a * 60 + n, 0) : 0;
      return { start, text };
    });
  }

  async function load(trackIndex) {
    const id = videoId();
    if (!id) throw new Error('動画ページではありません');

    if (trackIndex == null || id !== loadedVideoId) {
      tracks = [];
      for (const getTracks of [tracksFromWatchPage, tracksFromInnertube]) {
        try {
          tracks = await getTracks(id);
        } catch (_) {
          tracks = [];
        }
        if (tracks.length) break;
      }
      loadedVideoId = id;
      trackIndex = Math.max(0, tracks.findIndex((t) => t.languageCode?.startsWith('ja')));
      populateTrackSelect(trackIndex);
    }

    let result = [];
    if (tracks[trackIndex]) {
      try {
        result = await fetchTrack(tracks[trackIndex]);
      } catch (_) {
        result = [];
      }
    }
    if (!result.length) result = await segmentsFromDom();
    if (!result.length) throw new Error('字幕が見つかりませんでした（字幕のない動画の可能性があります）');
    return result;
  }

  // ---------- formatting ----------

  function fmtTime(sec) {
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  function render() {
    const withTs = panel().querySelector('#ytt-ts').checked;
    return segments
      .map((s) => (withTs ? `[${fmtTime(s.start)}] ${s.text}` : s.text))
      .join('\n');
  }

  // ---------- UI ----------

  function panel() {
    return document.getElementById(PANEL_ID);
  }

  function setStatus(msg) {
    const el = document.getElementById('ytt-status');
    if (el) el.textContent = msg;
  }

  function refreshText() {
    const ta = document.getElementById('ytt-text');
    const has = segments.length > 0;
    ta.style.display = has ? 'block' : 'none';
    ta.value = has ? render() : '';
    panel().querySelector('#ytt-copy').disabled = !has;
    panel().querySelector('#ytt-dl').disabled = !has;
  }

  function populateTrackSelect(selected) {
    const sel = document.getElementById('ytt-track');
    if (!sel) return;
    sel.innerHTML = '';
    tracks.forEach((t, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = t.name?.simpleText || t.languageCode || `track ${i + 1}`;
      sel.appendChild(o);
    });
    sel.value = String(selected);
    sel.style.display = tracks.length > 1 ? '' : 'none';
  }

  async function onFetch(trackIndex) {
    const btn = document.getElementById('ytt-fetch');
    btn.disabled = true;
    setStatus('取得中…');
    try {
      segments = await load(trackIndex);
      setStatus(`${segments.length} 行の字幕を取得しました`);
    } catch (e) {
      segments = [];
      setStatus(`エラー: ${e.message}`);
    } finally {
      btn.disabled = false;
      refreshText();
    }
  }

  async function onCopy() {
    const text = render();
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.getElementById('ytt-text');
      ta.select();
      document.execCommand('copy');
    }
    setStatus('クリップボードにコピーしました');
  }

  function videoTitle() {
    return (
      document.querySelector('h1.ytd-watch-metadata, #title h1')?.textContent.trim() ||
      document.title.replace(/ - YouTube$/, '') ||
      videoId()
    );
  }

  function onDownload() {
    const title = videoTitle();
    const url = `https://www.youtube.com/watch?v=${videoId()}`;
    const name = title.replace(/[\/:*?"<>|]/g, '_').slice(0, 100) + '.txt';
    const blob = new Blob([`${title}
${url}

${render()}`], {
      type: 'text/plain;charset=utf-8',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setStatus(`${name} を保存しました`);
  }

  function buildPanel() {
    const el = document.createElement('div');
    el.id = PANEL_ID;
    el.innerHTML = `
      <div class="ytt-row">
        <span class="ytt-title">字幕ツール</span>
        <button id="ytt-fetch">字幕を取得</button>
        <select id="ytt-track" style="display:none"></select>
        <button id="ytt-copy" disabled>コピー</button>
        <button id="ytt-dl" disabled>テキストでDL</button>
        <label><input type="checkbox" id="ytt-ts"> タイムスタンプ</label>
      </div>
      <div id="ytt-status"></div>
      <div class="ytt-ver">v${chrome.runtime.getManifest().version}</div>
      <textarea id="ytt-text" readonly></textarea>`;

    const ts = el.querySelector('#ytt-ts');
    try {
      ts.checked = localStorage.getItem(TS_KEY) === '1';
    } catch (_) {}

    el.querySelector('#ytt-fetch').addEventListener('click', () => onFetch(null));
    el.querySelector('#ytt-track').addEventListener('change', (e) =>
      onFetch(Number(e.target.value))
    );
    el.querySelector('#ytt-copy').addEventListener('click', onCopy);
    el.querySelector('#ytt-dl').addEventListener('click', onDownload);
    ts.addEventListener('change', () => {
      try {
        localStorage.setItem(TS_KEY, ts.checked ? '1' : '0');
      } catch (_) {}
      refreshText();
    });
    return el;
  }

  function mount() {
    if (!videoId()) {
      panel()?.remove();
      return;
    }
    const side = document.querySelector('#secondary-inner') || document.querySelector('#secondary');
    if (!side) return;
    if (panel() && panel().parentElement === side && side.firstElementChild === panel()) return;
    const fresh = !panel();
    const el = panel() || buildPanel();
    side.prepend(el);
    if (!fresh) return;
    segments = [];
    loadedVideoId = null;
  }

  // YouTube is a SPA: re-mount on navigation and when the DOM is rebuilt.
  document.addEventListener('yt-navigate-finish', mount);
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(mount, 300);
  }).observe(document.body, { childList: true, subtree: true });
  mount();
})();
