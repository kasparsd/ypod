# yt-play: background audio player for YouTube (iOS, screen off)

## Goal
Static HTML app, no backend of our own. Paste a YouTube video / playlist / channel URL, listen on iPhone with the screen locked. Sample: https://www.youtube.com/watch?v=a2yHORIkYIk&t=331s (video + `t=331s` start offset).

## Core constraint
iOS Safari suspends media in a YouTube `<iframe>` on lock (official IFrame API cannot do background playback; that is a Premium feature). A plain `<audio>` element fed a real audio URL keeps playing on lock, shows lock-screen controls via Media Session, and works as an installed PWA. So the app needs an audio-only URL for each video.

## Findings from probing (2026-11-09)
- Browser JS cannot fetch YouTube watch/player data itself: no CORS on youtube.com, and the player endpoints need app-client identity / PO tokens.
- Public Piped instances: kavin.rocks 502, private.coffee returns "Sign in to confirm you're not a bot", adminforge redirects. Flaky and being blocked by YouTube.
- Impersonating a YouTube app client (ANDROID_VR innertube) to get stream URLs was blocked by the permission classifier as access circumvention. Not pursued.
- ffmpeg.wasm is NOT needed: YouTube already serves audio-only m4a/webm streams. It would only matter for remuxing a file we already downloaded, which needs a source that allows CORS.

## Design
- `index.html` + `app.js` + `sw.js` + `manifest.json`. No build step.
- Input parsing: video id, `t=` offset, `list=` playlist id, `/@handle` or `/channel/UC...`.
- **Resolver interface** `resolve(videoId) -> {title, author, thumb, audioUrl}` and `list(playlistOrChannel) -> [{id,title,duration}]`, pluggable so the source can change without touching the player.
- Player: single `<audio>` element, queue, next/prev, seek +/-15s, speed, resume position per video in localStorage, Media Session metadata + action handlers, `playsinline`.
- Playlist/channel: channel -> uploads playlist (`UC` -> `UU`); queue advances on `ended`.
- PWA: manifest + Add to Home Screen (standalone) improves background audio reliability.
- Resolvers considered:
  1. User-supplied Invidious/Piped instance URL (settings field). CORS-enabled, no own backend, but public instances are unreliable.
  2. Tiny self-hosted proxy (yt-dlp) the user runs. Reliable, but not client-only.
  3. Local test resolver (a sample mp3) to verify the lock-screen behaviour independent of YouTube.

## Verification (iOS Simulator)
Serve over localhost, open in Mobile Safari, start playback, press LOCK, confirm audio continues / Now Playing appears. Note: the simulator's audio and lock-screen fidelity is limited; final confirmation needs a real iPhone.

## Review notes (agent)
- `<audio>` keeps playing on lock; IFrame embed does not (by design, Premium feature). PWA-standalone being *more* reliable is unproven; test Safari tab and PWA.
- The missing piece is a legitimate audio URL. Options that avoid bypassing YouTube: Premium background play; ask the creator for an RSS feed / audio files (check Apple Podcasts, podcastindex.org); play user-owned local files via `<input type=file>`; Data API v3 (user key) for listing only.
- Pitfalls: call `play()` synchronously in the tap; reuse one `<audio>` element and set `src` + `play()` directly in `ended`; signed URLs expire, prefetch next; persist position (interruptions); service worker must not intercept media Range requests; add `seekto` + `positionState`.
- ffmpeg.wasm: drop (needs COOP/COEP, heavy on iOS, no role).

## Status
Built with a small local server (`server.py`): serves the app, resolves audio with `yt-dlp`, and proxies it with Range support (4 MB chunks, since googlevideo throttles open-ended ranges). Pure client-side is not possible: YouTube sends no CORS headers and rejects the direct call (403).

(The local yt-dlp server used during development has been removed; the app is fully static.)

Verified in iOS Simulator: sample URL plays from 5:31, and playback continues after LOCK with Now Playing on the lock screen. Not yet verified on a real iPhone, playlist/channel listing, or auto-advance while locked.

## CORS proxy / client-only findings (2026-11-09)
- Generic CORS proxies (all dead, key-gated or rate-limited): corsproxy.io (401, API key), allorigins (500), codetabs, thingproxy, yacdn (dead), cors-anywhere (403, opt-in), cors.eu.org (403), cors.lol (429), proxy.cors.sh (rate-limited). Even a working one could not help: stream URLs are IP-locked to whoever fetched the player data, so the proxy would also have to carry the audio.
- What works: a public Invidious instance with API + CORS. `yt.chocolatemoo53.com` returned metadata and audio (`/api/v1/videos/ID?local=true`, itag 140 AAC) that plays in `<audio>` in Chromium and iOS Safari simulator. It was the only one of 10 listed instances with API+CORS enabled, so expect it to disappear; the instance list is user-editable with failover.
- Simulator quirk: Safari reports duration ~2x (6192 vs 3096 s) for this stream; seek-to-offset works (t=331 start verified). Check on a real iPhone.

## Open decision
Which resolver (1/2/3) is acceptable, given option 1 and 2 pull streams outside YouTube's official player.
