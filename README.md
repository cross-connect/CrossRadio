# 🎵 Radio Player HTML5 — Single or Multi-Station, 3 Layouts, PWA

[![Live Demo](https://img.shields.io/badge/▶_Live_Demo-online-brightgreen)](https://jailsonsb2.github.io/Radioplayer_api/)
[![No API Key](https://img.shields.io/badge/API_key-not_required-orange)](#)
[![PWA Ready](https://img.shields.io/badge/PWA-installable-5A0FC8)](#)

**[▶ Try the live demo](https://jailsonsb2.github.io/Radioplayer_api/)** — a modern **HTML5 radio player** for Icecast / Shoutcast / Zeno.FM / Azuracast (and any stream with metadata), with real-time "now playing" info, song history, album art, lyrics, **YouTube clip mode**, weekly program schedule, TV modal and Progressive Web App support.

> 🇧🇷 **Player de rádio para o seu site com 3 visuais prontos** (Retrô Glass, Clássico e Aurora Deck) — grátis e sem chave de API. Multi-estação, música tocando agora com capa, letra, clipe do YouTube sincronizado, programação semanal e app instalável. Escolha o layout num único arquivo de configuração.

It ships with **three ready-to-use layouts ("versions")** sharing the same engine — you pick the one you want in a single config file.

## Demo Screenshots

![Demo Screenshot](https://i.imgur.com/oULEMgZ.jpeg)

## Layouts / Versions

| id | File | Description |
|---|---|---|
| `retro` | `index-redesign.html` | **Retrô Glass** — new redesign: frosted glass, dynamic accent color extracted from the album art |
| `classic` | `index-classic.html` | **Clássico** — the original player look |
| `aurora` | `index-alt.html` | **Aurora Deck** — alternative deck-style UI |

All three read the same `config.js` and the same `js/main.js`, so switching layout never means reconfiguring your stations.

### How to choose your version

Everything is set in **`config.js`**:

```javascript
window.streams = {
    layout: "retro",        // "retro" | "classic" | "aurora"
    timeRefresh: 10000,
    stations: [ /* ... */ ],
};
```

* **`layout`** — which design `index.html` loads. The aliases `classico`, `redesign` and `alt` are also accepted.
* **Direct file:** you can also deploy/open `index-redesign.html`, `index-classic.html` or `index-alt.html` directly — each one works standalone.

## Features

* Current song, artist and album art, updated in real time (free metadata API included — no key required).
* Song history with cover art.
* Song lyrics via [lyrics.ovh](https://lyrics.ovh) with [LRCLIB](https://lrclib.net) fallback — no API key needed.
* Weekly program schedule (`programSchedule`) with an automatic "on air now" indicator, plus a full schedule panel.
* Dynamic accent color extracted from the current album art (Color Thief).
* Live TV / video stream modal (`tv_url`), with the radio correctly paused while TV plays.
* Media Session integration (lock-screen / notification controls with artwork).
* Multiple stations in one player, with a station list and next/previous switching.
* Audio visualizer, social links, app download links.
* Responsive design + installable PWA.
* Visual config generator: open **`gerador.html`** in your browser, fill in your stations and copy the ready-made `config.js`.
* 🎬 **Clip mode** — watch the music video of the song that is playing, synchronized with the radio (see below).

## 🎬 Clip Mode (music video of the current song)

When the metadata API returns a **`youtubeId`** field in the now-playing payload, a floating **"Clipe"** button automatically appears (feature-detected — if your API doesn't send the field, the button never shows). With clip mode on:

* a floating mini-player opens with the **music video of the song that is playing** — the radio pauses and the video audio takes over;
* the video starts **synchronized with the radio position** (`start = elapsed` from the API) instead of from zero;
* every song change just swaps the embed to the new clip; songs without a clip close the video and fall back to the radio automatically;
* pausing the video resumes the radio, playing it again pauses the radio (YouTube IFrame postMessage — no external library);
* the preference is remembered, and it works in all three layouts with zero markup changes (button, mini-player and styles are injected by `js/main.js`).

The included free metadata API (twj.es) already resolves the clips server-side, with long-lived caching.

## How do I set up my radio? (Quick Start)

1. Clone or download this repository.
2. Edit **`config.js`** with your station(s) — or open **`gerador.html`** in a browser, fill the form and paste the generated result into `config.js`.
3. Replace the images in `assets/` (logo, default cover, favicon) with your own.
4. Upload everything to any static host — no PHP or build step required.

```javascript
// config.js — minimal example
window.streams = {
    layout: "retro",
    timeRefresh: 10000,
    stations: [
        {
            name: "Example FM",
            hash: "examplefm",
            description: "The best music!",
            logo: "assets/logo.png",
            album: "assets/cover.png",
            cover: "assets/cover.png",
            api: "",                                    // empty = use the free web API
            stream_url: "https://example.com/stream",
            server: "itunes",                           // "itunes" or "spotify" for extra art lookup
            social: { instagram: "https://instagram.com/examplefm" },
        },
    ],
};
```

## Station Configuration Reference

| Property | Required | Description |
|---|---|---|
| `name` | ✔ | Station name shown in the interface. |
| `hash` | ✔ | Unique identifier for the station. |
| `description` | ✔ | Short description / slogan. |
| `logo` | ✔ | Path/URL of the station logo. |
| `album` | ✔ | Default cover shown before the real album art loads. |
| `cover` | ✔ | Fallback cover for the current song. |
| `stream_url` | ✔ | Audio stream URL. |
| `frequency` | | Real FM frequency shown on the **retro** layout dial (e.g. `"87.9"`; comma also accepted). If omitted, a frequency is assigned automatically across the band. |
| `api` | | Custom metadata endpoint. Leave `""` to use the free built-in web API (`api.twj.es`). |
| `server` | | `"spotify"` or `"itunes"` — extra source for album art lookup. |
| `tv_url` | | Live video stream URL — enables the TV button/modal. |
| `program` | | Fixed "on air" info: `{ time, name, description }`. Used when there is no `programSchedule`. |
| `programSchedule` | | Weekly schedule (see below). Enables the "Programação" panel and the automatic "on air now" display. |
| `social` | | Links: `facebook`, `instagram`, `twitter`, `whatsapp`, `tiktok`, `youtube`. |
| `apps` | | App links: `android`, `ios`. |

### Weekly schedule format

```javascript
programSchedule: [
    // days: "dom", "seg", "ter", "qua", "qui", "sex", "sab"
    { days: ["seg","ter","qua","qui","sex"], start: "06:00", end: "12:00", name: "Morning Show", description: "With John Doe" },
    { days: ["dom","sab"],                   start: "18:00", end: "00:00", name: "Weekend Party", description: "Non stop music" },
],
```

The player highlights the slot that is on air right now and lists the full week in the schedule panel.

## File Structure

* **`config.js`** — all your settings (layout choice + stations). The only file you need to edit.
* **`index.html`** — loader: reads `config.js` and shows the chosen layout.
* **`index-redesign.html` / `index-classic.html` / `index-alt.html`** — the three layouts (each also works standalone).
* **`gerador.html`** — visual generator for `config.js` (runs locally in your browser).
* **`js/main.js`** — the shared player engine (audio, metadata polling/SSE, lyrics, history, schedule, media session).
* **`css/main.min.css`, `custom.css`, `rp-redesign.css`, `css/alt.css`** — styles per layout.
* **`assets/`** — images and icons.

## Free Hosting

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/jailsonsb2/Radioplayer_api)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/jailsonsb2/Radioplayer_api)

## Radio Metadata API

Get real-time metadata from online radio streams — free, no key required. Leave the station's `api` field empty to use it automatically.

### Available Endpoints

Base URL: `https://api.twj.es`

* `/` **(GET):** Current song and recent history as JSON (`songtitle`, `artist`, `song`, `source`, `song_history`). Shared 5-second cache — safe to poll. This is what the player uses by default.
    - **Required parameter:** `url` — the URL of the radio stream.
* `/stream.php` **(GET, SSE):** Same data pushed in real time via Server-Sent Events — connect with `EventSource` instead of polling.
    - **Required parameter:** `url` — the URL of the radio stream.
* `/search.php` **(GET):** Album art lookup for a song.
    - **Required parameter:** `query` — e.g. `Artist - Song`.

**Example:** `https://api.twj.es/?url=https://example.com/stream`

## Contributing

1. Fork the project.
2. Create a branch for your feature (`git checkout -b feature/new-feature`).
3. Commit your changes (`git commit -am 'Add new feature'`).
4. Push to the branch (`git push origin feature/new-feature`).
5. Create a new Pull Request.

---

## 📜 History

First published in mid-2024, this project descends from one of the first open-source "now playing" metadata APIs for web radio players written in plain PHP ([RadioplayerAPI](https://github.com/jailsonsb2/RadioplayerAPI), June 2024). The response format it introduced — `songtitle`, `artist`, `song`, `source`, `song_history` — has since been widely adopted across the web radio ecosystem, including by third-party commercial products.

## Related Projects

More free radio players from the same author:

| Project | Style |
|---|---|
| [**RadioPlayer**](https://github.com/jailsonsb2/RadioPlayer) | Full-page player for any stream (free now-playing API, YouTube clip mode) |
| [**bottom_radioplayer**](https://github.com/jailsonsb2/bottom_radioplayer) | **Bottom-bar component** — the audio never stops while visitors navigate |
| [**RadioPlayer-ZenoRadio**](https://github.com/jailsonsb2/RadioPlayer-ZenoRadio) | Full-page player for **Zeno.FM** streams (SSE metadata) |
| [**metadados**](https://github.com/jailsonsb2/metadados) | The free **now playing API** (ICY metadata + iTunes + YouTube clips) |

---

## ⚖️ License

This project is licensed under the **GNU AGPL-3.0** (see [LICENSE](LICENSE)): you are free to use, modify and redistribute it — including commercially — provided derivative works remain open source and keep the original copyright notices, **even when offered only as a hosted/network service**.

**Closed-source / commercial licensing:** to embed this code in a proprietary product without AGPL obligations, a separate commercial license is available — contact [contato@jailson.es](mailto:contato@jailson.es).

Copyright (C) 2024-2026 Jailson Bezerra ([@jailsonsb2](https://github.com/jailsonsb2))
