/// <reference path="../online-streaming-provider.d.ts" />
/// <reference path="../../core.d.ts" />

const SEARCH_CACHE_MS = 5 * 60 * 1000;

function remember<T>(key: string, maxAge: number = SEARCH_CACHE_MS): T | undefined {
    if (typeof $store === "undefined" || !$store)
        return undefined;
    try {
        const hit = $store.get<{
            at: number;
            value: T;
        }>(key);
        if (hit && hit.value !== undefined && Date.now() - hit.at < maxAge)
            return hit.value;
    }
    catch (err) {
    }
    return undefined;
}

function keep(key: string, value: any): void {
    if (typeof $store === "undefined" || !$store)
        return;
    try {
        $store.set(key, { at: Date.now(), value });
    }
    catch (err) {
    }
}

const RETRY_BUDGET_MS = 8000;

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SITE_HEADERS: {
    [key: string]: string;
} = {
    "User-Agent": BROWSER_UA,
    "Accept": "*/*",
    "Accept-Language": "es-ES,es;q=0.9",
    "Referer": "https://animeav1.com/",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
};

const PLAIN_HEADERS: {
    [key: string]: string;
} = {
    "User-Agent": BROWSER_UA,
};

async function fetchWithRetry(url: string, retries: number = 2, headers: {
    [key: string]: string;
} = SITE_HEADERS): Promise<FetchResponse> {
    const started = Date.now();
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, { timeout: 15, headers });
            if (res.status >= 500 && attempt < retries && Date.now() - started < RETRY_BUDGET_MS) {
                continue;
            }
            return res;
        }
        catch (err) {
            lastErr = err;
            if (Date.now() - started >= RETRY_BUDGET_MS)
                break;
        }
    }
    throw lastErr ?? new Error(`No se pudo conectar con ${url}`);
}

const GENERIC_WORDS: {
    [word: string]: boolean;
} = {
    season: true, part: true, cour: true, movie: true, special: true,
    ova: true, ona: true, tv: true, the: true, final: true,
};

const normalizedTitles: {
    [value: string]: string;
} = {};

function normalize(value: string): string {
    const cached = normalizedTitles[value];
    if (cached !== undefined)
        return cached;
    return (normalizedTitles[value] = normalizeUncached(value));
}

function normalizeUncached(value: string): string {
    return value
        .toLowerCase()
        .replace(/[áàäâã]/g, "a")
        .replace(/[éèëê]/g, "e")
        .replace(/[íìïî]/g, "i")
        .replace(/[óòöôõ]/g, "o")
        .replace(/[úùüû]/g, "u")
        .replace(/ñ/g, "n")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, "$1")
        .trim();
}

function similarity(candidate: string, wanted: string): number {
    const words = normalize(wanted).split(" ").filter(Boolean);
    const pool = normalize(candidate).split(" ").filter(Boolean);
    if (words.length === 0 || pool.length === 0)
        return 0;
    let hits = 0;
    for (const word of words) {
        const at = pool.indexOf(word);
        if (at !== -1) {
            hits++;
            pool.splice(at, 1);
        }
    }
    return hits / words.length;
}

function balancedScore(candidate: string, wanted: string): number {
    const recall = similarity(candidate, wanted);
    if (recall === 0)
        return 0;
    const precision = similarity(wanted, candidate);
    if (precision === 0)
        return 0;
    return (2 * recall * precision) / (recall + precision);
}

function seasonOrdinal(title: string): number {
    const text = normalize(title);
    const ordinal = text.match(/\b(\d+)(?:st|nd|rd|th)?\s+season\b/);
    if (ordinal)
        return parseInt(ordinal[1], 10);
    const trailing = text.match(/\bseason\s+(\d+)\b/);
    if (trailing)
        return parseInt(trailing[1], 10);
    const roman = text.match(/\s(ii|iii|iv|vi|v)$/);
    if (roman) {
        const map: {
            [key: string]: number;
        } = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
        return map[roman[1]] || 0;
    }
    return 0;
}

function dropOtherSeasons(results: SearchResult[], titles: string[]): SearchResult[] {
    let wanted = 0;
    for (const title of titles) {
        const season = seasonOrdinal(title);
        if (season > wanted)
            wanted = season;
    }
    if (wanted === 0)
        return results;
    const kept = results.filter(r => {
        const season = seasonOrdinal(r.title);
        return season === 0 || season === wanted;
    });
    return kept.length > 0 ? kept : results;
}

function narrowToBest(results: SearchResult[], titles: string[]): SearchResult[] {
    let best: SearchResult | null = null;
    let bestScore = 0;
    let runnerUp = 0;
    for (const result of results) {
        let score = 0;
        for (const title of titles) {
            const value = balancedScore(result.title, title);
            if (value > score)
                score = value;
        }
        if (score > bestScore) {
            runnerUp = bestScore;
            bestScore = score;
            best = result;
        }
        else if (score > runnerUp) {
            runnerUp = score;
        }
    }
    if (best && bestScore >= 0.5 && bestScore - runnerUp >= 0.08)
        return [best];
    return results;
}

function mediaTitles(media?: Media): string[] {
    if (!media)
        return [];
    return usableTitles([media.romajiTitle, media.englishTitle, ...(media.synonyms || [])]);
}

function primaryTitles(media?: Media): string[] {
    if (!media)
        return [];
    return usableTitles([media.romajiTitle, media.englishTitle]);
}

function usableTitles(titles: (string | undefined)[]): string[] {
    return titles.filter((title): title is string => {
        if (typeof title !== "string" || title.trim() === "")
            return false;
        const stripped = title.replace(/\s+/g, "");
        if (stripped.length === 0)
            return false;
        const latin = stripped.replace(/[^a-zA-Z0-9]/g, "").length;
        if (latin / stripped.length < 0.7)
            return false;
        const words = normalize(title).split(" ").filter(Boolean);
        return words.some(w => w.length >= 3 && !GENERIC_WORDS[w]);
    });
}

function bestScore(results: SearchResult[], titles: string[]): number {
    let best = 0;
    for (const result of results) {
        for (const title of titles) {
            const score = similarity(result.title, title);
            if (score > best)
                best = score;
        }
    }
    return best;
}

type ServerOutcome = {
    found?: EpisodeServer;
    error?: string;
    at: number;
};

const SERVER_FAILURE_MS = 20 * 1000;

const SERVER_FOUND_MS = 24 * 60 * 1000;

async function resolveServers(key: string, servers: string[], wanted: string, resolve: (server: string) => Promise<EpisodeServer>): Promise<EpisodeServer> {
    const now = Date.now();
    const held = remember<{
        [server: string]: ServerOutcome;
    }>(key, SERVER_FOUND_MS) || {};
    const usable = (outcome: ServerOutcome | undefined) => !!outcome && now - outcome.at < (outcome.found ? SERVER_FOUND_MS : SERVER_FAILURE_MS);
    let outcome = held[wanted];
    const others: Promise<ServerOutcome>[] = [];
    if (!usable(outcome)) {
        let own: Promise<ServerOutcome> | undefined;
        for (const server of servers.filter(name => !usable(held[name]))) {
            const pending = resolve(server)
                .then((found): ServerOutcome => ({ found, at: Date.now() }), (err): ServerOutcome => ({ error: err instanceof Error ? err.message : String(err), at: Date.now() }))
                .then(settled => {
                const current = remember<{
                    [server: string]: ServerOutcome;
                }>(key, SERVER_FOUND_MS) || {};
                current[server] = settled;
                keep(key, current);
                held[server] = settled;
                return settled;
            });
            if (server === wanted)
                own = pending;
            else
                others.push(pending);
        }
        if (own)
            outcome = await own;
    }
    if (outcome && outcome.found)
        return outcome.found;
    if (outcome) {
        const ready = servers.map(server => held[server]).find(candidate => candidate && candidate.found);
        const alternative = ready && ready.found || await firstFound(others);
        if (alternative) {
            console.error(`AnimeAV1: ${wanted} falló (${outcome.error}), se usa ${alternative.server}`);
            const asked = servers.find(name => name.toUpperCase() === wanted);
            return { ...alternative, server: asked || alternative.server };
        }
    }
    throw new Error(outcome && outcome.error || `Servidor desconocido: ${wanted}`);
}

function firstFound(pending: Promise<ServerOutcome>[]): Promise<EpisodeServer | undefined> {
    return new Promise(done => {
        let left = pending.length;
        if (left === 0)
            done(undefined);
        for (const outcome of pending) {
            outcome.then(settled => {
                if (settled.found)
                    done(settled.found);
                else if (--left === 0)
                    done(undefined);
            });
        }
    });
}

const HLS_HEADERS: {
    [key: string]: string;
} = {
    "Referer": "https://player.zilla-networks.com/",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "User-Agent": BROWSER_UA,
};

const SLOW_HOST_MS = 6000;

const MP4UPLOAD_DOWN_KEY = "av1:mp4upload:down";

const MP4UPLOAD_HEADERS: {
    [key: string]: string;
} = {
    "Referer": "https://www.mp4upload.com/",
    "User-Agent": BROWSER_UA,
};

async function extractMp4Upload(embedUrl: string): Promise<VideoSource | null> {
    if (remember<boolean>(MP4UPLOAD_DOWN_KEY))
        return null;
    const started = Date.now();
    try {
        const res = await fetchWithRetry(embedUrl, 0, MP4UPLOAD_HEADERS);
        if (Date.now() - started >= SLOW_HOST_MS)
            keep(MP4UPLOAD_DOWN_KEY, true);
        if (!res.ok)
            return null;
        const match = res.text().match(/src:\s*"([^"]+\.mp4[^"]*)"/);
        if (!match)
            return null;
        return {
            url: match[1],
            type: "mp4",
            quality: "auto",
            subtitles: [],
        };
    }
    catch (err) {
        keep(MP4UPLOAD_DOWN_KEY, true);
        return null;
    }
}

const PAD_BLOCK_HEX = "10101010101010101010101010101010";

function decryptAesGcm(keyHex: string, ivHex: string, dataHex: string): string {
    if (ivHex.length !== 24 || dataHex.length <= 32)
        return "";
    const key = CryptoJS.enc.Hex.parse(keyHex);
    const body = dataHex.slice(0, -32);
    let plain = "";
    for (let block = 0; block * 32 < body.length; block++) {
        const counter = ivHex + ("0000000" + (block + 2).toString(16)).slice(-8);
        const keystream = CryptoJS.AES.encrypt("", key, {
            iv: CryptoJS.enc.Hex.parse(xorHex(counter, PAD_BLOCK_HEX)),
        }).toString(CryptoJS.enc.Hex);
        plain += xorHex(body.slice(block * 32, block * 32 + 32), keystream);
    }
    return CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Hex.parse(plain));
}

function xorHex(a: string, b: string): string {
    let out = "";
    for (let i = 0; i < a.length; i += 2) {
        const byte = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
        out += (byte < 16 ? "0" : "") + byte.toString(16);
    }
    return out;
}

function base64ToHex(value: string): string {
    return CryptoJS.enc.Hex.stringify(CryptoJS.enc.Base64.parse(padBase64(value)));
}

function padBase64(value: string): string {
    const std = value.replace(/-/g, "+").replace(/_/g, "/");
    return std + "===".slice((std.length + 3) % 4);
}

const VOE_MARKERS = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];

const VOE_MIRROR_KEY = "av1:voe:mirror";

const VOE_MIRROR_MS = 24 * 60 * 60 * 1000;

async function extractVoe(embedUrl: string): Promise<VideoSource[]> {
    try {
        const id = embedUrl.match(/\/e\/([A-Za-z0-9]+)/);
        const mirror = remember<string>(VOE_MIRROR_KEY, VOE_MIRROR_MS);
        if (id && mirror) {
            const html = await fetchWithRetry(`${mirror}/e/${id[1]}`, 0, PLAIN_HEADERS).then(res => res.text(), () => "");
            const sources = voeSources(html);
            if (sources.length > 0)
                return sources;
        }
        let html = (await fetchWithRetry(embedUrl, 1, PLAIN_HEADERS)).text();
        const hop = html.match(/window\.location\.href\s*=\s*'((https?:\/\/[^/']+)[^']*)'/);
        if (hop && html.indexOf("application/json") === -1) {
            html = (await fetchWithRetry(hop[1], 1, PLAIN_HEADERS)).text();
            keep(VOE_MIRROR_KEY, hop[2]);
        }
        return voeSources(html);
    }
    catch (err) {
        console.error("AnimeAV1: Voe no respondió como se esperaba:", err);
    }
    return [];
}

function voeSources(html: string): VideoSource[] {
    try {
        const blob = html.match(/<script type="application\/json">([\s\S]*?)<\/script>/);
        if (!blob)
            return [];
        const packed = JSON.parse(blob[1]);
        const info = JSON.parse(unpackVoe(Array.isArray(packed) ? packed[0] : packed));
        if (info.source)
            return [{ url: info.source, type: "m3u8", quality: "auto", subtitles: [] }];
        if (info.direct_access_url) {
            return [{ url: info.direct_access_url, type: "mp4", quality: "auto", subtitles: [] }];
        }
    }
    catch (err) {
        console.error("AnimeAV1: Voe no respondió como se esperaba:", err);
    }
    return [];
}

function unpackVoe(packed: string): string {
    let text = packed.replace(/[a-zA-Z]/g, c => {
        const base = c <= "Z" ? 65 : 97;
        return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
    });
    for (const marker of VOE_MARKERS)
        text = text.split(marker).join("");
    const shifted = CryptoJS.enc.Latin1.stringify(CryptoJS.enc.Base64.parse(padBase64(text)));
    let reversed = "";
    for (let i = shifted.length - 1; i >= 0; i--)
        reversed += String.fromCharCode(shifted.charCodeAt(i) - 3);
    return CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Base64.parse(padBase64(reversed)));
}

const UPNSHARE_KEY = "kiemtienmua911ca";

const UPNSHARE_IV = "1234567890oiuytr";

async function extractUpnShare(embedUrl: string): Promise<VideoSource[]> {
    const match = embedUrl.match(/^(https?:\/\/[^/#?]+)[^#]*#(.+)$/);
    if (!match)
        return [];
    const api = `${match[1]}/api/v1/video?id=${encodeURIComponent(match[2])}`;
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await fetchWithRetry(api, 1, upnShareHeaders(embedUrl));
            if (!res.ok) {
                console.error(`AnimeAV1: UPNShare respondió ${res.status} para ${match[2]}`);
                return [];
            }
            const plain = CryptoJS.AES.decrypt(CryptoJS.enc.Base64.stringify(CryptoJS.enc.Hex.parse(res.text().trim())), CryptoJS.enc.Utf8.parse(UPNSHARE_KEY), { iv: CryptoJS.enc.Utf8.parse(UPNSHARE_IV) }).toString(CryptoJS.enc.Utf8);
            const url = JSON.parse(plain).cfNative;
            if (url)
                return [{ url, type: "m3u8", quality: "auto", subtitles: [] }];
        }
    }
    catch (err) {
        console.error("AnimeAV1: UPNShare no respondió como se esperaba:", err);
    }
    return [];
}

function upnShareHeaders(embedUrl: string): {
    [key: string]: string;
} {
    const origin = embedUrl.match(/^https?:\/\/[^/#?]+/);
    return {
        "Referer": origin ? `${origin[0]}/` : embedUrl,
        "User-Agent": BROWSER_UA,
    };
}

async function extractByse(embedUrl: string): Promise<VideoSource[]> {
    const match = embedUrl.match(/^(https?:\/\/[^/]+)\/[a-z]\/([A-Za-z0-9]+)/);
    if (!match)
        return [];
    try {
        const res = await fetchWithRetry(`${match[1]}/api/videos/${match[2]}`, 1, PLAIN_HEADERS);
        if (!res.ok)
            return [];
        const playback = res.json().playback;
        if (!playback || !Array.isArray(playback.key_parts))
            return [];
        const plain = decryptAesGcm(byseKeyParts(playback).map((part: string) => base64ToHex(part)).join(""), base64ToHex(playback.iv), base64ToHex(playback.payload));
        if (!plain)
            return [];
        const sources: any[] = (JSON.parse(plain).sources || []).filter((s: any) => s && typeof s.url === "string");
        const found: VideoSource[] = [];
        sources.forEach((s, i) => {
            const quality = s.label || s.height && `${s.height}p` || `auto ${i + 1}`;
            const type = String(s.mime_type || "").indexOf("mpegurl") !== -1 ? "m3u8" : "mp4";
            for (const edge of byseEdgeUrls(s.url))
                found.push({ url: edge.url, type, quality: edge.label ? `${quality} (${edge.label})` : quality, subtitles: [] });
        });
        return found;
    }
    catch (err) {
        console.error("AnimeAV1: Byse no respondió como se esperaba:", err);
    }
    return [];
}

const BYSE_FALLBACK_EDGES = [{ origin: "https://edge1-frankfurt-sprintcdn.owphbf24.com", label: "Frankfurt" }];

function byseEdgeUrls(url: string): {
    url: string;
    label?: string;
}[] {
    const origin = url.match(/^https?:\/\/[^/]+/);
    if (!origin)
        return [{ url }];
    const path = url.slice(origin[0].length);
    return [
        { url },
        ...BYSE_FALLBACK_EDGES
            .filter(edge => edge.origin !== origin[0])
            .map(edge => ({ url: edge.origin + path, label: edge.label })),
    ];
}

function byseKeyParts(playback: {
    key_parts: string[];
    version?: string;
}): string[] {
    const parts = playback.key_parts;
    const version = String(playback.version || "").trim();
    const first = /^\d+$/.test(version) ? parseInt(version, 10) : 0;
    const second = 31 - first;
    if (first < 1 || first > 20 || first > parts.length || second > parts.length)
        return parts;
    return [parts[first - 1], parts[second - 1]];
}

class Provider {
    private baseUrl = "https://animeav1.com";
    getSettings(): Settings {
        return {
            episodeServers: ["HLS", "UPNShare", "Byse", "Voe", "MP4Upload"],
            supportsDub: true,
        };
    }

    private buildAnimeId(slug: string, isDub: boolean): string {
        return JSON.stringify({ slug, type: isDub ? "dub" : "sub" });
    }

    private _resolveRemixData(json: any, isDub: boolean): SearchResult[] {
        if (!json || !json.nodes)
            return [];
        for (const node of json.nodes) {
            if (node && node.uses && node.uses.search_params) {
                const data = node.data;
                if (!data || data.length === 0)
                    continue;
                const rootConfig = data[0];
                if (!rootConfig || typeof rootConfig.results !== "number")
                    continue;
                const animePointers = data[rootConfig.results];
                if (!Array.isArray(animePointers))
                    continue;
                const results: SearchResult[] = [];
                for (const pointer of animePointers) {
                    const rawObj = data[pointer];
                    if (!rawObj)
                        continue;
                    const title = data[rawObj.title];
                    const slug = data[rawObj.slug];
                    if (!title || !slug)
                        continue;
                    results.push({
                        id: this.buildAnimeId(slug, isDub),
                        title,
                        url: `${this.baseUrl}/media/${slug}`,
                        subOrDub: isDub ? "dub" : "sub",
                    });
                }
                return results;
            }
        }
        return [];
    }

    private async searchOnce(query: string, isDub: boolean): Promise<SearchResult[]> {
        const key = `av1:search:${isDub ? "dub" : "sub"}:${normalize(query)}`;
        const cached = remember<SearchResult[]>(key);
        if (cached)
            return cached;
        const params = new URLSearchParams();
        params.append("page", "1");
        if (query && query.trim() !== "")
            params.append("search", query);
        const res = await fetchWithRetry(`${this.baseUrl}/catalogo/__data.json?${params.toString()}`);
        if (!res.ok)
            return [];
        const results = this._resolveRemixData(res.json(), isDub);
        if (results.length > 0)
            keep(key, results);
        return results;
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const isDub = opts.dub || false;
        const titles = mediaTitles(opts.media);
        const primary = primaryTitles(opts.media);
        const narrow = (opts.media && opts.media.format || "").toUpperCase() !== "MOVIE";
        const cacheKey = opts.media && opts.media.id
            ? `av1:media:${opts.media.id}:${isDub ? "dub" : "sub"}`
            : "";
        const cached = cacheKey ? remember<SearchResult[]>(cacheKey) : undefined;
        if (cached)
            return cached;
        try {
            const results = await this.searchOnce(opts.query, isDub);
            if (titles.length === 0)
                return results;
            if (bestScore(results, primary) >= 0.6) {
                const kept = dropOtherSeasons(results, titles);
                const picked = narrow ? narrowToBest(kept, primary) : kept;
                if (cacheKey && picked.length > 0)
                    keep(cacheKey, picked);
                return picked;
            }
            const seen: {
                [id: string]: boolean;
            } = {};
            const merged: SearchResult[] = [];
            for (const result of results) {
                if (seen[result.id])
                    continue;
                seen[result.id] = true;
                merged.push(result);
            }
            const tried = [normalize(opts.query)];
            for (const title of titles.slice(0, 3)) {
                const key = normalize(title);
                if (tried.indexOf(key) !== -1)
                    continue;
                tried.push(key);
                const extra = await this.searchOnce(title, isDub);
                for (const result of extra) {
                    if (seen[result.id])
                        continue;
                    seen[result.id] = true;
                    merged.push(result);
                }
                if (bestScore(merged, primary) >= 0.6)
                    break;
            }
            const kept = dropOtherSeasons(merged, titles);
            const picked = narrow ? narrowToBest(kept, primary) : kept;
            if (cacheKey && picked.length > 0)
                keep(cacheKey, picked);
            return picked;
        }
        catch (err) {
            console.error("Error searching AnimeAV1:", err);
            return [];
        }
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        let slug: string;
        let type: SubOrDub = "sub";
        try {
            const parsed = JSON.parse(id);
            slug = parsed.slug;
            if (parsed.type)
                type = parsed.type;
        }
        catch {
            slug = id;
        }
        const url = `${this.baseUrl}/media/${slug}/__data.json`;
        try {
            const res = await fetchWithRetry(url);
            if (!res.ok)
                throw new Error("Error fetching episodes");
            const json = res.json();
            const nodes = json.nodes || [];
            let data: any[] | null = null;
            let mediaDescriptor: any = null;
            for (const node of nodes) {
                if (!node?.data)
                    continue;
                for (const obj of node.data) {
                    if (obj && typeof obj === "object" && "slug" in obj && "episodes" in obj) {
                        const slugPointer = obj.slug;
                        if (typeof slugPointer === "number" && node.data[slugPointer] === slug) {
                            data = node.data;
                            mediaDescriptor = obj;
                            break;
                        }
                    }
                }
                if (data)
                    break;
            }
            if (!data || !mediaDescriptor)
                throw new Error("Anime no encontrado");
            const episodeIndexes = data[mediaDescriptor.episodes];
            if (!Array.isArray(episodeIndexes))
                throw new Error("Lista inválida");
            const episodes: EpisodeDetails[] = [];
            episodeIndexes.forEach((epIdx: number, i: number) => {
                const ep = data![epIdx];
                if (!ep)
                    return;
                let number = i + 1;
                if (typeof ep.number === "number") {
                    const resolved = data![ep.number];
                    if (typeof resolved === "number")
                        number = resolved;
                }
                if (!Number.isInteger(number) || number <= 0)
                    return;
                let title = `Episodio ${number}`;
                if (typeof ep.title === "number") {
                    title = data![ep.title];
                }
                else if (ep.title) {
                    title = ep.title;
                }
                episodes.push({
                    id: JSON.stringify({ slug, number, type }),
                    number,
                    title,
                    url: `${this.baseUrl}/media/${slug}/${number}`,
                });
            });
            if (type === "dub" && episodes.length > 0 && !(await this.hasDub(slug, episodes[0].number))) {
                console.error(`AnimeAV1: ${slug} no tiene doblaje, se usa el sub`);
                return episodes.map(episode => ({
                    ...episode,
                    id: JSON.stringify({ slug, number: episode.number, type: "sub" }),
                }));
            }
            return episodes;
        }
        catch (err) {
            console.error("Error finding episodes:", err);
            return [];
        }
    }

    private async episodeEmbeds(slug: string, number: number): Promise<{
        data: any[];
        embeds: any;
    } | null> {
        const key = `av1:ep:${slug}:${number}`;
        const cached = remember<{
            data: any[];
            embeds: any;
        }>(key);
        if (cached)
            return cached;
        const res = await fetchWithRetry(`${this.baseUrl}/media/${slug}/${number}/__data.json`);
        if (!res.ok)
            return null;
        const json = res.json();
        for (const node of json?.nodes || []) {
            if (!node?.data)
                continue;
            const root = node.data.find((item: any) => item && typeof item === "object" && "embeds" in item);
            if (root) {
                const found = { data: node.data, embeds: node.data[root.embeds] || {} };
                if (Object.keys(found.embeds).length > 0)
                    keep(key, found);
                return found;
            }
        }
        return null;
    }

    private async audioTracks(slug: string, number: number): Promise<string[]> {
        const found = await this.episodeEmbeds(slug, number);
        return found ? Object.keys(found.embeds) : [];
    }

    private async hasDub(slug: string, number: number): Promise<boolean> {
        const key = `av1:dub:${slug}`;
        const cached = remember<boolean>(key);
        if (cached !== undefined)
            return cached;
        let tracks: string[];
        try {
            tracks = await this.audioTracks(slug, number);
        }
        catch (err) {
            return true;
        }
        if (tracks.length === 0)
            return true;
        const dubbed = tracks.indexOf("DUB") !== -1;
        keep(key, dubbed);
        return dubbed;
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const rawId = typeof episode === "string" ? episode : episode.id;
        let slug: string;
        let number: number;
        let type: SubOrDub = "sub";
        try {
            const parsed = JSON.parse(rawId);
            slug = parsed.slug;
            number = parsed.number;
            if (parsed.type)
                type = parsed.type;
        }
        catch {
            throw new Error("ID inválido");
        }
        await this.episodeEmbeds(slug, number);
        return resolveServers(`av1:servers:${slug}:${number}:${type}`, this.getSettings().episodeServers, server, name => this.resolveServer(slug, number, type, name));
    }

    private async resolveServer(slug: string, number: number, type: SubOrDub, server: string): Promise<EpisodeServer> {
        try {
            const found = await this.episodeEmbeds(slug, number);
            if (!found)
                throw new Error("No se encontraron servidores");
            const data = found.data;
            const embeds = found.embeds;
            const category = type.toUpperCase();
            let listIndex = embeds[category];
            if (typeof listIndex !== "number" && category === "DUB") {
                listIndex = embeds["SUB"];
                if (typeof listIndex === "number") {
                    console.error(`AnimeAV1: ${slug} ${number} sin doblaje, se usa el sub`);
                }
            }
            if (typeof listIndex !== "number")
                throw new Error(`No hay contenido en ${category}`);
            const serverList = data[listIndex];
            if (!Array.isArray(serverList))
                throw new Error("Lista vacía");
            const wanted = (server || "HLS").trim().toUpperCase();
            let embedUrl: string | null = null;
            let serverName: string | null = null;
            for (const ptr of serverList) {
                const entry = data[ptr];
                if (!entry)
                    continue;
                const name = data[entry.server];
                const link = data[entry.url];
                if (!name || !link)
                    continue;
                if (String(name).trim().toUpperCase() === wanted) {
                    embedUrl = link;
                    serverName = name;
                    break;
                }
            }
            if (!embedUrl || !serverName) {
                throw new Error(`No se encontró servidor ${server} para ${type}`);
            }
            let sources: VideoSource[] = [];
            let headers: {
                [key: string]: string;
            } = {};
            if (wanted === "HLS") {
                sources = [{
                        url: embedUrl.replace("/play/", "/m3u8/"),
                        type: "m3u8",
                        quality: "auto",
                        subtitles: [],
                    }];
                headers = HLS_HEADERS;
            }
            else if (wanted === "UPNSHARE") {
                sources = await extractUpnShare(embedUrl);
                headers = upnShareHeaders(embedUrl);
            }
            else if (wanted === "BYSE") {
                sources = await extractByse(embedUrl);
                headers = PLAIN_HEADERS;
            }
            else if (wanted === "VOE") {
                sources = await extractVoe(embedUrl);
                headers = PLAIN_HEADERS;
            }
            else if (wanted === "MP4UPLOAD") {
                const source = await extractMp4Upload(embedUrl);
                if (source)
                    sources = [source];
                headers = MP4UPLOAD_HEADERS;
            }
            if (sources.length === 0)
                throw new Error(`No se pudo extraer el video de ${serverName}`);
            return {
                server: serverName,
                headers,
                videoSources: sources,
            };
        }
        catch (err) {
            console.error("Error finding episode server:", err);
            throw err;
        }
    }
}
