// Same-origin, read-only gateway to the QoreChain REST API, which sends no CORS headers.
// GET only, and only the post-quantum key queries the page makes (KEM key, ML-DSA key).
// The EVM JSON-RPC allows any origin, so the page talks to it directly.
// Used by vite.config.ts (dev + preview) and server.mjs (production).

export const UPSTREAMS = {
  testnet: "https://api-testnet.qore.host",
  mainnet: "https://api.qore.host",
};

const REST_ALLOW = /^\/qorechain\/pqc\/v1\/(kem|account)\/qor1[02-9ac-hj-np-z]{38,58}$/;
const PREFIX = /^\/chain\/(testnet|mainnet)\/rest(\/[^?#]*)$/;

/** Map `/chain/<net>/rest/<path>` to an upstream URL, or undefined if it is not served. */
export function upstreamFor(url) {
  const m = PREFIX.exec(url ?? "");
  if (!m) return undefined;
  const [, net, path] = m;
  return REST_ALLOW.test(path) ? UPSTREAMS[net] + path : undefined;
}

/** Connect-style middleware: `(req, res, next)`. */
export function gatewayMiddleware() {
  const fail = (res, status, error, extra = {}) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    res.end(JSON.stringify({ error }));
  };
  return async (req, res, next) => {
    if (!req.url?.startsWith("/chain/")) return next();
    if (req.method !== "GET") return fail(res, 405, "not served by this gateway", { allow: "GET" });
    const target = upstreamFor(req.url);
    if (!target) return fail(res, 404, "not served by this gateway");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    try {
      const up = await fetch(target, { signal: ctl.signal, redirect: "error", headers: { accept: "application/json", "user-agent": "sealed-disclosure-gateway/1" } });
      res.statusCode = up.status;
      res.setHeader("content-type", up.headers.get("content-type") ?? "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(Buffer.from(await up.arrayBuffer()));
    } catch (err) {
      fail(res, 502, `upstream unreachable: ${err?.name === "AbortError" ? "timeout" : err?.message}`);
    } finally {
      clearTimeout(timer);
    }
  };
}
