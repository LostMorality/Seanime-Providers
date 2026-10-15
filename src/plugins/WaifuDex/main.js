function init() {
    $ui.register((ctx) => {
        const webview = ctx.newWebview({
            slot: "screen",
            fullWidth: true,
            autoHeight: true,
            sidebar: {
                label: "WaifuDex",
                icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-8-4.7-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6.3-8 11-8 11Z"/><path d="M8 12h8M12 8v8"/></svg>`,
            },
        });

        const posts = ctx.state([]);
        const loading = ctx.state(false);
        const error = ctx.state("");
        const hasMore = ctx.state(true);
        const activeRating = ctx.state("g");
        const activeTags = ctx.state("");

        webview.channel.sync("posts", posts);
        webview.channel.sync("loading", loading);
        webview.channel.sync("error", error);
        webview.channel.sync("hasMore", hasMore);
        webview.channel.sync("activeRating", activeRating);
        webview.channel.sync("activeTags", activeTags);

        const API_BASE = "https://danbooru.donmai.us";
        const PAGE_SIZE = 30;
        const ALLOWED_RATINGS = new Set(["g", "s", "q", "e"]);
        const BLOCKED_AGE_TAGS = new Set(["loli", "shota", "young", "child", "underage", "cub", "ageplay"]);
        let page = 1;
        let queryTags = "";
        let rating = "g";
        let sort = "newest";
        let loadingNow = false;
        let lastRequestAt = 0;

        function sanitizeTags(value) {
            const tokens = String(value || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
            const clean = [];
            for (const token of tokens) {
                if (!/^[a-z0-9_]+$/.test(token)) continue;
                if (token === "1boy" || token === "male" || token === "rating") continue;
                if (BLOCKED_AGE_TAGS.has(token)) continue;
                if (!clean.includes(token)) clean.push(token);
                if (clean.length >= 2) break;
            }
            return clean.join(" ");
        }

        function makeQueryTags(userTags, selectedRating, selectedSort) {
            const tags = ["rating:" + selectedRating];
            if (userTags) tags.push(userTags);
            else tags.push("1girl");
            if (selectedSort === "popular") tags.push("order:score");
            return tags.join(" ");
        }

        function postTagSet(post) {
            const strings = [post.tag_string, post.tag_string_general, post.tag_string_character, post.tag_string_copyright, post.tag_string_artist, post.tag_string_meta];
            return new Set(strings.filter(Boolean).join(" ").toLowerCase().split(/\s+/).filter(Boolean));
        }

        function isGalleryPost(post, selectedRating) {
            const tags = postTagSet(post);
            if (!tags.has("1girl")) return false;
            if ((selectedRating === "q" || selectedRating === "e") && Array.from(BLOCKED_AGE_TAGS).some((tag) => tags.has(tag))) return false;
            return true;
        }

        async function responseDetails(response) {
            try {
                const body = await response.json();
                if (!body || typeof body !== "object") return String(body || "");
                if (body.message) return String(body.message);
                if (body.error) return String(body.error);
                if (Array.isArray(body.errors)) return body.errors.flat().map(String).join("; ");
                return JSON.stringify(body).slice(0, 240);
            } catch (_) {
                return "";
            }
        }

        function setFailure(message) {
            error.set(message || "Could not load posts from Danbooru.");
        }

        async function fetchPosts(append) {
            if (loadingNow) return;
            const now = Date.now();
            if (now - lastRequestAt < 1100) {
                setFailure("Please wait a moment before requesting more posts.");
                return;
            }
            loadingNow = true;
            loading.set(true);
            error.set("");
            if (!append) {
                posts.set([]);
                hasMore.set(true);
                page = 1;
            }
            const requestedPage = page;
            lastRequestAt = now;
            try {
                const params = new URLSearchParams({
                    limit: String(PAGE_SIZE),
                    page: String(requestedPage),
                    tags: makeQueryTags(queryTags, rating, sort),
                });
                const response = await ctx.fetch(API_BASE + "/posts.json?" + params.toString(), {
                    headers: {
                        Accept: "application/json",
                        "User-Agent": "WaifuDex/1.1 (Seanime imageboard plugin)",
                    },
                    timeout: 25,
                });
                if (!response.ok) {
                    if (response.status === 403) throw new Error("Danbooru denied the API request (HTTP 403). The board may be applying an access check or Cloudflare challenge.");
                    if (response.status === 429) throw new Error("Danbooru rate-limited this request. Wait a moment, then retry.");
                    if (response.status === 422 || response.status === 424) {
                        const details = await responseDetails(response);
                        throw new Error("Danbooru rejected the search (HTTP " + response.status + "): " + (details || "Try no more than two tags; rating and sort filters are applied separately."));
                    }
                    throw new Error("Danbooru returned HTTP " + response.status + ".");
                }
                let result;
                try {
                    result = await response.json();
                } catch (_) {
                    throw new Error("Danbooru returned non-JSON data. The board may have served a Cloudflare challenge or maintenance page.");
                }
                if (!Array.isArray(result)) throw new Error("Danbooru returned an unexpected response. Check the board access and API status.");
                const supported = result.filter((post) => post && post.id && post.file_url && ["jpg", "jpeg", "png", "gif", "webp", "avif", "webm", "mp4"].includes(String(post.file_ext || "").toLowerCase()) && isGalleryPost(post, rating));
                const existing = append ? posts.get() : [];
                const ids = new Set(existing.map((post) => String(post.id)));
                const combined = existing.concat(supported.filter((post) => !ids.has(String(post.id))));
                posts.set(combined);
                hasMore.set(result.length >= PAGE_SIZE);
                page = requestedPage + 1;
            } catch (cause) {
                setFailure(cause && cause.message ? cause.message : "Could not connect to Danbooru.");
            } finally {
                loadingNow = false;
                loading.set(false);
            }
        }

        function runSearch(payload) {
            if (loadingNow) {
                setFailure("Wait for the current Danbooru request to finish before changing the search.");
                return;
            }
            const input = payload && typeof payload === "object" ? payload : {};
            const nextTags = sanitizeTags(input.tags);
            const nextRating = ALLOWED_RATINGS.has(String(input.rating || "")) ? String(input.rating) : "g";
            const nextSort = input.sort === "popular" ? "popular" : "newest";
            if (lastRequestAt && Date.now() - lastRequestAt < 1100) {
                setFailure("Please wait a moment before requesting more posts.");
                return;
            }
            queryTags = nextTags;
            rating = nextRating;
            sort = nextSort;
            activeRating.set(rating);
            activeTags.set(queryTags);
            fetchPosts(false);
        }

        webview.channel.on("search", (payload) => runSearch(payload));
        webview.channel.on("load-more", () => { if (hasMore.get()) fetchPosts(true); });
        webview.channel.on("retry", () => fetchPosts(false));

        webview.setContent(() => `
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WaifuDex</title>
  <style>
    :root { color-scheme: dark; --bg:#101118; --panel:#191a24; --line:#ffffff18; --muted:#aaaaba; --accent:#b27cff; --text:#f5f3fa; }
    * { box-sizing:border-box; }
    body { margin:0; padding:clamp(14px,2.4vw,30px); color:var(--text); background:transparent; font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
    .app { max-width:1500px; margin:0 auto; }
    .toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:9px; margin:0 0 12px; padding:13px; border:1px solid var(--line); border-radius:15px; background:#ffffff07; }
    .search { display:flex; flex:1 1 360px; gap:8px; min-width:220px; }
    input,select,button { font:inherit; }
    input,select { min-width:0; border:1px solid #ffffff22; border-radius:10px; padding:10px 12px; color:var(--text); background:#171821; }
    input { flex:1; }
    input::placeholder { color:#8f8e9e; }
    button { border:1px solid #ffffff24; border-radius:10px; padding:10px 13px; color:var(--text); background:#ffffff0b; font-weight:650; cursor:pointer; }
    button:hover { border-color:#ba94ff77; background:#ffffff13; }
    button:disabled { opacity:.55; cursor:default; }
    .primary { border-color:transparent; background:#8056d9; }
    .primary:hover { background:#956de9; }
    .warning { display:none; margin:10px 0; padding:10px 13px; border:1px solid #e7a34b55; border-radius:11px; color:#f5cb8e; background:#b9771815; font-size:12px; }
    .warning.visible { display:block; }
    .tabs { display:flex; gap:7px; margin:12px 0; }
    .tab[aria-selected=true] { border-color:#b27cff77; color:#e6d6ff; background:#9a65fb24; }
    .status { min-height:22px; margin:9px 3px; color:var(--muted); font-size:12px; }
    .status.error { color:#ffaaaa; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,230px),1fr)); gap:14px; align-items:start; }
    .card { position:relative; overflow:hidden; border:1px solid var(--line); border-radius:14px; background:var(--panel); }
    .media { position:relative; display:flex; align-items:center; justify-content:center; width:100%; aspect-ratio:3/4; overflow:hidden; background:#08090d; cursor:zoom-in; }
    .media img,.media video { display:block; width:100%; height:100%; object-fit:contain; }
    .media video { background:#000; }
    .video-load { position:absolute; z-index:2; bottom:12px; left:50%; transform:translateX(-50%); white-space:nowrap; border-color:#ffffff55; background:#171821eF; }
    .video-badge { position:absolute; z-index:2; top:10px; left:10px; padding:5px 8px; border:1px solid #ffffff44; border-radius:999px; color:#fff; background:#171821dd; font-size:10px; font-weight:750; letter-spacing:.06em; pointer-events:none; }
    .media-error { position:absolute; inset:auto 8px 8px; z-index:3; padding:8px; border:1px solid #ffaaaa55; border-radius:8px; color:#ffc2c2; background:#171821ee; font-size:11px; text-align:center; cursor:pointer; }
    .media-loading { position:absolute; top:50%; left:50%; z-index:3; transform:translate(-50%,-50%); padding:9px 12px; border:1px solid #ffffff22; border-radius:9px; color:#e4deee; background:#171821dd; font-size:12px; text-align:center; pointer-events:none; }
    .card-info { display:flex; align-items:center; gap:8px; padding:9px 10px 10px; }
    .post-meta { flex:1; min-width:0; overflow:hidden; color:#b7b4c3; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
    .rating-chip { padding:3px 7px; border:1px solid #ffffff20; border-radius:999px; color:#dedbe7; font-size:10px; text-transform:uppercase; }
    .rating-e { border-color:#e8707a66; color:#ff9ea4; }
    .rating-q { border-color:#e6ab5c66; color:#ffd18b; }
    .rating-s { border-color:#bd9af566; color:#dbbfff; }
    .fav { flex:none; padding:5px 8px; border-radius:8px; color:#ddd; line-height:1; }
    .fav[aria-pressed=true] { color:#ff79b8; }
    .post-link { display:block; width:calc(100% - 20px); margin:0 10px 10px; border:0; padding:0; color:#c8aaff; background:transparent; font-size:11px; text-align:left; }
    .post-link:hover { color:#dfceff; background:transparent; text-decoration:underline; }
    .empty { padding:50px 20px; border:1px dashed #ffffff24; border-radius:14px; color:var(--muted); text-align:center; }
    .footer { display:flex; justify-content:center; padding:18px 0 8px; }
    .hidden { display:none !important; }
    html.viewer-open,body.viewer-open { height:100%; overflow:hidden !important; overscroll-behavior:none; }
    .viewer { position:fixed; inset:0; z-index:99999; display:block; width:100vw; height:100vh; height:100dvh; overflow:hidden; padding:0; background:#050509; }
    .viewer-panel { position:absolute; inset:0; width:100%; height:100%; overflow:hidden; border:0; border-radius:0; background:#050509; }
    .viewer-toolbar { position:absolute; z-index:2; top:0; left:0; right:0; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; border:0; background:linear-gradient(#050509dd,#05050900); }
    .viewer-nav { display:flex; align-items:center; gap:7px; }
    .viewer-media { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; width:100%; height:100%; overflow:hidden; background:#050509; }
    .viewer-media img,.viewer-media video { display:block; width:100%; height:100%; max-width:100%; max-height:100%; object-fit:contain; }
    .viewer-media video { width:100%; height:100%; }
    .viewer-caption { position:absolute; z-index:2; left:0; right:0; bottom:0; padding:14px 16px; border:0; color:#f0edf7; background:linear-gradient(#05050900,#050509dd); font-size:13px; pointer-events:none; }
    @media(max-width:600px) { .viewer-toolbar { padding:8px; } .viewer-caption { padding:12px 10px; } }
    @media(max-width:600px) { .toolbar { padding:10px; } .grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; } .media { aspect-ratio:2/3; } .card-info { padding:7px; gap:5px; } .post-meta { font-size:10px; } .fav { padding:4px 6px; } }
  </style>
</head>
<body>
  <main class="app">
    <form class="toolbar" id="search-form">
      <div class="search"><input id="tags" type="search" maxlength="160" placeholder="Up to 2 tags or character names (e.g. hatsune_miku)" aria-label="Search Danbooru tags"><button class="primary" type="submit">Search</button></div>
      <select id="rating" aria-label="Content rating">
        <option value="g">General · SFW</option>
        <option value="s">Sensitive</option>
        <option value="q">Questionable · NSFW</option>
        <option value="e">Explicit · NSFW</option>
      </select>
      <select id="sort" aria-label="Sort posts"><option value="newest">Newest</option><option value="popular">Popular</option></select>
    </form>
    <div class="warning" id="adult-warning" role="note">Mature-content rating selected. Explicit media may be unsuitable for minors or public viewing. Results open only after you choose this rating.</div>
    <nav class="tabs" aria-label="Gallery views"><button class="tab" type="button" data-view="browse" aria-selected="true">Browse</button><button class="tab" type="button" data-view="favorites" aria-selected="false">Favorites</button></nav>
    <div id="status" class="status" role="status" aria-live="polite">Loading Danbooru posts…</div>
    <section id="grid" class="grid" aria-label="Danbooru posts"></section>
    <div class="footer" id="footer"><button id="load-more" type="button">Load more</button></div>
    <div id="viewer" class="viewer hidden" role="dialog" aria-modal="true" aria-label="WaifuDex media viewer">
      <div class="viewer-panel">
        <div class="viewer-toolbar"><span id="viewer-count"></span><div class="viewer-nav"><button id="viewer-prev" type="button" aria-label="Previous post">←</button><button id="viewer-next" type="button" aria-label="Next post">→</button><button id="viewer-close" type="button">Close</button></div></div>
        <div id="viewer-media" class="viewer-media"></div>
        <div id="viewer-caption" class="viewer-caption"></div>
      </div>
    </div>
  </main>
  <script>
    const $ = (selector) => document.querySelector(selector);
    const grid = $("#grid");
    const status = $("#status");
    const loadMore = $("#load-more");
    const form = $("#search-form");
    const tagsInput = $("#tags");
    const ratingInput = $("#rating");
    const sortInput = $("#sort");
    const warning = $("#adult-warning");
    const viewerRoot = $("#viewer");
    const viewerMedia = $("#viewer-media");
    const viewerCount = $("#viewer-count");
    const viewerCaption = $("#viewer-caption");
    const viewerPrev = $("#viewer-prev");
    const viewerNext = $("#viewer-next");
    const viewerClose = $("#viewer-close");
    const STORAGE_KEY = "seanime-waifudex-danbooru-favorites-v1";
    let currentPosts = [];
    let isLoading = true;
    let currentError = "";
    let canLoadMore = true;
    let currentRating = "g";
    let currentTags = "";
    let view = "browse";
    let favorites = readFavorites();
    let viewerPosts = [];
    let viewerIndex = -1;

    function readFavorites() {
      try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); return Array.isArray(value) ? value : []; }
      catch (_) { return []; }
    }
    function saveFavorites() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites)); } catch (_) {} }
    function safeMediaUrl(value) {
      try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "donmai.us" || url.hostname.endsWith(".donmai.us")) ? url.href : ""; }
      catch (_) { return ""; }
    }
    const mediaObjectUrls = new Map();
    const pendingMediaFetches = new Map();
    const DANBOORU_REFERRER = "https://danbooru.donmai.us/";
    function danbooruProxyUrl(value, endpoint, includeUserAgent) {
      const target = safeMediaUrl(value);
      if (!target) return "";
      const proxy = new URL("http://localhost:43211/api/v1/" + endpoint);
      proxy.searchParams.set("url", target);
      const headers = includeUserAgent
        ? { "User-Agent": "curl/8.10.1", Referer: DANBOORU_REFERRER }
        : { Referer: DANBOORU_REFERRER };
      proxy.searchParams.set("headers", JSON.stringify(headers));
      return proxy.href;
    }
    function danbooruImageProxyUrl(value) { return danbooruProxyUrl(value, "image-proxy"); }
    function setProxiedImage(image, sourceUrl) {
      const proxyUrl = danbooruImageProxyUrl(sourceUrl);
      if (!proxyUrl) return;
      image.style.width = "100%";
      image.style.height = "100%";
      const indicator = document.createElement("span");
      indicator.className = "media-loading";
      indicator.textContent = "Loading image…";
      image.parentElement.appendChild(indicator);
      image.addEventListener("load", () => indicator.remove(), { once: true });
      image.addEventListener("error", () => {
        if (!image.isConnected) return;
        indicator.className = "media-error";
        indicator.textContent = "Image proxy failed at localhost:43211";
      }, { once: true });
      image.src = proxyUrl;
    }
    async function fetchDanbooruMedia(url) {
      if (mediaObjectUrls.has(url)) return mediaObjectUrls.get(url);
      if (pendingMediaFetches.has(url)) return pendingMediaFetches.get(url);
      const proxyUrl = danbooruProxyUrl(url, "proxy", true);
      if (!proxyUrl) throw new Error("Invalid Danbooru media URL");
      const request = fetch(proxyUrl, { method: "GET", mode: "cors", credentials: "omit" }).then(async (response) => {
        if (!response.ok) throw new Error("Local media proxy returned HTTP " + response.status);
        const objectUrl = URL.createObjectURL(await response.blob());
        mediaObjectUrls.set(url, objectUrl);
        while (mediaObjectUrls.size > 80) {
          const oldest = mediaObjectUrls.entries().next().value;
          if (!oldest) break;
          mediaObjectUrls.delete(oldest[0]);
          URL.revokeObjectURL(oldest[1]);
        }
        return objectUrl;
      }).finally(() => pendingMediaFetches.delete(url));
      pendingMediaFetches.set(url, request);
      return request;
    }
    function tagLabel(post) {
      const names = String(post.tag_string_character || "").split(/\s+/).filter(Boolean).slice(0, 3);
      if (names.length) return names.map((tag) => tag.replace(/_/g, " ")).join(", ");
      const artist = String(post.tag_string_artist || "").split(/\s+/).filter(Boolean)[0];
      return artist ? artist.replace(/_/g, " ") : "Danbooru post #" + post.id;
    }
    function isFavorite(post) { return favorites.some((item) => String(item.id) === String(post.id)); }
    function setMessage(text, isError) { status.textContent = text || ""; status.classList.toggle("error", Boolean(isError)); }
    function toggleFavorite(post) {
      favorites = isFavorite(post) ? favorites.filter((item) => String(item.id) !== String(post.id)) : [post, ...favorites].slice(0, 400);
      saveFavorites(); render();
    }
    function renderViewer() {
      const post = viewerPosts[viewerIndex];
      if (!post) return;
      viewerMedia.replaceChildren();
      const ext = String(post.file_ext || "").toLowerCase();
      const fullUrl = safeMediaUrl(post.file_url || post.large_file_url || post.preview_file_url);
      const posterUrl = safeMediaUrl(post.preview_file_url || post.large_file_url);
      viewerCount.textContent = (viewerIndex + 1) + " / " + viewerPosts.length;
      viewerPrev.disabled = viewerIndex <= 0;
      viewerNext.disabled = viewerIndex >= viewerPosts.length - 1;
      const ratingName = ({g:"General / SFW",s:"Sensitive",q:"Questionable / NSFW",e:"Explicit / NSFW"})[post.rating] || String(post.rating || "unrated");
      viewerCaption.textContent = "#" + post.id + " · " + tagLabel(post) + " · " + ratingName + " · score " + Number(post.score || 0);
      if (["webm", "mp4"].includes(ext) && fullUrl) {
        const poster = document.createElement("img");
        poster.alt = tagLabel(post);
        viewerMedia.appendChild(poster);
        if (posterUrl) setProxiedImage(poster, posterUrl);
        const video = document.createElement("video");
        video.className = "hidden"; video.controls = true; video.playsInline = true; video.preload = "none";
        video.setAttribute("aria-label", "Video post " + post.id);
        const loadButton = document.createElement("button");
        loadButton.className = "video-load"; loadButton.type = "button"; loadButton.textContent = "Loading video…"; loadButton.disabled = true;
        const startVideoLoad = async () => {
          if (loadButton.dataset.loading === "true") return;
          loadButton.dataset.loading = "true";
          loadButton.disabled = true; loadButton.textContent = "Loading video…";
          try {
            video.src = await fetchDanbooruMedia(fullUrl);
            if (!video.isConnected) return;
            video.load();
            video.classList.remove("hidden"); poster.classList.add("hidden"); loadButton.remove();
            video.play().catch(() => {});
          } catch (cause) {
            loadButton.dataset.loading = "";
            loadButton.disabled = false; loadButton.textContent = "Video blocked · retry";
            loadButton.title = cause && cause.message ? cause.message : "CDN request failed";
          }
        };
        loadButton.addEventListener("click", startVideoLoad);
        viewerMedia.append(poster, video, loadButton);
        startVideoLoad();
      } else if (fullUrl) {
        const image = document.createElement("img");
        image.alt = tagLabel(post);
        viewerMedia.appendChild(image);
        setProxiedImage(image, fullUrl);
      }
    }
    let viewerOpener = null;
    let viewerOpenerScrollY = 0;
    function openViewer(post) {
      const source = view === "favorites" ? favorites : currentPosts;
      viewerPosts = source.slice();
      viewerIndex = viewerPosts.findIndex((item) => String(item.id) === String(post.id));
      if (viewerIndex < 0) { viewerPosts = [post]; viewerIndex = 0; }
      viewerOpener = document.activeElement;
      viewerOpenerScrollY = window.scrollY || document.documentElement.scrollTop || 0;
      document.documentElement.classList.add("viewer-open");
      viewerRoot.classList.remove("hidden");
      document.body.classList.add("viewer-open");
      renderViewer();
      viewerClose.focus();
    }
    function closeViewer() {
      viewerRoot.classList.add("hidden");
      document.body.classList.remove("viewer-open");
      document.documentElement.classList.remove("viewer-open");
      viewerMedia.replaceChildren();
      window.scrollTo(0, viewerOpenerScrollY);
      if (viewerOpener && typeof viewerOpener.focus === "function") {
        try { viewerOpener.focus({ preventScroll: true }); } catch (_) { viewerOpener.focus(); }
      }
    }
    function moveViewer(delta) {
      const nextIndex = viewerIndex + delta;
      if (nextIndex < 0 || nextIndex >= viewerPosts.length) return;
      viewerIndex = nextIndex;
      renderViewer();
    }
    function createCard(post) {
      const card = document.createElement("article"); card.className = "card";
      const media = document.createElement("div"); media.className = "media";
      const ext = String(post.file_ext || "").toLowerCase();
      const fullUrl = safeMediaUrl(post.file_url || post.large_file_url);
      const previewUrl = safeMediaUrl(post.preview_file_url || post.large_file_url || post.file_url);
      const galleryUrl = safeMediaUrl(post.large_file_url || post.file_url || post.preview_file_url);
      if (fullUrl && ["webm", "mp4"].includes(ext)) {
        const poster = document.createElement("img"); poster.className = "video-poster"; poster.alt = tagLabel(post); poster.loading = "lazy";
        media.appendChild(poster);
        if (previewUrl) setProxiedImage(poster, previewUrl);
        const badge = document.createElement("span"); badge.className = "video-badge"; badge.textContent = "▶ VIDEO"; media.appendChild(badge);
      } else if (fullUrl && ["jpg", "jpeg", "png", "gif", "webp", "avif"].includes(ext)) {
        const image = document.createElement("img"); image.alt = tagLabel(post); image.loading = "lazy";
        media.appendChild(image); setProxiedImage(image, galleryUrl || previewUrl || fullUrl);
      } else {
        media.classList.add("empty"); media.textContent = "Media preview unavailable";
      }
      media.addEventListener("click", () => openViewer(post));
      const info = document.createElement("div"); info.className = "card-info";
      const meta = document.createElement("span"); meta.className = "post-meta"; meta.textContent = "#" + post.id + " · " + tagLabel(post) + " · score " + Number(post.score || 0); meta.title = tagLabel(post);
      const rating = document.createElement("span"); rating.className = "rating-chip rating-" + String(post.rating || "g"); rating.textContent = String(post.rating || "g"); rating.title = "Danbooru rating";
      const fav = document.createElement("button"); fav.className = "fav"; fav.type = "button"; fav.textContent = isFavorite(post) ? "♥" : "♡"; fav.setAttribute("aria-pressed", String(isFavorite(post))); fav.setAttribute("aria-label", isFavorite(post) ? "Remove from favorites" : "Add to favorites"); fav.addEventListener("click", () => toggleFavorite(post));
      info.append(meta, rating, fav);
      const open = document.createElement("button"); open.className = "post-link"; open.type = "button"; open.textContent = ["webm", "mp4"].includes(ext) ? "Play video in viewer" : "Open in viewer"; open.addEventListener("click", () => openViewer(post));
      card.append(media, info, open); return card;
    }
    function render() {
      warning.classList.toggle("visible", currentRating === "q" || currentRating === "e");
      loadMore.disabled = isLoading || !canLoadMore;
      loadMore.textContent = isLoading ? "Loading…" : (canLoadMore ? "Load more" : "No more posts");
      loadMore.classList.toggle("hidden", view === "favorites");
      const shown = view === "favorites" ? favorites : currentPosts;
      grid.replaceChildren();
      if (!shown.length) {
        const empty = document.createElement("div"); empty.className = "empty";
        empty.textContent = currentError ? "Danbooru could not be reached. " + currentError : (view === "favorites" ? "No favorites saved yet. Use the heart on a post to save it." : (isLoading ? "Loading posts…" : "No posts found for these tags and rating. Try different tags."));
        grid.appendChild(empty);
      } else {
        const fragment = document.createDocumentFragment(); shown.forEach((post) => fragment.appendChild(createCard(post))); grid.appendChild(fragment);
      }
      if (currentError && shown.length) setMessage("Could not refresh: " + currentError + " Showing existing posts.", true);
      else if (view === "favorites") setMessage(favorites.length + " saved post" + (favorites.length === 1 ? "" : "s"), false);
      else if (isLoading) setMessage("Loading from Danbooru…", false);
      else if (currentError) setMessage(currentError, true);
      else setMessage(currentPosts.length + " post" + (currentPosts.length === 1 ? "" : "s") + " · " + ({g:"General / SFW",s:"Sensitive",q:"Questionable / NSFW",e:"Explicit / NSFW"}[currentRating] || "General") + (currentTags ? " · tags: " + currentTags : " · tag: 1girl"), false);
    }
    function submitSearch(event) { if (event) event.preventDefault(); view = "browse"; updateTabs(); window.webview && window.webview.send("search", { tags: tagsInput.value, rating: ratingInput.value, sort: sortInput.value }); }
    function updateTabs() { document.querySelectorAll(".tab").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.view === view))); }
    viewerClose.addEventListener("click", closeViewer);
    viewerPrev.addEventListener("click", () => moveViewer(-1));
    viewerNext.addEventListener("click", () => moveViewer(1));
    viewerRoot.addEventListener("click", (event) => { if (event.target === viewerRoot) closeViewer(); });
    document.addEventListener("keydown", (event) => {
      if (viewerRoot.classList.contains("hidden")) return;
      if (event.key === "Escape") closeViewer();
      else if (event.key === "ArrowLeft") moveViewer(-1);
      else if (event.key === "ArrowRight") moveViewer(1);
    });
    form.addEventListener("submit", submitSearch);
    ratingInput.addEventListener("change", submitSearch);
    sortInput.addEventListener("change", submitSearch);
    loadMore.addEventListener("click", () => window.webview && window.webview.send("load-more"));
    document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => { view = button.dataset.view; updateTabs(); render(); }));
    if (window.webview) {
      window.webview.on("posts", (value) => { currentPosts = Array.isArray(value) ? value : []; render(); });
      window.webview.on("loading", (value) => { isLoading = Boolean(value); render(); });
      window.webview.on("error", (value) => { currentError = String(value || ""); render(); });
      window.webview.on("hasMore", (value) => { canLoadMore = Boolean(value); render(); });
      window.webview.on("activeRating", (value) => { currentRating = String(value || "g"); ratingInput.value = currentRating; render(); });
      window.webview.on("activeTags", (value) => { currentTags = String(value || ""); if (currentTags) tagsInput.value = currentTags; render(); });
      window.webview.send("search", { tags: "", rating: "g", sort: "newest" });
    }
  </script>
</body>
</html>
`);
    });
}
