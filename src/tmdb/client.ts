// TMDB supplies what Qloo doesn't: runtimes (slot length), air years and posters.
// This product uses the TMDB API but is not endorsed or certified by TMDB (attribution shown in the UI).

export interface ImportedShow {
  tmdbId: number;
  name: string;
  year?: number;
  runtimeMinutes: number;
  runtimeSource: "show" | "season";
  genres: string[];
  posterPath?: string;
}

interface Options {
  /** TMDB v4 read access token (preferred) or v3 API key. */
  token?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

const BASE = "https://api.themoviedb.org/3";

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
};

export class TmdbClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: Options) {
    if (!opts.token && !opts.apiKey) throw new Error("TMDB credentials missing");
    // Wrapped, not stored bare: Workers throw "Illegal invocation" if fetch is called with `this` = the client.
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  }

  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    else url.searchParams.set("api_key", this.opts.apiKey!);
    const res = await this.fetchFn(url, { headers });
    if (!res.ok) throw new Error(`TMDB ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** `year` (first air year) picks the original over a same-named remake. */
  async importShow(name: string, year?: number): Promise<ImportedShow | null> {
    const search = await this.get<{ results: Array<{ id: number }> }>("/search/tv", {
      query: name,
      ...(year ? { first_air_date_year: String(year) } : {}),
    });
    const hit = search.results[0];
    if (!hit) return null;

    const details = await this.get<{
      id: number;
      name: string;
      first_air_date?: string;
      episode_run_time?: number[];
      genres?: Array<{ name: string }>;
      poster_path?: string;
    }>(`/tv/${hit.id}`);

    let runtimeMinutes: number | undefined;
    let runtimeSource: ImportedShow["runtimeSource"] = "show";
    if (details.episode_run_time?.length) {
      runtimeMinutes = median(details.episode_run_time);
    } else {
      // Show-level runtime is often empty (Columbo: []); season 1 has per-episode runtimes.
      const season = await this.get<{ episodes?: Array<{ runtime: number | null }> }>(`/tv/${hit.id}/season/1`);
      const runtimes = (season.episodes ?? []).map((e) => e.runtime).filter((r): r is number => !!r);
      if (runtimes.length) runtimeMinutes = median(runtimes);
      runtimeSource = "season";
    }
    if (!runtimeMinutes) return null;

    const firstYear = details.first_air_date ? Number(details.first_air_date.slice(0, 4)) : undefined;
    return {
      tmdbId: details.id,
      name: details.name,
      ...(firstYear ? { year: firstYear } : {}),
      runtimeMinutes,
      runtimeSource,
      genres: (details.genres ?? []).map((g) => g.name),
      ...(details.poster_path ? { posterPath: details.poster_path } : {}),
    };
  }
}
