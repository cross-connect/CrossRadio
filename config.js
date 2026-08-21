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
            name: "Rac+1",
            hash: "Rac+1",
            description: "RAC1, tots som 1",
            // Optional: real FM frequency shown on the "retro" layout dial
            // (e.g. "87.9"). Leave it out to auto-assign one across the band.
            frequency: "",
            logo: "https://i.ibb.co/k6SLjqgp/racmespodadct.png",
            album: "https://i.ibb.co/k6SLjqgp/racmespodadct.png",
            cover: "https://i.ibb.co/k6SLjqgp/racmespodadct.png",
            api: "", // leave empty to use the free api.twj.es metadata API
            stream_url: "https://i.ibb.co/k6SLjqgp/racmespodadct.png",
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
            name: "Catalunya Ràdio Digital",
            hash: "Catalunya Ràdio Digital",
            description: "Escolta't",
            logo: "https://i.ibb.co/MkB2RNcK/catdigi.png",
            album: "https://i.ibb.co/MkB2RNcK/catdigi.png",
            cover: "https://i.ibb.co/MkB2RNcK/catdigi.png",
            api: "",
            stream_url: "https://directes-radio-int.3catdirectes.cat/live-content/radio-oca-hls/master.m3u8",
            server: "spotify",
            program: {
                time: "11:00",
                name: "Catalunya Ràdio Digital",
                description: "Catalunya Ràdio Digital",
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
