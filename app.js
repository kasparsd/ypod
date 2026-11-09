'use strict';
const $ = (id) => document.getElementById(id);
const audio = $('audio');
const DEFAULT_SERVERS = ['https://yt.chocolatemoo53.com'];
const RATES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ---------- URL parsing ---------- */
function parseInput(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1);
  else if (host === 'youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else if (/^\/(shorts|live|embed)\//.test(u.pathname)) id = u.pathname.split('/')[2];
  } else return null;
  const list = u.searchParams.get('list');
  const t = parseInt((u.searchParams.get('t') || u.searchParams.get('start') || '0').replace(/s$/, ''), 10) || 0;
  if (u.pathname === '/playlist' && list) return { kind: 'playlist', list };
  const ch = u.pathname.match(/^\/(@[\w.-]+|channel\/UC[\w-]+)/);
  if (ch) return { kind: 'channel', channel: ch[1] };
  if (id) return { kind: list ? 'video+list' : 'video', id, list, t };
  return null;
}

/* ---------- Errors: friendly copy, technical detail kept aside ---------- */
class AppError extends Error { constructor(code, detail) { super(detail || code); this.code = code; } }
const MESSAGES = {
  badlink: "That doesn't look like a YouTube link. Paste a video, playlist or channel link.",
  offline: "You're offline. Connect to the internet and try again.",
  server: "Can't reach the audio server. It may be down or busy. Try again, or change the audio server.",
  allservers: 'None of your audio servers responded. Free public servers go offline often. Add another one.',
  noaudio: 'This video has no audio your iPhone can play. Try another one.',
  nochannel: "Couldn't find that channel. Check the link.",
  empty: 'That playlist or channel has nothing to play.',
  tap: 'Tap the play button to start.',
  generic: 'Something went wrong. Try again.',
};
let lastAction = null;
function showError(e) {
  const code = e instanceof AppError ? e.code
    : e && e.name === 'NotAllowedError' ? 'tap'
    : !navigator.onLine ? 'offline' : 'generic';
  setStatus('');
  $('errMsg').textContent = MESSAGES[code] || MESSAGES.generic;
  $('errDetail').textContent = (e && e.message) || '';
  $('errSettings').hidden = !['server', 'allservers'].includes(code);
  $('retry').hidden = code === 'badlink';
  $('error').hidden = false;
}
const clearError = () => { $('error').hidden = true; };
function setStatus(m) { $('status').textContent = m; }

/* ---------- Audio sources ----------
   resolve(id)  -> { title, author, thumb, audioUrl }
   list(parsed) -> [{ id, title }]                                           */
const userServers = () => store.get('instances', DEFAULT_SERVERS).map(x => String(x).trim().replace(/\/$/, '')).filter(Boolean);
const HOUR = 3600e3, BAD_FOR = 10 * 60e3, POOL_TTL = 6 * HOUR;
const norm = (u) => String(u).trim().replace(/\/$/, '');

/* Public pool: user's servers first, then servers discovered from the Invidious directory, then defaults.
   Health is remembered: a server that failed in the last 10 minutes is skipped unless nothing else is left. */
async function discoverServers(force = false) {
  const c = store.get('pool', null);
  if (!force && c && Date.now() - c.ts < POOL_TTL) return c.list;
  try {
    const r = await fetch('https://api.invidious.io/instances.json', { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    const list = d.filter(([, i]) => i && i.api && i.cors && i.type === 'https').map(([h]) => 'https://' + h);
    store.set('pool', { ts: Date.now(), list });
    return list;
  } catch { return c ? c.list : []; }
}
const bad = () => { const b = store.get('bad', {}); const now = Date.now(); for (const k in b) if (now - b[k] > BAD_FOR) delete b[k]; return b; };
const markBad = (base) => { const b = bad(); b[norm(base)] = Date.now(); store.set('bad', b); };
const markGood = (base) => { const b = bad(); delete b[norm(base)]; store.set('bad', b); store.set('good', norm(base)); };
async function serverOrder(exclude = []) {
  const all = [...new Set([...userServers(), ...(await discoverServers()), ...DEFAULT_SERVERS].map(norm))];
  const b = bad(), good = store.get('good', null), ex = exclude.map(norm);
  const ok0 = all.filter(x => !ex.includes(x)), ok = ok0.length ? ok0 : all;
  const healthy = ok.filter(x => !b[x]).sort((a, c) => (c === good) - (a === good));
  return healthy.length ? healthy : ok; // everything looked bad: try anyway
}
async function checkServers() {
  const all = [...new Set([...userServers(), ...(await discoverServers(true)), ...DEFAULT_SERVERS].map(norm))];
  return Promise.all(all.map(async (base) => {
    try {
      const r = await fetch(base + '/api/v1/stats', { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      markGood(base); return { base, ok: true };
    } catch (e) { markBad(base); return { base, ok: false, why: e.message }; }
  }));
}
const resolvers = {
  public: {
    label: 'Public audio servers (client-only)',
    async api(path, exclude = []) {
      const order = await serverOrder(exclude);
      if (!order.length) throw new AppError('allservers', 'No servers left to try');
      let last;
      for (const base of order) {
        try {
          const r = await fetch(base + '/api/v1' + path, { signal: AbortSignal.timeout(12000) });
          if (!r.ok) throw new Error(base + ' HTTP ' + r.status);
          const j = await r.json();
          if (j.error) throw new Error(j.error);
          markGood(base);
          return { j, base };
        } catch (e) { markBad(base); last = e; }
      }
      throw new AppError(order.length > 1 ? 'allservers' : 'server', last && last.message);
    },
    async resolve(id, exclude = []) {
      const { j, base } = await this.api('/videos/' + encodeURIComponent(id) + '?local=true', exclude);
      // iOS plays AAC in MP4, not WebM/Opus: prefer itag 140, else any audio/mp4
      const af = (j.adaptiveFormats || []).filter(f => (f.type || '').startsWith('audio/mp4'));
      const f = af.find(x => String(x.itag) === '140') || af.sort((a, b) => b.bitrate - a.bitrate)[0];
      if (!f) throw new AppError('noaudio');
      const th = (j.videoThumbnails || [])[0];
      return { title: j.title, author: j.author, thumb: th && th.url, audioUrl: f.url, server: base };
    },
    async list(p) {
      let pl = p.list;
      if (!pl && p.kind === 'channel') {
        let cid;
        try {
          const { j } = await this.api('/resolveurl?url=' + encodeURIComponent('https://www.youtube.com/' + p.channel));
          cid = j.ucid || j.browseId;
        } catch (e) { if (e.code === 'server') throw new AppError('nochannel', e.message); throw e; }
        if (!cid) throw new AppError('nochannel');
        const { j: c } = await this.api('/channels/' + cid + '/videos');
        return (c.videos || c).map(v => ({ id: v.videoId, title: v.title }));
      }
      const { j } = await this.api('/playlists/' + encodeURIComponent(pl));
      return (j.videos || []).map(v => ({ id: v.videoId, title: v.title }));
    },
  },
};
const resolver = () => resolvers.public;

/* ---------- Helpers ---------- */
const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const ICON_PLAY = '<svg class="icon fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg class="icon fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA=';
// iOS: start the element inside the tap so later src swaps (after async fetches) may play
const unlock = () => { audio.src = SILENT; audio.play().catch(() => {}); };

/* ---------- Player ---------- */
let queue = [], idx = -1, sourceUrl = '', playToken = 0, retriedExpired = 0, failedServers = [], currentServer = null;

function renderQueue() {
  const ol = $('queue'); ol.textContent = '';
  queue.forEach((q, i) => {
    const li = document.createElement('li');
    if (i === idx) li.setAttribute('aria-current', 'true');
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = q.title || q.id;
    b.onclick = () => { unlock(); play(i); };
    li.append(b); ol.append(li);
  });
  $('up').hidden = queue.length < 2;
  $('upLabel').textContent = queue.length > 1 ? `Up next · ${idx + 1} of ${queue.length}` : 'Up next';
  const cur = ol.querySelector('[aria-current]'); if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function showPlayer() {
  $('dock').hidden = false; $('empty').hidden = true; $('resume').hidden = true;
  document.body.style.setProperty('--dock', $('dock').offsetHeight + 'px');
}

function saveSession() {
  if (idx < 0 || !queue[idx]) return;
  store.set('pos:' + queue[idx].id, audio.currentTime);
  store.set('session', { url: sourceUrl, queue, idx, savedAt: Date.now(), dur: isFinite(audio.duration) ? audio.duration : 0 });
}

async function play(i, startAt = 0, fromError = false) {
  if (i < 0 || i >= queue.length) { if (i >= queue.length) setStatus('Finished. Nothing more in the queue.'); return; }
  const token = ++playToken;
  if (!fromError) failedServers = [];
  idx = i; renderQueue(); clearError();
  const r = resolver();
  const item = queue[i];
  showPlayer();
  $('title').textContent = item.title || item.id; $('author').textContent = '';
  const start = startAt || (fromError ? 0 : store.get('pos:' + item.id, 0));
  if (!startAt && !fromError && start > 5) setStatus(`Resumed at ${fmt(start)}`);
  else setStatus('Loading…');
  $('go').disabled = true;
  const begin = async (url) => {
    audio.src = url;
    // ignore stale events from the silent unlock clip: only seek once the real source has loaded
    const onMeta = () => {
      if (audio.currentSrc !== new URL(url, location.href).href) return;
      audio.removeEventListener('loadedmetadata', onMeta);
      if (start) audio.currentTime = start;
    };
    audio.addEventListener('loadedmetadata', onMeta);
    await audio.play();
  };
  const apply = (m) => {
    if (token !== playToken) return;
    item.title = m.title; $('title').textContent = m.title; $('author').textContent = m.author;
    currentServer = m.server || null;
    renderQueue(); setMediaSession(m);
  };
  try {
    const m = await r.resolve(item.id, failedServers);
    if (token !== playToken) return;
    apply(m); await begin(m.audioUrl);
    if (token === playToken && !/^Resumed/.test($('status').textContent)) setStatus('');
  } catch (e) {
    if (token === playToken) { lastAction = () => { unlock(); play(i, start, true); }; showError(e); }
  } finally { if (token === playToken) $('go').disabled = false; }
}

function setMediaSession(m) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: m.title, artist: m.author, artwork: m.thumb ? [{ src: m.thumb }] : [],
  });
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
  h('play', () => audio.play()); h('pause', () => audio.pause());
  h('seekbackward', () => skip(-15)); h('seekforward', () => skip(30));
  h('seekto', (d) => { audio.currentTime = d.seekTime; });
  h('previoustrack', () => play(idx - 1)); h('nexttrack', () => play(idx + 1));
}
function updatePosition() {
  if ('mediaSession' in navigator && isFinite(audio.duration) && audio.duration > 0) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch {}
  }
}

const skip = (d) => { audio.currentTime = Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + d)); };

/* ---------- Transport UI ---------- */
let dragging = false, lastSave = 0;
const setToggle = () => {
  const playing = !audio.paused && audio.src && !audio.src.startsWith('data:');
  $('toggle').innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  $('toggle').setAttribute('aria-label', playing ? 'Pause' : 'Play');
};
function paint() {
  const d = audio.duration, t = audio.currentTime;
  if (isFinite(d) && d > 0) { $('scrub').max = Math.floor(d); }
  if (!dragging) $('scrub').value = Math.floor(t);
  $('elapsed').textContent = fmt(dragging ? $('scrub').value : t);
  $('remaining').textContent = isFinite(d) ? '−' + fmt(d - (dragging ? $('scrub').value : t)) : '';
}
audio.addEventListener('timeupdate', () => {
  paint();
  if (!audio.src.startsWith('data:') && Date.now() - lastSave > 5000) { lastSave = Date.now(); saveSession(); }
});
['play', 'pause', 'playing', 'emptied'].forEach(ev => audio.addEventListener(ev, setToggle));
audio.addEventListener('pause', () => { if (!audio.src.startsWith('data:')) saveSession(); });
audio.addEventListener('loadedmetadata', () => { paint(); updatePosition(); });
audio.addEventListener('ratechange', updatePosition);
audio.addEventListener('seeked', updatePosition);
audio.addEventListener('waiting', () => { if (!audio.src.startsWith('data:')) setStatus('Buffering…'); });
audio.addEventListener('playing', () => { if (/^(Buffering|Loading|Reconnecting)/.test($('status').textContent)) setStatus(''); });
audio.addEventListener('ended', () => { store.set('pos:' + (queue[idx] || {}).id, 0); play(idx + 1); });
audio.addEventListener('error', async () => {
  if (audio.src.startsWith('data:') || !queue[idx]) return;
  // stream failed or its signed URL expired: try again via the next healthy server, resuming in place
  if (currentServer) { markBad(currentServer); failedServers.push(currentServer); }
  if (retriedExpired++ < 3) { setStatus('Reconnecting…'); play(idx, audio.currentTime || 0, true); }
  else showError(new AppError('allservers', 'media error ' + (audio.error && audio.error.code)));
});
audio.addEventListener('playing', () => { retriedExpired = 0; });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveSession(); });

$('toggle').onclick = () => { audio.paused ? audio.play().catch(showError) : audio.pause(); };
$('back').onclick = () => skip(-15);
$('fwd').onclick = () => skip(30);
$('prev').onclick = () => { if (audio.currentTime > 5) audio.currentTime = 0; else play(idx - 1); };
$('next').onclick = () => play(idx + 1);
$('scrub').addEventListener('input', () => { dragging = true; paint(); });
$('scrub').addEventListener('change', () => { audio.currentTime = Number($('scrub').value); dragging = false; paint(); });

audio.preservesPitch = true; audio.webkitPreservesPitch = true;
let rate = RATES.includes(store.get('rate', 1)) ? store.get('rate', 1) : 1;
function applyRate() {
  audio.playbackRate = rate; store.set('rate', rate);
  $('rate').textContent = rate + '×';
  $('rate').setAttribute('aria-label', `Playback speed ${rate}×. Tap to change.`);
}
$('rate').onclick = () => { rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length]; applyRate(); };
audio.addEventListener('loadedmetadata', applyRate); // a new src can reset the rate
applyRate();

/* ---------- Input ---------- */
async function load() {
  clearError();
  const raw = $('url').value.trim();
  const p = parseInput(raw);
  if (!p) return showError(new AppError('badlink'));
  if (!navigator.onLine) return showError(new AppError('offline'));
  store.set('last', raw);
  sourceUrl = raw;
  const r = resolver();
  $('go').disabled = true; setStatus('Loading…');
  try {
    if (p.kind === 'video') queue = [{ id: p.id, title: '' }];
    else {
      queue = await r.list({ ...p, url: raw });
      if (!queue.length) throw new AppError('empty');
      if (p.kind === 'video+list') { const k = queue.findIndex(q => q.id === p.id); if (k > 0) queue = queue.slice(k); }
    }
    retriedExpired = 0;
    await play(0, p.t || 0);
  } catch (e) { lastAction = load; showError(e); $('go').disabled = false; }
}
$('form').addEventListener('submit', (e) => { e.preventDefault(); unlock(); lastAction = load; load(); });
$('retry').onclick = () => { unlock(); (lastAction || load)(); };
$('url').addEventListener('focus', (e) => e.target.select());

if (navigator.clipboard && navigator.clipboard.readText) {
  $('paste').onclick = async () => {
    try { $('url').value = (await navigator.clipboard.readText()).trim(); $('url').focus(); }
    catch { $('url').focus(); setStatus('Long-press the box and choose Paste.'); }
  };
} else $('paste').hidden = true;

/* ---------- Resume ---------- */
function showResume() {
  const s = store.get('session', null);
  if (!s || !s.queue || !s.queue[s.idx]) return;
  const it = s.queue[s.idx], pos = store.get('pos:' + it.id, 0);
  if (!it.title) return;
  $('resumeTitle').textContent = it.title;
  $('resumeLeft').textContent = s.dur ? `${fmt(s.dur - pos)} left` : `at ${fmt(pos)}`;
  $('resume').hidden = false; $('empty').hidden = true;
  $('resumeBtn').onclick = () => {
    unlock(); queue = s.queue; sourceUrl = s.url; $('url').value = s.url || '';
    retriedExpired = 0; play(s.idx);
  };
}

/* ---------- Settings ---------- */
const dlg = $('settings');
function openSettings() {
  $('servers').value = userServers().join('\n');
  dlg.showModal ? dlg.showModal() : dlg.setAttribute('open', '');
  $('sTitle').focus(); // don't pop the keyboard open
}
$('openSettings').onclick = openSettings;
$('errSettings').onclick = openSettings;
dlg.addEventListener('close', () => {
  const list = $('servers').value.split('\n').map(x => x.trim()).filter(Boolean);
  const bad = list.filter(x => { try { return !/^https?:$/.test(new URL(x).protocol); } catch { return true; } });
  store.set('instances', bad.length ? userServers() : list);
  if (bad.length) setStatus('Ignored invalid server address: ' + bad[0]);
});
$('checkServers').onclick = async () => {
  const btn = $('checkServers'), ul = $('serverList');
  btn.disabled = true; btn.textContent = 'Checking…'; ul.textContent = '';
  const res = await checkServers();
  res.sort((a, b) => b.ok - a.ok).forEach(r => {
    const li = document.createElement('li'); li.className = r.ok ? 'ok' : 'no';
    li.textContent = r.base.replace(/^https:\/\//, '') + (r.ok ? ' — working' : ' — not responding');
    ul.append(li);
  });
  const n = res.filter(r => r.ok).length;
  const sum = document.createElement('li'); sum.className = 'why'; sum.style.listStyle = 'none';
  sum.textContent = n ? `${n} of ${res.length} working` : 'None are responding right now. Try again later or add another server.';
  ul.prepend(sum);
  btn.disabled = false; btn.textContent = 'Check servers';
};
$('resetServers').onclick = () => { $('servers').value = DEFAULT_SERVERS.join('\n'); };

/* ---------- Startup ---------- */
$('url').value = store.get('last', '');
showResume();
const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
if (ios && !standalone && !store.get('a2hsDismissed', false)) $('a2hs').hidden = false;
$('a2hsClose').onclick = () => { $('a2hs').hidden = true; store.set('a2hsDismissed', true); };
setToggle();
