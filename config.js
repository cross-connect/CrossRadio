// ====================================================================
// RADIO PLAYER — CONFIGURATION
// This is the ONLY file you need to edit to set up your radio.
// It is shared by every layout (index.html loads the one you choose).
//
// Tip: use gerador.html in your browser to build this block visually.
// ====================================================================

window.streams = {
    // ----------------------------------------------------------------
    // LAYOUT / VERSION
    // Choose which player design index.html should load:
    //   "retro"   -> index-redesign.html (Retrô Glass — new redesign)
    //   "classic" -> index-classic.html  (Clássico — original player)
    //   "aurora"  -> index-alt.html      (Aurora Deck — alternative UI)
    // You can also open any of those files directly.
    // ----------------------------------------------------------------
    layout: "retro",

    // Metadata refresh interval (ms) when the API does not push updates
    timeRefresh: 10000,

    stations: [
        {
            name: "Jailson Webradio",
            hash: "jailson",
            description: "Música sem parar",
            // Optional: real FM frequency shown on the "retro" layout dial
            // (e.g. "87.9"). Leave it out to auto-assign one across the band.
            frequency: "",
            logo: "assets/jailson_logo.png",
            album: "assets/jailson_cover.png",
            cover: "assets/jailson_cover.png",
            api: "", // leave empty to use the free api.twj.es metadata API
            stream_url: "https://stream.zeno.fm/yn65fsaurfhvv",
            tv_url: "https://eu1.servers10.com:2020/VideoPlayer/8106?autoplay=1",
            server: "", // "spotify" or "itunes" for extra cover-art lookup
            program: {
                time: "",
                name: "",
                description: "",
            },
            // Optional weekly schedule shown in the "Programação" panel.
            // days: dom, seg, ter, qua, qui, sex, sab
            programSchedule: [
                { days: ["dom","seg","ter","qua","qui","sex","sab"], start: "06:00", end: "12:00", name: "Manhã Jailson Webradio", description: "Música sem parar" },
                { days: ["dom","seg","ter","qua","qui","sex","sab"], start: "12:00", end: "18:00", name: "Tarde Jailson Webradio", description: "Música sem parar" },
                { days: ["dom","seg","ter","qua","qui","sex","sab"], start: "18:00", end: "00:00", name: "Noite Jailson Webradio", description: "Música sem parar" },
                { days: ["dom","seg","ter","qua","qui","sex","sab"], start: "00:00", end: "06:00", name: "Madrugada Jailson Webradio", description: "Música sem parar" },
            ],
            social: {
                whatsapp: "",
                twitter: "https://twitter.com/",
                instagram: "https://www.instagram.com/",
            },
            apps: {
                android: "https://play.google.com/store/apps/details?id=com.jbcast.jwradio",
                ios: "",
            },
        },

        {
            name: "BENDICIÓN STEREO",
            hash: "bendicion",
            description: "Bendecidos para bendecir!",
            logo: "assets/default_logo.png",
            album: "assets/cover.png",
            cover: "assets/cover.png",
            api: "",
            stream_url: "https://sv2.globalhostlive.com/proxy/bendistereo/stream2",
            server: "spotify",
            program: {
                time: "11:00",
                name: "Bendición Stereo",
                description: "EN VIVO // ON AIR",
            },
            social: {
                facebook: "https://facebook.com/BendicionStereo",
                twitter: "https://twitter.com/BendiStereo",
                instagram: "https://www.instagram.com/BendiStereo/",
            },
            apps: {
                android: "",
                ios: "",
            },
        },
    ],
};
