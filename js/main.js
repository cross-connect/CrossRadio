(function () {
    "use strict";

    // --- [CONFIGURAÇÕES] -----------------------------------------------

    // Desligado de propósito: cada conexão SSE em stream.php prende um worker
    // do Apache por até 30min, e o servidor atual (~1GB RAM, compartilhado
    // entre várias rádios) não aguenta isso sob carga — foi o que causou a
    // instabilidade de 2026-07-08. Voltar a true quando o servidor da API for
    // mais robusto (mais RAM/workers, ou uma reescrita do stream.php que não
    // segure o processo). Com false, vai direto pro polling (API_URL_POLL).
    const SSE_ENABLED = false;
    const API_URL = "https://api.twj.es/stream.php?url=";
    // Endpoint de consulta única (index.php) — cache compartilhado de 5s no
    // Redis, responde em milissegundos. Usado no fallback de polling: cair
    // de volta para /stream.php ali seria pedir SSE de novo por fetch(), e
    // cada conexão SSE prende um worker do Apache por até 30 minutos — em
    // vez de aliviar um servidor sob carga, isso pioraria o problema.
    const API_URL_POLL = "https://api.twj.es/?url=";
    // Intervalo de consulta usado quando a API não fala SSE (ex.: painéis de
    // terceiros que só respondem JSON puro) — mesmo padrão do main_.js antigo
    const TIME_TO_REFRESH = (window.streams && window.streams.timeRefresh) || 10000;
    // Rede de segurança (não é a detecção principal, veja onerror em startSSE):
    // a API padrão pode legitimamente demorar dezenas de segundos até o
    // primeiro push, então esse prazo precisa ser folgado.
    const SSE_FALLBACK_TIMEOUT = 45000;

    // --- [CONSTANTES E VARIÁVEIS] --------------------------------------

    const buttons = document.querySelectorAll("[data-outside]");
    const ACTIVE_CLASS = "is-active";
    const cache = {};

    const lyricsCache = {};

    const playButton = document.querySelector(".player-button-play");
    const visualizerContainer = document.querySelector(".visualizer");
    const songNow = document.querySelector(".song-now");
    const stationsList = document.getElementById("stations");
    const stationName = document.querySelector(".station-name");
    const stationDescription = document.querySelector(".station-description");
    const headerLogoImg = document.querySelector(".header-logo-img");
    const playerArtwork = document.querySelector(".player-artwork img:first-child");
    const playerCoverImg = document.querySelector(".player-cover-image");
    const playerSocial = document.querySelector(".player-social");
    const playerApps = document.querySelector(".footer-app");
    const playerTv = document.querySelector(".footer-tv");
    const playerTvModal = document.getElementById("modal-tv");
    const playerProgram = document.querySelector(".player-program");
    const programacaoButton = document.querySelector('[data-outside="offcanvas-programacao"]');
    const programacaoList = document.getElementById("programacao-list");
    const lyricsContent = document.getElementById("lyrics");
    const history = document.getElementById("history");

    let currentStation;
    let activeButton;
    let currentSongPlaying;
    let lastAlbumArt = "";
    let lastLyricsKey = "";
    let lastProgramSignature = null;
    
    // --- [VARIÁVEIS DE ESTADO (RESILIÊNCIA, SSE E ÁUDIO)] -------------
    let isIntentionalPause = true;
    let reconnectAttempts = 0;
    let reconnectTimeout = null;
    let sseConnection = null;
    let sseFallbackTimer = null;
    let pollTimeoutId = null;
    // Geração do polling: um fetch em voo da estação anterior não pode
    // processar resposta nem se reagendar depois da troca de estação
    let pollGeneration = 0;
    let fadeInterval = null; // Variável para controlar o fade in/out

    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    let hasVisualizer = false;

    // --- [FUNÇÕES UTILITÁRIAS] ----------------------------------------- 

    function createElementFromHTML(htmlString) {
        const div = document.createElement("div");
        div.innerHTML = htmlString.trim();
        return div.firstChild;
    }

    function sanitizeText(text) {
        return text.replace(/^\d+\.\)\s/, "").replace(/<br>$/, "");
    }

    function changeImageSize(url, size) {
        return url.replace(/100x100/, size);
    }

    function createTempImage(src) {
        return new Promise((resolve, reject) => {
            const img = document.createElement("img");
            img.crossOrigin = "Anonymous";
            img.src = `https://images.weserv.nl/?url=${src}`;
            img.onload = () => resolve(img);
            img.onerror = reject;
        });
    }

    // --- [MELHORIA 2: FADE IN / FADE OUT SUAVE] -------------------------

    function fadeOut(callback) {
        if (fadeInterval) clearInterval(fadeInterval);
        let currentVol = audio.volume;
        let step = currentVol / 15; // Divide o volume atual em 15 passos
        
        fadeInterval = setInterval(() => {
            currentVol -= step;
            if (currentVol <= 0.05) {
                audio.volume = 0;
                clearInterval(fadeInterval);
                if (callback) callback(); // Pausa o áudio só depois de baixar o volume
            } else {
                audio.volume = currentVol;
            }
        }, 30); // Efeito dura ~450ms
    }

    function fadeIn() {
        if (fadeInterval) clearInterval(fadeInterval);
        // Recupera o volume original escolhido pelo utilizador
        let targetVol = parseInt(localStorage.getItem("volume") || "100", 10) / 100;
        audio.volume = 0;
        let step = targetVol / 15;
        
        fadeInterval = setInterval(() => {
            let newVol = audio.volume + step;
            if (newVol >= targetVol) {
                audio.volume = targetVol;
                clearInterval(fadeInterval);
            } else {
                audio.volume = newVol;
            }
        }, 30);
    }

    // --- [FUNÇÕES DE MANIPULAÇÃO DE ÁUDIO E RESILIÊNCIA] --------------

    // A rádio e um vídeo do YouTube nunca tocam juntos: dar play na rádio
    // pausa qualquer embed em reprodução (o caminho inverso é tratado pelo
    // watcher de mensagens do modo clipe)
    function pauseYouTubeEmbeds() {
        document.querySelectorAll('iframe[src*="youtube"]').forEach((frame) => {
            try {
                frame.contentWindow.postMessage(JSON.stringify({ event: "command", func: "pauseVideo", args: [] }), "*");
            } catch (e) {}
        });
    }

    function handlePlayPause() {
        if (audio.paused) {
            pauseYouTubeEmbeds();
            // Voltar para a rádio desliga o modo clipe — sem isso, a próxima
            // troca de música reabria o vídeo por cima do áudio
            exitClipMode();
            isIntentionalPause = false;
            fadeIn(); // Sobe o volume de mansinho
            play(audio);
        } else {
            isIntentionalPause = true; 
            fadeOut(() => { // Baixa o volume suavemente antes de pausar
                pause(audio);
            });
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
        }
    }
    
    function play(audio, newSource = null) {
        if (newSource) {
            audio.src = newSource; // atribuir src já dispara o load
        } else if (audio.paused) {
            // Stream AO VIVO: sem o load() o navegador retoma do buffer,
            // do ponto em que foi pausado — o ouvinte fica defasado da
            // transmissão. O load() descarta o buffer e reconecta ao vivo.
            audio.load();
        }

        audio.play().catch(e => console.log("Aguardando interação...", e));

        if (!hasVisualizer) {
            visualizer(audio, visualizerContainer);
            hasVisualizer = true;
        }
    }

    function pause(audio) {
        audio.pause();
        playButton.innerHTML = icons.play;
        playButton.classList.remove("is-active");
        document.body.classList.remove("is-playing");
    }

    // --- [MELHORIA 1: FEEDBACK SPINNER (A CARREGAR)] --------------------

    // Quando o áudio estiver a carregar/buffer, mostra o spinner a rodar
    audio.addEventListener('waiting', () => {
        playButton.innerHTML = icons.spinner;
    });

    // Quando a música finalmente começar a tocar limpa, troca para o botão de Pause
    audio.addEventListener('playing', () => {
        reconnectAttempts = 0;
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        
        playButton.innerHTML = icons.pause;
        playButton.classList.add("is-active");
        document.body.classList.add("is-playing");
    });

    audio.addEventListener('error', handleConnectionDrop);
    audio.addEventListener('stalled', handleConnectionDrop);

    function handleConnectionDrop(event) {
        if (isIntentionalPause) return; 

        console.warn(`Instabilidade na rede detetada. A iniciar reconexão...`);
        if (reconnectTimeout) clearTimeout(reconnectTimeout);

        if (reconnectAttempts < 5) {
            reconnectAttempts++;
            const delay = reconnectAttempts * 2000; 
            
            reconnectTimeout = setTimeout(() => {
                audio.load(); 
                const playPromise = audio.play();
                if (playPromise !== undefined) {
                    playPromise.catch(e => console.error("Falha ao reconectar:", e));
                }
            }, delay);
        } else {
            console.error("Muitas falhas seguidas. Parando reconexão automática.");
            pause(audio);
            isIntentionalPause = true;
            reconnectAttempts = 0;
        }
    }

    // --- [ÍCONES] ------------------------------------------------------

    const icons = { 
        play: '<svg class="i i-play" viewBox="0 0 24 24"><path d="m7 3 14 9-14 9z"></path></svg>',
        pause: '<svg class="i i-pause" viewBox="0 0 24 24"><path d="M5 4h4v16H5Zm10 0h4v16h-4Z"></path></svg>',
        // Adicionámos o ícone de carregamento e o de download da APP
        spinner: '<svg class="i i-spinner" viewBox="0 0 24 24"><path fill="currentColor" d="M12 22c5.523 0 10-4.477 10-10h-2a8 8 0 10-8 8v2z"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></path></svg>',
        download: '<svg class="i i-download" viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M4 21h16"></path></svg>',
        facebook: '<svg class="i i-facebook" viewBox="0 0 24 24"><path d="M17 14h-3v8h-4v-8H7v-4h3V7a5 5 0 0 1 5-5h3v4h-3q-1 0-1 1v3h4Z"></path></svg>',
        twitter: '<svg class="i i-x" viewBox="0 0 24 24"><path d="m3 21 7.5-7.5m3-3L21 3M8 3H3l13 18h5Z"></path></svg>',
        instagram: '<svg class="i i-instagram" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"></circle><rect width="20" height="20" x="2" y="2" rx="5"></rect><path d="M17.5 6.5h0"></path></svg>',
        youtube: '<svg class="i i-youtube" viewBox="0 0 24 24"><path d="M1.5 17q-1-5.5 0-10Q1.9 4.8 4 4.5q8-1 16 0 2.1.3 2.5 2.5 1 4.5 0 10-.4 2.2-2.5 2.5-8 1-16 0-2.1-.3-2.5-2.5Zm8-8.5v7l6-3.5Z"></path></svg>',
        tiktok: '<svg class="i i-tiktok" viewBox="0 0 24 24"><path d="M22 6v5q-4 0-6-2v7a7 7 0 1 1-5-6.7m0 6.7a2 2 0 1 0-2 2 2 2 0 0 0 2-2V1h5q2 5 6 5"></path></svg>',
        whatsapp: '<svg class="i i-whatsapp" viewBox="0 0 24 24"><circle cx="9" cy="9" r="1"></circle><circle cx="15" cy="15" r="1"></circle><path d="M8 9a7 7 0 0 0 7 7m-9 5.2A11 11 0 1 0 2.8 18L2 22Z"></path></svg>',
        telegram: '<svg class="i i-telegram" viewBox="0 0 24 24"><path d="M12.5 16 9 19.5 7 13l-5.5-2 21-8-4 18-7.5-7 4-3"></path></svg>',
        tv: '<svg class="i i-tv" viewBox="0 0 24 24"><rect width="22" height="15" x="1" y="3" rx="3"></rect><path d="M7 21h10"></path></svg>',
    };

    function outsideClick(button) {
        if (!button) return;
        const target = document.getElementById(button.dataset.outside);
        if (!target) return;
        button.addEventListener("click", () => {
            button.classList.toggle(ACTIVE_CLASS);
            target.classList.toggle(ACTIVE_CLASS);
        });
        const clickOutside = (event) => {
            if (!target.contains(event.target) && !button.contains(event.target)) {
                button.classList.remove(ACTIVE_CLASS);
                target.classList.remove(ACTIVE_CLASS);
            }
        };
        document.addEventListener("click", clickOutside);
        const close = target.querySelector("[data-close]");
        if (close) {
            close.onclick = function () {
                button.classList.remove(ACTIVE_CLASS);
                target.classList.remove(ACTIVE_CLASS);
            };
        }
    }

    buttons.forEach((button) => {
        outsideClick(button);
    });

    function initCanvas(container) {
        const canvas = document.createElement("canvas");
        canvas.setAttribute("id", "visualizerCanvas");
        canvas.setAttribute("class", "visualizer-item");
        container.appendChild(canvas);
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight;
        return canvas;
    }

    function resizeCanvas(canvas, container) {
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight;
    }

    const visualizer = (audio, container) => {
        if (!audio || !container) {
            return;
        }
        const options = {
            fftSize: container.dataset.fftSize || 2048,
            numBars: container.dataset.bars || 40,
            maxHeight: container.dataset.maxHeight || 255,
            // "bars" = espectro em barras (onda quadrada); "wave" = forma de onda contínua (senoidal)
            shape: container.dataset.shape === "wave" ? "wave" : "bars",
            // fração da largura de cada barra usada como espaço vazio entre elas.
            // Padrão 0 (barras coladas): é o que deixa o filtro gooey do layout
            // clássico derreter as barras numa onda contínua. Quem quer barras
            // separadas (VU do redesign, fundo do Aurora) declara data-gap.
            gap: container.dataset.gap !== undefined ? parseFloat(container.dataset.gap) : 0,
            // data-fit: escala as barras para a altura real do canvas (0-255 vira 0-100%).
            // Sem isso a altura é usada em px brutos — certo para o visualizer de tela
            // cheia do layout clássico, mas estoura caixas pequenas como o VU do redesign,
            // que ficava permanentemente "cheio" com o áudio em volume normal.
            fit: container.dataset.fit !== undefined,
        };
        const ctx = new AudioContext();
        const audioSource = ctx.createMediaElementSource(audio);
        const analyzer = ctx.createAnalyser();
        audioSource.connect(analyzer);
        audioSource.connect(ctx.destination);
        if (options.fftSize) {
            analyzer.fftSize = options.fftSize;
        }
        const frequencyData = new Uint8Array(analyzer.frequencyBinCount);
        const timeData = new Uint8Array(analyzer.fftSize);
        const canvas = initCanvas(container);
        const canvasCtx = canvas.getContext("2d");

        let animationId = null;
        let isRunning = false;

        const renderBars = () => {
            resizeCanvas(canvas, container);
            canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

            if (options.shape === "wave") {
                analyzer.getByteTimeDomainData(timeData);
                const sliceWidth = canvas.width / (timeData.length - 1);
                canvasCtx.strokeStyle = "white";
                canvasCtx.lineWidth = 2;
                canvasCtx.beginPath();
                for (let i = 0; i < timeData.length; i++) {
                    const y = (timeData[i] / 255) * canvas.height;
                    const x = i * sliceWidth;
                    if (i === 0) {
                        canvasCtx.moveTo(x, y);
                    } else {
                        canvasCtx.lineTo(x, y);
                    }
                }
                canvasCtx.stroke();
            } else {
                analyzer.getByteFrequencyData(frequencyData);
                for (let i = 0; i < options.numBars; i++) {
                    const index = Math.floor((i + 10) * (i < options.numBars / 2 ? 2 : 1));
                    const fd = frequencyData[index];
                    const barHeight = options.fit
                        ? Math.max(2, ((fd || 0) / 255) * canvas.height)
                        : Math.max(4, fd || 0) + options.maxHeight / 255;
                    const barWidth = canvas.width / options.numBars;
                    const gap = barWidth * options.gap;
                    const x = i * barWidth;
                    const y = canvas.height - barHeight;
                    canvasCtx.fillStyle = "white";
                    // sem gap, +1px de sobreposição evita frestas de anti-aliasing
                    // entre barras vizinhas (mantém a silhueta da onda contínua)
                    canvasCtx.fillRect(x + gap / 2, y, gap ? barWidth - gap : barWidth + 1, barHeight);
                }
            }

            animationId = requestAnimationFrame(renderBars);
        };

        // Em telas pequenas o bargraph fica desligado para economizar bateria/CPU
        // do celular. Usamos matchMedia (em vez de um único check no play()) para
        // que isso reaja também quando a janela é redimensionada depois — ex.:
        // testar breakpoints no devtools sem recarregar a página.
        const mobileQuery = window.matchMedia("(max-width: 767px)");

        function start() {
            if (isRunning) return;
            isRunning = true;
            container.style.display = "";
            renderBars();
        }

        function stop() {
            isRunning = false;
            if (animationId) {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
            container.style.display = "none";
        }

        function syncWithViewport() {
            if (mobileQuery.matches) {
                stop();
            } else {
                start();
            }
        }

        syncWithViewport();
        if (mobileQuery.addEventListener) {
            mobileQuery.addEventListener("change", syncWithViewport);
        } else {
            mobileQuery.addListener(syncWithViewport);
        }

        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                if (animationId) cancelAnimationFrame(animationId);
            } else if (isRunning) {
                renderBars();
            }
        });
    };

    async function getDataFrom({ artist, title, art, cover }) {
        let dataFrom = {};
        let text = artist ? `${artist} - ${title}` : title;
    
        const cacheKey = text.toLowerCase();
        if (cache[cacheKey]) {
            return cache[cacheKey];
        }
    
        try {
            dataFrom = await getDataFromSearch(artist, title, art, cover);
            if (dataFrom.stream_url === "#not-found") {
                dataFrom = await getDataFromITunes(artist, title, art, cover);
            }
        } catch (error) {
            console.error("Erro ao buscar dados:", error);
            dataFrom = await getDataFromITunes(artist, title, art, cover);
        }
    
        cache[cacheKey] = dataFrom;
        return dataFrom;
    }
    
    async function getDataFromSearch(artist, title, defaultArt, defaultCover) {
        let text = artist ? `${artist} - ${title}` : title;
        const cacheKey = text.toLowerCase();
    
        if (cache[cacheKey]) {
            return cache[cacheKey];
        }
    
        try {
            const response = await fetch(`https://api.twj.es/search.php?query=${encodeURIComponent(text)}`);
            if (!response.ok) {
                throw new Error(`Erro API busca. Status: ${response.status}`);
            }
            const data = await response.json();
    
            if (data.results) {
                const searchResults = data.results;
                // O ICY é lei: a busca só fornece capa/link, nunca renomeia
                const results = {
                    title,
                    artist,
                    thumbnail: searchResults.artwork || defaultArt,
                    art: searchResults.artwork || defaultArt,
                    cover: searchResults.artwork || defaultCover,
                    stream_url: searchResults.stream_url || "#not-found",
                };
                cache[cacheKey] = results;
                return results;
            } else {
                return { title, artist, art: defaultArt, cover: defaultCover, stream_url: "#not-found" };
            }
        } catch (error) {
            return { title, artist, art: defaultArt, cover: defaultCover, stream_url: "#not-found" };
        }
    }

    async function getDataFromITunes(artist, title, defaultArt, defaultCover) {
        let text = artist ? `${artist} - ${title}` : title;
        const cacheKey = text.toLowerCase();

        if (cache[cacheKey]) {
            return cache[cacheKey];
        }

        try {
            const response = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(text)}&media=music&limit=1`);
            if (!response.ok) {
                throw new Error(`Erro iTunes. Status: ${response.status}`);
            }
            const data = await response.json();

            if (data.resultCount > 0) {
                const itunesData = data.results[0];
                // O ICY é lei: o iTunes só fornece capa/link, nunca renomeia
                const results = {
                    title,
                    artist,
                    thumbnail: itunesData.artworkUrl100 || defaultArt,
                    art: itunesData.artworkUrl100 ? changeImageSize(itunesData.artworkUrl100, "600x600") : defaultArt,
                    cover: itunesData.artworkUrl100 ? changeImageSize(itunesData.artworkUrl100, "1500x1500") : defaultCover,
                    stream_url: itunesData.trackViewUrl || "#not-found",
                };
                cache[cacheKey] = results;
                return results;
            } else {
                return { title, artist, art: defaultArt, cover: defaultCover, stream_url: "#not-found" };
            }
        } catch (error) {
            return { title, artist, art: defaultArt, cover: defaultCover, stream_url: "#not-found" };
        }
    }

    const getLyrics = (artist, name) => {
        const cacheKey = `${artist} - ${name}`.toLowerCase();
        // Cacheia a própria Promise (não só o resultado): se duas chamadas
        // caírem para a mesma música quase ao mesmo tempo (evento SSE +
        // enriquecimento do iTunes logo em seguida), a segunda reaproveita
        // a requisição já em voo em vez de martelar as APIs de novo — foi
        // isso que gerava os erros duplicados de CORS/"Failed to fetch" no console.
        if (lyricsCache[cacheKey]) {
            return lyricsCache[cacheKey];
        }

        const fetchLyrics = async () => {
            // 1ª tentativa: lyrics.ovh (a API do Vagalume foi descontinuada).
            // Um 404 aqui é resultado normal (letra não catalogada), não um erro.
            try {
                const response = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(name)}`);
                const data = await response.json();
                if (data && data.lyrics) {
                    return data.lyrics;
                }
                console.log("lyrics.ovh não encontrou a letra. Tentando LRCLIB...");
            } catch (error) {
                console.warn("lyrics.ovh indisponível, tentando LRCLIB...", error.message);
            }

            // 2ª tentativa: LRCLIB /api/get — match exato por assinatura.
            // De propósito NÃO enviamos duration: quando presente, o LRCLIB exige
            // match de ±2s e descartaria letras válidas (a duração do iTunes nem
            // sempre bate com a do registro deles). Sem duration o match é solto.
            // Também de propósito SEM headers customizados: qualquer header extra
            // força um preflight OPTIONS, e o LRCLIB às vezes não responde esse
            // preflight corretamente — isso vira "Failed to fetch"/CORS no lugar
            // de um simples 404, mesmo quando o /get em si funcionaria.
            try {
                const response = await fetch(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(name)}`);
                if (response.ok) {
                    const data = await response.json();
                    const lyrics = data.plainLyrics || data.syncedLyrics;
                    if (lyrics) return lyrics;
                }
                console.log("LRCLIB /get não encontrou a letra. Tentando /search...");
            } catch (error) {
                console.warn("LRCLIB /get indisponível, tentando /search...", error.message);
            }

            // 3ª tentativa: LRCLIB /api/search — busca por palavras-chave,
            // tolera diferenças de grafia no título/artista
            try {
                const response = await fetch(`https://lrclib.net/api/search?track_name=${encodeURIComponent(name)}&artist_name=${encodeURIComponent(artist)}`);
                if (!response.ok) throw new Error("LRCLIB não respondeu");
                const results = await response.json();
                const hit = Array.isArray(results) && results.find((r) => r.plainLyrics || r.syncedLyrics);
                return (hit && (hit.plainLyrics || hit.syncedLyrics)) || "Letra não disponível";
            } catch (error) {
                // Nenhuma das 3 fontes respondeu (ou a música não tem letra
                // catalogada em nenhuma delas) — isso é um resultado esperado,
                // não uma falha da aplicação, então não sobe como console.error.
                console.warn("Nenhuma fonte de letras respondeu para esta música.", error.message);
                return "Letra não disponível";
            }
        };

        const promise = fetchLyrics();
        lyricsCache[cacheKey] = promise;
        return promise;
    };

    function normalizeTitle(api) {
        let title;
        let artist;
      
        if (api.last_played) {
          title = api.last_played.song;
          artist = api.last_played.artist;
        } else if (api.song && api.artist) {
          title = api.song;
          artist = api.artist;
        } else if (api.songtitle && api.songtitle.includes(" - ")) {
          // Convenção ICY: "Artista - Título" (mesma usada pela API em twj.es)
          artist = api.songtitle.split(" - ")[0];
          title = api.songtitle.split(" - ")[1];
        } else if (api.now_playing && api.now_playing.song) {
          title = api.now_playing.song.title;
          artist = api.now_playing.song.artist;
        } else if (api.artist && api.title) {
          title = api.title;
          artist = api.artist;
        } else if (api.currenttrack_title) {
          title = api.currenttrack_title;
          artist = api.currenttrack_artist;
        } else if (api.title && api.djprofile && api.djusername) {
          title = api.title.split(" - ")[1];
          artist = api.title.split(" - ")[0];
        } else {
          title = api.currentSong;
          artist = api.currentArtist;
        }
      
        return { title, artist };
    }

    function normalizeHistory(api) {
        const historyData = api.song_history || api.history || api.songHistory || [];
    
        if (!Array.isArray(historyData)) {
            return [];
        }
    
        const history = historyData.slice(0, 10); 
      
        const historyNormalized = history.map((item) => {
          let artist = "";
          let song = "";
    
          if (item.song && typeof item.song === 'object' && item.song.title) {
            artist = item.song.artist || ""; 
            song = item.song.title;
          } 
          else if (item.song && typeof item.song === 'string') {
            artist = item.artist || "";
            song = item.song;
          }
          else if (item.title) {
             artist = item.artist || "";
             song = item.title;
          }
    
          if (!song) return null;
    
          return {
            artist: sanitizeText(artist),
            song: sanitizeText(song),
          };
        });
      
        return historyNormalized.filter(item => item !== null);
    }

    // --- [FUNÇÕES DE MANIPULAÇÃO DA INTERFACE] ------------------------

    // A cor dominante crua da capa pode ser quase preta (agulha, vinil e play
    // somem no escuro) ou clara/lavada demais (não marca no dial creme).
    // Clampa em HSL para uma faixa sempre visível; capa sem cor nenhuma
    // (P&B/cinza) devolve null e o layout fica com o --accent padrão dele.
    function vividAccent(rgb) {
        const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        let l = (max + min) / 2;
        let s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
        let h;
        if (d === 0) h = 0;
        else if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
        if (h < 0) h += 360;
        if (s < 0.1) return null;
        s = Math.max(s, 0.45);
        l = Math.min(Math.max(l, 0.42), 0.68);
        return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
    }

    function setAccentColor(image, colorThief) {
        const dom = document.documentElement;
        const metaThemeColor = document.querySelector("meta[name=theme-color]");
        const apply = () => {
            const accent = vividAccent(colorThief.getColor(image));
            if (accent) {
                dom.style.setProperty("--accent", accent);
            } else {
                dom.style.removeProperty("--accent");
            }
            if (metaThemeColor) {
                metaThemeColor.setAttribute("content", accent || "dark light");
            }
        };
        if (image.complete) {
            apply();
        } else {
            image.addEventListener("load", apply);
        }
    }

    function createOpenTvButton(url) {
        const $button = document.createElement("button");
        $button.classList.add("player-button-tv", "btn");
        $button.innerHTML = icons.tv + "Tv ao vivo";
        $button.addEventListener("click", () => {
            playerTvModal.classList.add("is-active");

            const wasPlaying = !audio.paused;
            // Pausa INTENCIONAL: sem esta flag o watchdog de reconexão
            // (handleConnectionDrop) tratava a pausa como queda de rede e
            // religava a rádio por cima do áudio da TV
            isIntentionalPause = true;
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            fadeOut(() => pause(audio));

            const modalBody = playerTvModal.querySelector(".modal-body-video");
            const closeButton = playerTvModal.querySelector("[data-close]");
            const $iframe = document.createElement("iframe");
            $iframe.src = url;
            $iframe.allowFullscreen = true;
            modalBody.appendChild($iframe);
            // once: true — sem isso cada abertura da TV acumulava um listener
            closeButton.addEventListener("click", () => {
                playerTvModal.classList.remove("is-active");
                $iframe.remove();
                // Retoma a rádio (no ponto ao vivo) se estava tocando antes
                if (wasPlaying) {
                    isIntentionalPause = false;
                    fadeIn();
                    play(audio, currentStation.stream_url);
                }
            }, { once: true });
        });
        playerTv.appendChild($button);
    }

    function createProgram(program) {
        if (!program) return;
        if (program.time) {
            const $div = document.createElement("div");
            const $span = document.createElement("span");
            $div.classList.add("player-program-time-container");
            $span.classList.add("player-program-badge");
            $span.textContent = "On Air";
            $div.appendChild($span);
            const $time = document.createElement("span");
            $time.classList.add("player-program-time");
            $time.textContent = program.time;
            $div.appendChild($time);
            playerProgram.appendChild($div);
        }
        if (program.name) {
            const $name = document.createElement("span");
            $name.classList.add("player-program-name");
            $name.textContent = program.name;
            playerProgram.appendChild($name);
        }
        if (program.description) {
            const $description = document.createElement("span");
            $description.classList.add("player-program-description");
            $description.textContent = program.description;
            playerProgram.appendChild($description);
        }
    }

    const WEEKDAY_CODES = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

    function toMinutes(hhmm) {
        const [h, m] = hhmm.split(":").map(Number);
        return h * 60 + m;
    }

    // Acha a faixa que cobre o instante `now`. Faixas overnight (end <= start,
    // ex: 22:00-02:00) continuam ativas depois da virada do dia, quando o dia
    // da semana já mudou para o dia seguinte — por isso também checa o dia
    // anterior, não só item.days.includes(hoje).
    function findActiveSlot(schedule, now) {
        const day = now.getDay();
        const todayCode = WEEKDAY_CODES[day];
        const yesterdayCode = WEEKDAY_CODES[(day + 6) % 7];
        const minutes = now.getHours() * 60 + now.getMinutes();
        return schedule.find((item) => {
            if (!item.days) return false;
            const start = toMinutes(item.start);
            const end = toMinutes(item.end);
            const overnight = end <= start;
            if (item.days.includes(todayCode)) {
                if (overnight ? minutes >= start : minutes >= start && minutes < end) return true;
            }
            return overnight && item.days.includes(yesterdayCode) && minutes < end;
        });
    }

    // Faixas de hoje para a lista "Programação", na ordem de início. Inclui a
    // faixa overnight de ontem que ainda esteja ativa (madrugada), mesmo que
    // ela não esteja marcada com o dia de hoje.
    function getTodaySlots(schedule, now) {
        const todayCode = WEEKDAY_CODES[now.getDay()];
        const slots = schedule.filter((item) => item.days && item.days.includes(todayCode));
        const active = findActiveSlot(schedule, now);
        if (active && !slots.includes(active)) slots.push(active);
        return slots.slice().sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    }

    function getScheduledProgram(station, now = new Date()) {
        if (!station.programSchedule || !station.programSchedule.length) return null;
        const slot = findActiveSlot(station.programSchedule, now);
        if (!slot) return null;
        return { time: `${slot.start} - ${slot.end}`, name: slot.name, description: slot.description };
    }

    // Só reconstrói o DOM de .player-program quando o conteúdo de fato muda,
    // evitando flicker no setInterval que mantém a faixa em dia.
    function renderProgram(station) {
        if (!playerProgram) return;
        const program = getScheduledProgram(station) || station.program;
        const signature = program ? `${program.time || ""}|${program.name || ""}|${program.description || ""}` : "";
        if (signature === lastProgramSignature) return;
        lastProgramSignature = signature;
        playerProgram.innerHTML = "";
        createProgram(program);
    }

    function renderProgramacaoList(station) {
        if (!programacaoButton || !programacaoList) return;
        const schedule = station.programSchedule;
        if (!schedule || !schedule.length) {
            programacaoButton.hidden = true;
            programacaoList.innerHTML = "";
            return;
        }
        programacaoButton.hidden = false;
        const now = new Date();
        const activeSlot = findActiveSlot(schedule, now);
        const $fragment = document.createDocumentFragment();
        getTodaySlots(schedule, now).forEach((slot) => {
            const $item = document.createElement("div");
            $item.classList.add("programacao-item");
            if (slot === activeSlot) $item.classList.add("is-active");
            const $time = document.createElement("span");
            $time.classList.add("programacao-item-time");
            $time.textContent = `${slot.start} - ${slot.end}`;
            $item.appendChild($time);
            const $info = document.createElement("div");
            $info.classList.add("programacao-item-info");
            const $name = document.createElement("span");
            $name.classList.add("programacao-item-name");
            $name.textContent = slot.name || "";
            $info.appendChild($name);
            if (slot.description) {
                const $description = document.createElement("span");
                $description.classList.add("programacao-item-description");
                $description.textContent = slot.description;
                $info.appendChild($description);
            }
            $item.appendChild($info);
            $fragment.appendChild($item);
        });
        programacaoList.innerHTML = "";
        programacaoList.appendChild($fragment);
    }

    function createSocialItem(url, icon) {
        const $a = document.createElement("a");
        $a.classList.add("player-social-item");
        $a.href = url;
        $a.target = "_blank";
        $a.innerHTML = icons[icon];
        return $a;
    }

    function createAppsItem(url, name) {
        const $a = document.createElement("a");
        $a.classList.add("player-apps-item");
        $a.href = url;
        $a.target = "_blank";
        $a.innerHTML = `<img src="assets/app/${name}.svg" alt="${name}" height="48" width="${name === "ios" ? "143" : "163"}">`;
        return $a;
    }

    function createStreamItem(station, index, currentStation, callback) {
        const $button = document.createElement("button");
        $button.classList.add("station");
        $button.innerHTML = `<img class="station-img" src="${station.album}" alt="station" height="160" width="160">`;
        $button.dataset.index = index;
        $button.dataset.hash = station.hash;
        if (currentStation.stream_url === station.stream_url) {
            $button.classList.add("is-active");
            activeButton = $button;
        }
        $button.addEventListener("click", () => {
            if ($button.classList.contains("is-active")) return;
            if (activeButton) {
                activeButton.classList.remove("is-active");
            }
            $button.classList.add("is-active");
            activeButton = $button; 

            setAssetsInPage(station);
            play(audio, station.stream_url);
            if (history) {
                history.innerHTML = "";
            }
            if (typeof callback === "function") {
                callback(station);
            }
        });
        return $button;
    }

    function createStations(stations, currentStation, callback) {
        if (!stationsList) return;
        stationsList.innerHTML = "";
        stations.forEach(async (station, index) => {
            const $fragment = document.createDocumentFragment();
            const $button = createStreamItem(station, index, currentStation, callback);
            $fragment.appendChild($button);
            stationsList.appendChild($fragment);
        });
    }

    function setAssetsInPage(station) {
        playerSocial.innerHTML = "";
        playerApps.innerHTML = "";
        playerProgram.innerHTML = "";
        playerTv.innerHTML = "";
        headerLogoImg.src = station.logo;
        playerArtwork.src = station.album;
        playerCoverImg.src = station.cover || station.album;
        stationName.textContent = station.name;
        stationDescription.textContent = station.description;
        if (station.social && playerSocial) {
            Object.keys(station.social).forEach((key) => {
                playerSocial.appendChild(createSocialItem(station.social[key], key));
            });
        }
        if (station.apps && playerApps) {
            Object.keys(station.apps).forEach((key) => {
                playerApps.appendChild(createAppsItem(station.apps[key], key));
            });
        }
        lastProgramSignature = null;
        renderProgram(station);
        renderProgramacaoList(station);
        if (station.tv_url && playerTv) {
            createOpenTvButton(station.tv_url);
        }
    }

    function mediaSession(data) {
        const { title, artist, album, art } = data;
        if ("mediaSession" in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title, artist, album,
                artwork: [{ src: art, sizes: "512x512", type: "image/png" }],
            });
            navigator.mediaSession.setActionHandler("play", () => play(audio));
            navigator.mediaSession.setActionHandler("pause", () => pause(audio));
        }
    }

    function currentSong(data) {
        const content = songNow;
        content.querySelector(".song-name").textContent = data.title;
        content.querySelector(".song-artist").textContent = data.artist;
        const artwork = content.querySelector(".player-artwork");

        if (artwork) {
            const $img = document.createElement("img");
            $img.src = data.art;
            $img.width = 600;
            $img.height = 600;

            $img.style.opacity = 0;
            $img.style.position = "absolute";
            $img.style.top = "0";
            $img.style.left = "0";
            $img.style.transition = "opacity 0.8s ease-in-out";

            $img.addEventListener("load", () => {
                artwork.appendChild($img);
                // eslint-disable-next-line no-undef
                const colorThief = new ColorThief();
                createTempImage($img.src).then((img) => {
                    setAccentColor(img, colorThief);
                });

                setTimeout(() => {
                    $img.style.opacity = 1; 
                    setTimeout(() => {
                        artwork.querySelectorAll("img:not(:last-child)").forEach((oldImg) => {
                            oldImg.remove();
                        });
                        $img.style.position = "relative";
                    }, 800); 
                }, 50);
            });
        }

        if (playerCoverImg) {
            const tempImg = new Image();
            tempImg.src = data.cover || data.art;
            
            tempImg.addEventListener("load", () => {
                playerCoverImg.style.transition = "opacity 0.4s ease-in-out";
                playerCoverImg.style.opacity = 0; 
                
                setTimeout(() => {
                    playerCoverImg.src = data.cover || data.art;
                    playerCoverImg.style.transition = "opacity 0.8s ease-in-out";
                    playerCoverImg.style.opacity = 1; 
                }, 400); 
            });
        }
    }

    function setHistory(data, current, server) {
        if (!history) return;
        history.innerHTML = historyTemplate.replace("{{art}}", pixel).replace("{{song}}", "Carregando historico...").replace("{{artist}}", "Artista").replace("{{stream_url}}", "#not-found");
        if (!data) return;

        data = data.slice(0, 10);
        const promises = data.map(async (item) => {
            const { artist, song } = item;
            const { album, cover } = current;
            const dataFrom = await getDataFrom({ artist, title: song, art: album, cover, server });
            
            if (server === 'deezer' && !dataFrom.stream_url) { 
                dataFrom.stream_url = '#'; 
            }
            return historyTemplate
                .replace("{{art}}", dataFrom.thumbnail || dataFrom.art)
                .replace("{{song}}", dataFrom.title)
                .replace("{{artist}}", dataFrom.artist)
                .replace("{{stream_url}}", dataFrom.stream_url);
        });
        Promise.all(promises).then((itemsHTML) => {
            const $fragment = document.createDocumentFragment();
            itemsHTML.forEach((itemHTML) => {
                $fragment.appendChild(createElementFromHTML(itemHTML));
            });
            history.innerHTML = "";
            history.appendChild($fragment);
        }).catch((error) => console.error("Error:", error));
    }

    function setLyrics(artist, title) {
        if (!lyricsContent) return;
        getLyrics(artist, title).then((lyrics) => {
            const $p = document.createElement("p");
            $p.innerHTML = lyrics.replace(/\n/g, "<br>");
            lyricsContent.innerHTML = "";
            lyricsContent.appendChild($p);
        }).catch((error) => console.error("Error:", error));
    }

    // --- [MODO CLIPE: vídeo da música via youtubeId da API] --------------
    // Quando o now-playing entrega o youtubeId, um botão "Clipe" flutuante
    // aparece; ligado, um mini-player mostra o clipe da música sincronizado
    // com a rádio (start = elapsed) e troca o embed a cada faixa. Pausar o
    // vídeo retoma a rádio; dar play pausa. Botão, dock e CSS são injetados
    // por aqui — layout-agnóstico, funciona nos três layouts sem tocar
    // no HTML de cada um.

    let clipTrack = null;
    let lastClipShownId = null;
    let clipWasRadioPlaying = false;
    const clipPlayingSet = new Set();

    const clipModeOn = () => localStorage.getItem("clipMode") === "1";

    function injectClipStyles() {
        if (document.getElementById("rpclip-styles")) return;
        const style = document.createElement("style");
        style.id = "rpclip-styles";
        style.textContent = [
            ".rpclip-fab { position: fixed; z-index: 140; right: 16px; bottom: 88px; display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 999px; border: 1px solid rgba(255,255,255,.25); background: rgba(13,17,23,.8); color: #fff; font: 600 12px/1 system-ui, sans-serif; letter-spacing: .06em; cursor: pointer; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); transition: background .2s ease; }",
            ".rpclip-fab:hover { background: rgba(255,255,255,.18); }",
            ".rpclip-fab.is-active { border-color: var(--accent, #4dd7e0); color: var(--accent, #4dd7e0); }",
            ".rpclip-fab svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }",
            ".player-button-clip { display: inline-flex; align-items: center; justify-content: center; }",
            ".player-button-clip.is-active { color: var(--accent, #4dd7e0) !important; }",
            ".rpclip-dock { position: fixed; z-index: 141; right: 16px; bottom: 140px; width: min(420px, calc(100vw - 32px)); border-radius: 16px; overflow: hidden; background: rgba(13,17,23,.96); border: 1px solid rgba(255,255,255,.16); box-shadow: 0 24px 60px rgba(0,0,0,.55); }",
            ".rpclip-dock header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; color: #fff; font: 700 13px/1.3 system-ui, sans-serif; }",
            ".rpclip-dock header span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
            ".rpclip-dock header button { flex: none; width: 28px; height: 28px; border: none; border-radius: 50%; background: rgba(255,255,255,.1); color: #fff; cursor: pointer; transition: background .2s ease; }",
            ".rpclip-dock header button:hover { background: rgba(255,255,255,.22); }",
            ".rpclip-dock iframe { width: 100%; aspect-ratio: 16/9; display: block; border: 0; }",
        ].join("\n");
        document.head.appendChild(style);
    }

    // O botão só aparece quando a API demonstra suportar o campo.
    // Integrado ao painel de controles: nasce ao lado do botão de letras
    // herdando as classes dele, então cada layout o estiliza nativamente
    // (círculo no aurora, ícone do redesign etc). Layout sem botão de
    // letras cai para um botão flutuante.
    function ensureClipButton() {
        injectClipStyles();
        if (document.querySelector(".player-button-clip, .rpclip-fab")) return;

        const clipSvg = '<svg class="i" viewBox="0 0 24 24"><rect width="20" height="16" x="2" y="4" rx="3"></rect><path d="m10 9 5 3-5 3z"></path></svg>';
        const lyricsButton = document.querySelector(".player-button-lyrics");

        const btn = document.createElement("button");
        btn.type = "button";
        if (lyricsButton) {
            btn.className = lyricsButton.className.replace("player-button-lyrics", "player-button-clip");
            btn.innerHTML = clipSvg;
            lyricsButton.insertAdjacentElement("afterend", btn);
        } else {
            btn.className = "rpclip-fab";
            btn.innerHTML = clipSvg + "Clipe";
            document.body.appendChild(btn);
        }

        btn.title = "Modo clipe: mostra o clipe da música que está tocando";
        btn.setAttribute("aria-label", "Clipe da música");
        btn.classList.toggle("is-active", clipModeOn());

        btn.addEventListener("click", () => {
            const turningOn = !clipModeOn();
            localStorage.setItem("clipMode", turningOn ? "1" : "0");
            btn.classList.toggle("is-active", turningOn);
            if (turningOn && clipTrack) openClip(clipTrack);
            else if (!turningOn) closeClip(true);
        });
    }

    function pauseRadioForClip() {
        if (audio.paused) return;
        clipWasRadioPlaying = true;
        isIntentionalPause = true;
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        fadeOut(() => pause(audio));
    }

    function resumeRadioAfterClip() {
        if (clipWasRadioPlaying && audio.paused) {
            isIntentionalPause = false;
            fadeIn();
            play(audio);
        }
        clipWasRadioPlaying = false;
    }

    function openClip(track) {
        if (lastClipShownId === track.id) return;
        lastClipShownId = track.id;

        pauseRadioForClip();

        // Sincroniza com a rádio: o clipe começa no ponto em que a música
        // está (elapsed da API + tempo desde a resposta). Aproximado: o
        // stream tem atraso de buffer e o clipe pode ser outra versão.
        let start = 0;
        if (track.elapsed) {
            start = Math.floor(track.elapsed + (Date.now() - track.receivedAt) / 1000);
            if (track.duration && start >= track.duration - 5) start = 0;
            if (start < 8) start = 0;
        }

        let dock = document.querySelector(".rpclip-dock");
        if (!dock) {
            dock = document.createElement("div");
            dock.className = "rpclip-dock";
            const header = document.createElement("header");
            const title = document.createElement("span");
            const close = document.createElement("button");
            close.type = "button";
            close.textContent = "✕";
            close.setAttribute("aria-label", "Fechar clipe");
            close.addEventListener("click", () => closeClip(true));
            header.appendChild(title);
            header.appendChild(close);
            dock.appendChild(header);
            document.body.appendChild(dock);
        }
        dock.querySelector("header span").textContent = `${track.title} — ${track.artist}`;

        const oldFrame = dock.querySelector("iframe");
        if (oldFrame) oldFrame.remove();

        const iframe = document.createElement("iframe");
        iframe.src = `https://www.youtube-nocookie.com/embed/${track.id}?autoplay=1&enablejsapi=1` + (start ? `&start=${start}` : "");
        iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
        iframe.allowFullscreen = true;
        iframe.title = `Clipe: ${track.title}`;
        // handshake do widget: o player passa a emitir eventos de estado
        iframe.addEventListener("load", () => {
            iframe.contentWindow.postMessage(JSON.stringify({ event: "listening", id: "clip", channel: "widget" }), "*");
        });
        dock.appendChild(iframe);
    }

    function closeClip(resumeRadio) {
        const dock = document.querySelector(".rpclip-dock");
        if (dock) dock.remove();
        lastClipShownId = null;
        clipPlayingSet.clear();
        if (resumeRadio) resumeRadioAfterClip();
        else clipWasRadioPlaying = false;
    }

    // Sai do modo clipe (persistindo a escolha e atualizando o botão)
    function exitClipMode() {
        if (!clipModeOn()) return;
        localStorage.setItem("clipMode", "0");
        const btn = document.querySelector(".player-button-clip, .rpclip-fab");
        if (btn) btn.classList.remove("is-active");
        closeClip(false);
    }

    function handleClipTrack(res, dataFrom) {
        const yt = (res && (res.youtubeId || res.youtube_id)) || "";
        const np = (res && res.now_playing) || {};
        clipTrack = yt ? {
            id: yt,
            title: dataFrom.title,
            artist: dataFrom.artist,
            elapsed: np.elapsed || 0,
            duration: np.duration || 0,
            receivedAt: Date.now(),
        } : null;

        if (yt) ensureClipButton();
        if (!clipModeOn()) return;

        if (clipTrack) openClip(clipTrack);
        else closeClip(true); // música sem clipe: volta para a rádio
    }

    // Eventos de estado do player do YouTube: pausar o vídeo retoma a
    // rádio; dar play de novo pausa a rádio
    window.addEventListener("message", (event) => {
        let host = "";
        try { host = new URL(event.origin).hostname; } catch (e) { return; }
        if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return;

        let payload;
        try { payload = JSON.parse(event.data); } catch (e) { return; }
        const state = payload && payload.info && typeof payload.info.playerState === "number" ? payload.info.playerState : null;
        if (state === null) return;

        const id = payload.id || "clip";
        if (state === 1) { // tocando
            clipPlayingSet.add(id);
            pauseRadioForClip();
        } else if (state === 2 || state === 0) { // pausado ou terminou
            clipPlayingSet.delete(id);
            if (clipPlayingSet.size === 0) resumeRadioAfterClip();
            // Pausa MANUAL do vídeo (2) = o usuário escolheu o áudio: sai do
            // modo clipe para a troca de música não reabrir o vídeo. Vídeo
            // que TERMINOU (0) mantém o modo — o próximo clipe deve abrir.
            if (state === 2) exitClipMode();
        }
    });

    // --- [MELHORIA 3: LÓGICA DO BOTÃO INSTALAR PWA] -------------------
    let deferredPrompt;
    
    // Ouve o evento do navegador que avisa "Estou pronto para ser instalado!"
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e; // Guarda o evento
        showInstallButton(); // Revela o botão
    });

    function showInstallButton() {
        let installBtn = document.getElementById('install-pwa-btn');
        if (!installBtn) {
            // Insere o botão no menu do topo, ao lado do botão de Histórico
            const headerOptions = document.querySelector('.toggle-options');
            if (headerOptions) {
                installBtn = document.createElement('button');
                installBtn.id = 'install-pwa-btn';
                installBtn.className = 'btn';
                installBtn.innerHTML = icons.download + 'Instalar App';
                
                installBtn.addEventListener('click', () => {
                    // Dispara a pergunta nativa do telemóvel ("Quer adicionar ao ecrã principal?")
                    deferredPrompt.prompt();
                    deferredPrompt.userChoice.then((choiceResult) => {
                        if (choiceResult.outcome === 'accepted') {
                            installBtn.remove(); // Remove o botão depois de instalado com sucesso
                        }
                        deferredPrompt = null;
                    });
                });
                
                // Insere logo no início das opções
                headerOptions.insertBefore(installBtn, headerOptions.firstChild);
            }
        }
    }


    // --- [ATUALIZAÇÃO EM TEMPO REAL: SSE COM FALLBACK PARA POLLING] ---
    //
    // A API padrão (twj.es/stream.php) fala SSE, mas station.api pode
    // apontar para o endpoint JSON de um painel de terceiros (AzuraCast,
    // Shoutcast/Icecast, etc.) que não sabe fazer streaming — só responde
    // uma vez por requisição. Em vez de exigir que cada estação declare
    // manualmente qual transporte usar, tentamos SSE primeiro e, se
    // nenhuma mensagem chegar a tempo (ou a conexão falhar antes de
    // funcionar alguma vez), trocamos sozinhos para consulta periódica
    // (fetch em intervalo fixo, igual ao main_.js antigo).

    async function processNowPlaying(res, server) {
        if (res.error) {
            console.error("Erro na API de now playing:", res.error);
            return;
        }

        const currentData = normalizeTitle(res);
        const title = currentData.title;

        // O songtitle cru é estável entre o evento imediato e o
        // enriquecido (iTunes) que a API envia logo em seguida —
        // comparar o título normalizado processava a música 2x
        const songKey = res.songtitle || title;
        const artKey = res.albumArt || "";
        if (currentSongPlaying === songKey && lastAlbumArt === artKey) {
            return;
        }
        currentSongPlaying = songKey;
        lastAlbumArt = artKey;

        let artist = currentData.artist;
        const art = currentStation.album;
        const cover = currentStation.cover;
        const historyList = normalizeHistory(res);

        if (title && artist) {
            let dataFrom;
            if (res.albumArt) {
                // A API já entrega capa/álbum prontos no payload;
                // refazer a busca no search.php só atrasava a capa
                dataFrom = {
                    title: res.song || title,
                    artist: res.artist || artist,
                    album: res.album || "",
                    thumbnail: res.albumArt,
                    art: res.albumArt,
                    cover: res.albumArt.replace("600x600", "1500x1500"),
                    stream_url: res.streamUrl || "#not-found",
                };
                cache[`${dataFrom.artist} - ${dataFrom.title}`.toLowerCase()] = dataFrom;
            } else {
                dataFrom = await getDataFrom({
                    artist, title, art, cover, server,
                });
            }

            currentSong(dataFrom);
            mediaSession(dataFrom);
            handleClipTrack(res, dataFrom);

            const lyricsKey = `${dataFrom.artist} - ${dataFrom.title}`.toLowerCase();
            if (lyricsKey !== lastLyricsKey) {
                lastLyricsKey = lyricsKey;
                setLyrics(dataFrom.artist, dataFrom.title);
            }

        } else {
            // Áudio não reconhecido pela API (vinheta, spot, ID da rádio, etc.):
            // sem isto a capa/nome da última música ficava "presos" na tela
            // indefinidamente, dando a entender que ainda era a música tocando.
            const fallback = {
                title: currentStation.name,
                artist: currentStation.description || "",
                album: currentStation.name,
                art,
                cover: cover || art,
                stream_url: "#not-found",
            };
            currentSong(fallback);
            mediaSession(fallback);
            // vinheta/spot não tem clipe: fecha o vídeo e volta para a rádio
            handleClipTrack(res, fallback);

            lastLyricsKey = "";
            if (lyricsContent) {
                lyricsContent.innerHTML = "<p>Letra não disponível</p>";
            }
        }

        setHistory(historyList, currentStation, server);
    }

    function stopRealtimeFeed() {
        if (sseFallbackTimer) {
            clearTimeout(sseFallbackTimer);
            sseFallbackTimer = null;
        }
        if (sseConnection) {
            sseConnection.close();
            sseConnection = null;
        }
        if (pollTimeoutId) {
            clearTimeout(pollTimeoutId);
            pollTimeoutId = null;
        }
        // Invalida qualquer fetch em voo do loop antigo: sem isto, o
        // .finally() dele reagendava o polling da estação anterior por
        // cima do novo, e os dois loops ficavam disputando a tela
        pollGeneration++;
    }

    function startPolling(apiUri, server) {
        const myGeneration = ++pollGeneration;
        function poll() {
            fetch(apiUri)
                .then((response) => response.json())
                .then((res) => {
                    if (myGeneration === pollGeneration) {
                        return processNowPlaying(res, server);
                    }
                })
                .catch((error) => console.error("Erro ao consultar a API:", error))
                .finally(() => {
                    if (myGeneration === pollGeneration) {
                        pollTimeoutId = setTimeout(poll, TIME_TO_REFRESH);
                    }
                });
        }
        poll();
    }

    function startSSE(sseUri, pollUri, server) {
        let sseWorked = false;
        sseConnection = new EventSource(sseUri);

        const fallbackToPolling = (reason) => {
            if (sseFallbackTimer) {
                clearTimeout(sseFallbackTimer);
                sseFallbackTimer = null;
            }
            if (sseConnection) {
                sseConnection.close();
                sseConnection = null;
            }
            console.warn(reason);
            startPolling(pollUri, server);
        };

        // Rede de segurança generosa (não é a detecção principal): a API padrão
        // pode legitimamente levar dezenas de segundos até o primeiro push,
        // porque depende do intervalo de metadata ICY do stream de origem.
        // Só existe para o caso raro de o servidor aceitar a conexão e nunca
        // mandar nada, nem erro nem dado.
        sseFallbackTimer = setTimeout(() => {
            if (!sseWorked) {
                fallbackToPolling("SSE não respondeu a tempo, mudando para consulta periódica...");
            }
        }, SSE_FALLBACK_TIMEOUT);

        sseConnection.onmessage = async function (event) {
            sseWorked = true;
            if (sseFallbackTimer) {
                clearTimeout(sseFallbackTimer);
                sseFallbackTimer = null;
            }
            try {
                const res = JSON.parse(event.data);
                await processNowPlaying(res, server);
            } catch (err) {
                console.error("Erro ao processar dados do EventSource:", err);
            }
        };

        sseConnection.onerror = function () {
            // Detecção principal: o navegador só chega a CLOSED (sem tentar
            // reconectar sozinho) quando "falha a conexão" de vez — ex.:
            // Content-Type errado, 404, CORS bloqueado. Isso é sinal forte de
            // que o endpoint não fala SSE de verdade. Um soluço de rede comum
            // deixa o EventSource em CONNECTING, tentando de novo sozinho —
            // nesse caso não trocamos de transporte, só logamos e esperamos.
            if (!sseWorked && sseConnection && sseConnection.readyState === EventSource.CLOSED) {
                fallbackToPolling("Endpoint não parece suportar SSE, mudando para consulta periódica...");
                return;
            }
            console.warn("A conexão em tempo real falhou. A aguardar retorno da rede...");
        };
    }

    // --- [INICIALIZAÇÃO DA APLICAÇÃO] --------------------------------

    function initApp() {
        const json = window.streams || {};
        const stations = json.stations;
        currentStation = stations[0];

        setAssetsInPage(currentStation);
        audio.src = currentStation.stream_url;

        if (playButton !== null) {
            playButton.addEventListener("click", handlePlayPause);
        }

        function init(current) {
            if (currentStation.stream_url !== current.stream_url) {
                currentStation = current;
            }
            const server = currentStation.server || "itunes";
            // Estação com API própria (painel de terceiros): mesma URL para os
            // dois casos, é o único endpoint que ela tem. API padrão (twj.es):
            // SSE e polling são endpoints diferentes de propósito — ver
            // API_URL_POLL acima.
            const sseUri = currentStation.api || API_URL + encodeURIComponent(current.stream_url);
            const pollUri = currentStation.api || API_URL_POLL + encodeURIComponent(current.stream_url);

            stopRealtimeFeed();
            if (SSE_ENABLED) {
                startSSE(sseUri, pollUri, server);
            } else {
                startPolling(pollUri, server);
            }
        }
    
        init(currentStation);
        createStations(stations, currentStation, (station) => {
            init(station);
        });

        // Mantém a faixa de programação em dia sem precisar recarregar a
        // página (independente do TIME_TO_REFRESH, que é sobre metadata de música)
        setInterval(() => {
            if (!currentStation) return;
            renderProgram(currentStation);
            renderProgramacaoList(currentStation);
        }, 30000);

        const nextStation = document.querySelector(".player-button-forward-step");
        const prevStation = document.querySelector(".player-button-backward-step");
        // Só fazem sentido com mais de uma estação configurada — o HTML já
        // vem com hidden por padrão para o caso comum de estação única.
        if (stations.length > 1) {
            if (nextStation) nextStation.hidden = false;
            if (prevStation) prevStation.hidden = false;
        }
        if (nextStation) {
            nextStation.addEventListener("click", () => {
                const next = stationsList.querySelector(".is-active").nextElementSibling;
                if (next) next.click();
            });
        }
        if (prevStation) {
            prevStation.addEventListener("click", () => {
                const prev = stationsList.querySelector(".is-active").previousElementSibling;
                if (prev) prev.click();
            });
        }

        const range = document.querySelector(".player-volume");
        const rangeFill = document.querySelector(".player-range-fill");
        const rangeWrapper = document.querySelector(".player-range-wrapper");
        const rangeThumb = document.querySelector(".player-range-thumb");
        let currentVolume = parseInt(localStorage.getItem("volume") || "100", 10) || 100;
    
        function setRangeWidth(percent) { rangeFill.style.width = `${percent}%`; }
        function setThumbPosition(percent) {
            const compensatedWidth = rangeWrapper.offsetWidth - rangeThumb.offsetWidth;
            const thumbPosition = (percent / 100) * compensatedWidth;
            rangeThumb.style.left = `${thumbPosition}px`;
        }
        function updateVolume(value) {
            range.value = value;
            setRangeWidth(value);
            setThumbPosition(value);
            localStorage.setItem("volume", value);
            audio.volume = value / 100;
        }
    
        if (range !== null) {
            updateVolume(currentVolume);
            range.addEventListener("input", (event) => updateVolume(parseInt(event.target.value, 10)));
            rangeWrapper.addEventListener("mousedown", (event) => {
                const rangeRect = range.getBoundingClientRect();
                const clickX = event.clientX - rangeRect.left;
                const percent = (clickX / range.offsetWidth) * 100;
                const value = Math.round((range.max - range.min) * (percent / 100)) + parseInt(range.min);
                updateVolume(value);
            });
            rangeThumb.addEventListener("mousedown", () => document.addEventListener("mousemove", handleThumbDrag));
        }
    
        function handleThumbDrag(event) {
            const rangeRect = range.getBoundingClientRect();
            const clickX = event.clientX - rangeRect.left;
            let percent = (clickX / range.offsetWidth) * 100;
            percent = Math.max(0, Math.min(100, percent));
            const value = Math.round((range.max - range.min) * (percent / 100)) + parseInt(range.min);
            updateVolume(value);
        }
    
        document.addEventListener("mouseup", () => document.removeEventListener("mousemove", handleThumbDrag));
    }

    // --- [POP-UP DE INÍCIO E HANDLERS] --------------------------------

    const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAA1JREFUGFdj+P//PxcACQYDCF0ysWYAAAAASUVORK5CYII=";
    const historyTemplate = `<div class="history-item flex items-center g-1">
                        <div class="history-image flex-none">
                            <img src="{{art}}" width="80" height="80">
                        </div>
                        <div class="history-meta flex column">
                            <span class="color-title fw-500 truncate-line">{{song}}</span>
                            <span class="color-text">{{artist}}</span>
                        </div>
                        <a href="{{stream_url}}" class="history-spotify" target="_blank" rel="noopener">
                            <svg class="i i-spotify" viewBox="0 0 24 24">
                                <circle cx="12" cy="12" r="11"></circle>
                                <path d="M6 8q7-2 12 1M7 12q5.5-1.5 10 1m-9 3q4.5-1.5 8 1"></path>
                            </svg>
                        </a>
                        </div>`;

    window.addEventListener("DOMContentLoaded", () => {
        document.body.classList.remove("preload");
        let hasClicked = false;
        document.body.addEventListener('click', () => {
            if (!hasClicked && audio.paused) {
                handlePlayPause();
                hasClicked = true;
            }
        });
    });

    initApp();

})();
