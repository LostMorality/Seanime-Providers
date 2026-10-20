class Provider {
  constructor() {
    this.searchBase = "https://search.animetvplus.site";
    this.siteBase = "https://animetvplus.xyz";
    this.embedBase = "https://embed.animetvplus.site";
    this.streamOrigin = this.embedBase;
  }

  getSettings() {
    return {
      episodeServers: ["AniTVPlus"],
      supportsDub: false,
    };
  }

  async search(query) {
    const url = `${this.searchBase}/v1/search?q=${encodeURIComponent(query.query)}&offset=0&limit=20`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    // Some AniTVPlus endpoints return a useful JSON body with a non-2xx status.
    const payload = await response.json();
    const results = Array.isArray(payload?.data) ? payload.data : [];
    const items = results
      .filter(item => item && item.mal_id != null && item.title)
      .map(item => ({
        id: String(item.mal_id),
        title: String(item.title),
        url: `${this.siteBase}/anime/${encodeURIComponent(item.mal_id)}`,
        subOrDub: "sub",
      }));
    if (!items.length) throw new Error("No anime found");
    return items;
  }

  async findEpisodes(id) {
    const malId = String(id).split(":", 1)[0];
    if (!/^\d+$/.test(malId)) return [];

    // The page may respond with HTTP 404 while still returning its Astro payload.
    const response = await fetch(`${this.siteBase}/anime/${encodeURIComponent(malId)}`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const html = await response.text();
    const card = this.extractInitialCard(html);
    if (!card) throw new Error("AniTVPlus anime data was not found on the page");

    const seasons = Array.isArray(card.seasons) ? card.seasons : [];
    const season = seasons.find(item =>
      String(item?.owner_mal ?? item?.mal_id ?? "") === malId && Array.isArray(item?.episodes)
    )
      || (String(card.selected_season?.owner_mal ?? card.selected_season?.mal_id ?? "") === malId
        ? card.selected_season
        : undefined)
      || card.selected_season
      || seasons.find(item => String(item?.owner_mal ?? item?.mal_id ?? "") === malId)
      || seasons.find(item => item?.is_primary)
      || seasons[0];
    const sourceEpisodes = Array.isArray(season?.episodes) ? season.episodes : [];
    const episodes = sourceEpisodes
      .filter(item => item && item.has_stream !== false && item.stream_ep != null)
      .map(item => {
        const number = Number(item.ep);
        const streamEpisode = Number(item.stream_ep);
        if (!Number.isFinite(number) || !Number.isFinite(streamEpisode)) return null;
        return {
          id: `${malId}:${streamEpisode}`,
          title: item.title ? `Episode ${number}: ${item.title}` : `Episode ${number}`,
          number,
          url: `${this.siteBase}/anime/${encodeURIComponent(malId)}`,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.number - b.number);

    if (!episodes.length) throw new Error("No streamable AniTVPlus episodes found");
    return episodes;
  }

  async findEpisodeServer(episode, _server) {
    const match = String(episode.id || "").match(/^(\d+):(\d+)$/);
    if (!match) throw new Error("Invalid AniTVPlus episode ID");
    const [, malId, streamEpisode] = match;
    const apiUrl = `${this.embedBase}/hls3/uq/${encodeURIComponent(malId)}?episode=${encodeURIComponent(streamEpisode)}`;
    const headers = {
      Accept: "application/json",
      Origin: this.streamOrigin,
      Referer: `${this.embedBase}/hls3/uq/${encodeURIComponent(malId)}?episode=${encodeURIComponent(streamEpisode)}`,
    };
    const response = await fetch(apiUrl, { headers });
    const payload = await response.json();
    if (!payload?.m3u8) throw new Error("AniTVPlus did not return an HLS playlist");

    const playlistUrl = new URL(payload.m3u8, apiUrl).toString();
    let subtitles = [];
    if (payload.meta) {
      try {
        const metaUrl = new URL(payload.meta, apiUrl).toString();
        const metaResponse = await fetch(metaUrl, { headers });
        const meta = await metaResponse.json();
        subtitles = (Array.isArray(meta?.subs) ? meta.subs : [])
          .filter(track => track?.file)
          .map((track, index) => ({
            id: String(track.label || track.lang || `subtitle-${index + 1}`),
            url: new URL(track.file, playlistUrl).toString(),
            language: track.lang || this.languageCode(track.label),
            label: track.label || track.lang || `Subtitle ${index + 1}`,
            isDefault: Boolean(track.default),
          }));
      } catch (error) {
        console.log(`[AniTVPlus] Could not load subtitle metadata: ${error?.message || error}`);
      }
    }

    return {
      server: "AniTVPlus",
      headers: { Origin: this.streamOrigin, Referer: this.streamOrigin },
      videoSources: [{
        url: playlistUrl,
        quality: "auto",
        type: "m3u8",
        headers: { Origin: this.streamOrigin, Referer: this.streamOrigin },
        subtitles,
      }],
    };
  }

  extractInitialCard(html) {
    const match = String(html).match(/<astro-island\b[^>]*\bprops\s*=\s*(["'])([\s\S]*?)\1/i);
    if (!match) return undefined;
    const encodedProps = this.decodeHtmlEntities(match[2]);
    let props;
    try {
      props = JSON.parse(encodedProps);
    } catch (error) {
      throw new Error(`Could not parse AniTVPlus Astro data: ${error?.message || error}`);
    }
    const decoded = this.decodeAstroValue(props);
    return decoded?.initialCrCard || decoded?.initial_cr_card;
  }

  decodeAstroValue(value) {
    if (Array.isArray(value)) {
      if (value.length === 2 && Number.isInteger(value[0])) {
        const [type, payload] = value;
        if (type === 1 && Array.isArray(payload)) return payload.map(item => this.decodeAstroValue(item));
        return this.decodeAstroValue(payload);
      }
      return value.map(item => this.decodeAstroValue(item));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.decodeAstroValue(item)]));
    }
    return value;
  }

  decodeHtmlEntities(value) {
    return String(value)
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;|&#x0*27;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&");
  }

  languageCode(label) {
    const value = String(label || "").trim().toLowerCase();
    if (value === "english") return "en";
    if (value === "japanese") return "ja";
    return value || "und";
  }
}
