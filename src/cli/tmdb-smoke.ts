// Live check against TMDB: imports the three day-1 shows and prints runtimes. Needs ../.env.
import { TmdbClient } from "../tmdb/client.js";

const client = new TmdbClient({ token: process.env.TMDB_READ_ACCESS_TOKEN, apiKey: process.env.TMDB_API_KEY });
for (const name of ["Columbo", "Murder, She Wrote", "Baywatch"]) {
  const show = await client.importShow(name);
  console.log(name, "→", show ? `${show.name} (${show.year}) ${show.runtimeMinutes} min via ${show.runtimeSource}` : "no match");
}
