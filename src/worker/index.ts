// Cloudflare entry: static assets serve the UI; /api/* goes to the single Coordinator Durable Object.

import { CLIENT_IP_HEADER } from "./coordinator.js";

export { Coordinator } from "./coordinator.js";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    // Rate limits key on the connecting IP as Cloudflare saw it, never on a header the client chose.
    const headers = new Headers(request.headers);
    headers.set(CLIENT_IP_HEADER, request.headers.get("cf-connecting-ip") ?? "unknown");
    return env.COORDINATOR.getByName("global").fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
