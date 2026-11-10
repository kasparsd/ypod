# ypod

Listen to a YouTube video, playlist or channel as audio on your phone, with the screen off.

Paste a link, tap **Play**. It plays through a plain `<audio>` element with lock-screen controls, so playback keeps going when the screen locks (the YouTube embed stops).

- Videos, playlists and channels; `t=` start offsets are honoured
- Resumes where you left off
- Speed 1×–3× with natural pitch, back 15 s / forward 30 s
- Light and dark mode
- Fully static, no backend: `index.html`, `app.js`, `manifest.json`, `icon.svg`

## Use

Open [kasparsd.github.io/ypod](https://kasparsd.github.io/ypod/) on your iPhone, then Share (under the ··· menu on newer iOS) → **Add to Home Screen** for the most reliable background playback.

To host your own copy, fork this repo and enable GitHub Pages, or upload the four files in the repo root (`index.html`, `app.js`, `manifest.json`, `icon.svg`) to any static host. To run locally, serve the folder with any static server, e.g. `python3 -m http.server`.

## How it works, and its limits

Browsers can't call YouTube's player endpoints directly (no CORS), so ypod gets audio from free public [Invidious](https://invidious.io) servers. It discovers servers that allow browser access, remembers which are healthy, and fails over to the next one if a stream breaks.

- Public servers go offline often, and YouTube keeps blocking them. Today only one is usable. If playback fails, open Settings → **Check servers**, or add another server address.
- Using third-party servers to fetch YouTube audio may go against YouTube's terms of service. Use it for personal listening at your own risk.
- If the creator also publishes a podcast feed, a normal podcast app is the more reliable choice.

Not affiliated with or endorsed by YouTube or Google.

See [docs/PLAN.md](docs/PLAN.md) for the design notes and research.
