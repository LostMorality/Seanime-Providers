/// <reference path="../online-streaming-provider.d.ts" />

class Provider {
  constructor() {
    this.siteBase = "https://shonen.to";
    this.sourceBase = `${this.siteBase}/sources/shonen`;
  }

  getSettings() {
    return {
      episodeServers: ["Sub"],
      supportsDub: false,
    };
  }

  async search(options) {
    const query = String(options?.query || "").trim();
    if (!query) return [];

    const searchUrl = new URL("/browse", this.siteBase);
    searchUrl.searchParams.set("q", query);
    const response = await fetch(searchUrl.toString(), {
      headers: { Accept: "text/html" },
    });
    if (!response.ok) throw new Error(`Shonen search failed (HTTP ${response.status})`);

    const html = await response.text();
    const cards = html.match(/<a\b(?=[^>]*\bclass=["'][^"']*\bcard\b[^"']*["'])[^>]*>[\s\S]*?<\/a>/gi) || [];
    const results = [];
    for (const card of cards) {
      const href = card.match(/\bhref=["']([^"']+)["']/i)?.[1];
      const title = card.match(/\btitle=["']([^"']+)["']/i)?.[1]
        || card.match(/<div\b[^>]*class=["'][^"']*\bct\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
      if (!href || !title) continue;
      const url = new URL(href, this.siteBase);
      const id = url.pathname.match(/^\/anime\/(\d+)/)?.[1];
      if (!id) continue;
      const imagePath = card.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
      results.push({
        id,
        title: decodeHtml(title).trim(),
        url: `${this.siteBase}/anime/${id}`,
        image: imagePath ? new URL(imagePath, this.siteBase).toString() : undefined,
        subOrDub: "sub",
      });
    }
    return results;
  }

  async findEpisodes(id) {
    const animeId = String(id || "").match(/^\d+/)?.[0];
    if (!animeId) return [];

    const animeUrl = `${this.siteBase}/anime/${animeId}`;
    const response = await fetch(animeUrl, {
      headers: { Accept: "text/html", Referer: `${this.siteBase}/` },
    });
    if (!response.ok) throw new Error(`Shonen anime page failed (HTTP ${response.status})`);
    const html = await response.text();

    const jsonLdScripts = html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
    for (const script of jsonLdScripts) {
      const content = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "");
      try {
        const structuredData = JSON.parse(decodeHtml(content));
        const graph = Array.isArray(structuredData?.["@graph"]) ? structuredData["@graph"] : [structuredData];
        const series = graph.find((entry) => entry?.["@type"] === "TVSeries");
        const count = Number(series?.numberOfEpisodes);
        if (Number.isInteger(count) && count > 0) return makeEpisodes(animeId, count, this.siteBase);
      } catch {
        // Ignore malformed or unrelated JSON-LD and use the page's episode links below.
      }
    }

    const episodePaths = new Set();
    const episodeAnchors = html.match(/<a\b[^>]*\bhref=["'][^"']*\/watch\/\d+\/[^"']+["'][^>]*>[\s\S]*?<\/a>/gi) || [];
    for (const anchor of episodeAnchors) {
      const href = anchor.match(/\bhref=["']([^"']+)["']/i)?.[1];
      const match = href && new URL(href, this.siteBase).pathname.match(/^\/watch\/(\d+)\/(\d+(?:\.\d+)?)/);
      if (match && match[1] === animeId) episodePaths.add(match[2]);
    }
    return [...episodePaths]
      .map(Number)
      .sort((a, b) => a - b)
      .map((number) => ({
        id: `${animeId}|${number}`,
        number,
        title: `Episode ${number}`,
        url: `${this.siteBase}/watch/${animeId}/${number}`,
      }));
  }

  async findEpisodeServer(episode, server) {
    const [animeId, episodeNumber] = String(episode?.id || "").split("|");
    if (!/^\d+$/.test(animeId || "") || !/^\d+(?:\.\d+)?$/.test(episodeNumber || "")) {
      throw new Error("Invalid Shonen episode identifier.");
    }
    if (/dub/i.test(String(server || ""))) throw new Error("Shonen.to provider only supports subtitles.");

    const sourceUrl = new URL(this.sourceBase);
    sourceUrl.searchParams.set("id", animeId);
    sourceUrl.searchParams.set("episode", episodeNumber);
    sourceUrl.searchParams.set("language", "sub");
    const response = await fetch(sourceUrl.toString(), {
      headers: {
        Accept: "application/json",
        Referer: `${this.siteBase}/watch/${animeId}/${episodeNumber}`,
      },
    });
    if (!response.ok) throw new Error(`Shonen source request failed (HTTP ${response.status})`);

    const payload = await response.json();
    const data = payload?.data;
    if (!data || data.provider !== "shonen") throw new Error("Shonen returned an unexpected source response.");

    const playbackHeaders = { Referer: `${this.siteBase}/` };
    const sourceItems = Array.isArray(data.sources) ? data.sources : [];
    const candidateFiles = [data.source, ...sourceItems.map((item) => item?.file)];
    const seen = new Set();
    const videoSources = candidateFiles
      .filter((file) => typeof file === "string" && /^https?:\/\//i.test(file) && !seen.has(file) && seen.add(file))
      .map((url) => ({
        url,
        type: /\.mp4(?:$|[?#])/i.test(url) ? "mp4" : /\.m3u8(?:$|[?#])/i.test(url) || url.includes("/media/") || url.includes("/api/stream/proxy") ? "m3u8" : "unknown",
        quality: "Auto",
        label: "Sub · Auto",
        headers: { ...playbackHeaders },
        subtitles: [],
      }));

    const tracks = [
      ...(Array.isArray(data.tracks) ? data.tracks : []),
      ...sourceItems.flatMap((item) => Array.isArray(item?.tracks) ? item.tracks : []),
    ];
    const seenTracks = new Set();
    const subtitles = tracks
      .filter((track) => track?.kind === "subtitles" && typeof track.file === "string" && /^https?:\/\//i.test(track.file))
      .filter((track) => !seenTracks.has(track.file) && seenTracks.add(track.file))
      .map((track, index) => ({
        id: `shonen-sub-${index}`,
        url: track.file,
        language: track.label || "Unknown",
        isDefault: track.default === true,
      }));

    if (!videoSources.length) throw new Error("Shonen did not provide a playable stream for this episode.");
    if (subtitles.length) videoSources[0].subtitles = subtitles;
    return { server: "Sub", headers: playbackHeaders, videoSources };
  }
}

function makeEpisodes(animeId, count, siteBase) {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return {
      id: `${animeId}|${number}`,
      number,
      title: `Episode ${number}`,
      url: `${siteBase}/watch/${animeId}/${number}`,
    };
  });
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
