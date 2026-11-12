// Cloudflare Worker for the hosted demo: the built app (dist/, Workers Static Assets) plus the
// same read-only chain gateway as gateway.mjs, on one origin. GET only, and only the two
// post-quantum key queries the page makes; everything else is a static asset.
//   ./deploy.sh --dry-run     bundle only, nothing uploaded
//   ./deploy.sh               test, build, secret check, deploy
import { upstreamFor } from "../gateway.mjs";

const TIMEOUT_MS = 15_000;
// Key registrations change rarely; a short cache keeps a busy demo off the public REST API.
const TTL = 15;

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
  });

export async function handleChain(request, ctx) {
  // request.url is already parsed by the runtime (dot segments resolved), so the allowlist sees
  // exactly the path that gets forwarded.
  const url = new URL(request.url);
  if (request.method !== "GET") return json(405, { error: "not served by this gateway" }, { allow: "GET" });
  const target = upstreamFor(url.pathname + url.search);
  if (!target) return json(404, { error: "not served by this gateway" });

  const cache = globalThis.caches?.default;
  const key = new Request(target);
  const hit = cache && (await cache.match(key).catch(() => undefined));
  if (hit) return new Response(hit.body, hit);

  let up;
  try {
    up = await fetch(target, {
      headers: { accept: "application/json", "user-agent": "sealed-disclosure-gateway/1" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
  } catch (err) {
    const why = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : String(err?.message ?? err);
    return json(502, { error: `upstream unreachable: ${why}` });
  }
  if (up.status >= 300 && up.status < 400) return json(502, { error: "upstream redirected" });

  const ttl = up.status === 200 ? TTL : 0;
  const res = new Response(up.body, {
    status: up.status,
    headers: {
      "content-type": up.headers.get("content-type") ?? "application/json",
      "cache-control": ttl ? `public, max-age=${ttl}` : "no-store",
      "x-content-type-options": "nosniff",
    },
  });
  if (ttl && cache) ctx?.waitUntil?.(cache.put(key, res.clone()).catch(() => {}));
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/chain" || pathname.startsWith("/chain/")) return handleChain(request, ctx);
    return env.ASSETS.fetch(request);
  },
};
