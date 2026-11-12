// Gateway and Worker tests: the browser's only server-side code. Offline (fetch is faked).
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { upstreamFor } from "../gateway.mjs";
import worker from "../worker/index.mjs";

const QOR = "qor1knxej2kffzpx9hcfjd54argxj72vs962nw60fg";
const ORIGIN = "https://sealed-disclosure.example";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** One request through the Worker with a fake upstream; returns the response and the upstream URLs it hit. */
async function run(path, init = {}) {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response('{"ok":true}', { headers: { "content-type": "application/json" } }); };
  const assets = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`) };
  const res = await worker.fetch(new Request(ORIGIN + path, init), { ASSETS: assets }, { waitUntil() {} });
  return { res, calls };
}

const TRICKS = [
  "/chain/testnet/rest/cosmos/bank/v1beta1/balances/" + QOR,
  "/chain/testnet/rest/qorechain/pqc/v1/kem/" + QOR + "/../../../../cosmos/gov/v1/proposals",
  "/chain/testnet/rest/qorechain/pqc/v1/kem/%2e%2e/%2e%2e/cosmos/gov/v1/proposals",
  "/chain/testnet/rest/qorechain/pqc/v1/kem/" + QOR + "?x=1",
  "/chain/testnet/rest/qorechain/pqc/v1/kem/" + QOR + "/",
  "/chain/testnet/rest/qorechain/pqc/v1/kem/" + QOR.toUpperCase(),
  "/chain/testnet/rest/qorechain/pqc/v1/kem/qor1bio" + QOR.slice(7),
  "/chain/testnet/rest/qorechain/pqc/v1/params",
  "/chain/testnet/rest//qorechain/pqc/v1/kem/" + QOR,
  "/chain/testnet/rest/@evil.example/qorechain/pqc/v1/kem/" + QOR,
  "/chain/testnet/rpc/broadcast_tx_sync?tx=00",
  "/chain/devnet/rest/qorechain/pqc/v1/kem/" + QOR,
  "/chain/testnet/rest/../../mainnet/rest/cosmos/gov/v1/proposals",
];

describe("read-only gateway", () => {
  it("serves exactly the two key queries the page makes, on both networks", () => {
    assert.equal(upstreamFor(`/chain/testnet/rest/qorechain/pqc/v1/kem/${QOR}`), `https://api-testnet.qore.host/qorechain/pqc/v1/kem/${QOR}`);
    assert.equal(upstreamFor(`/chain/testnet/rest/qorechain/pqc/v1/account/${QOR}`), `https://api-testnet.qore.host/qorechain/pqc/v1/account/${QOR}`);
    assert.equal(upstreamFor(`/chain/mainnet/rest/qorechain/pqc/v1/kem/${QOR}`), `https://api.qore.host/qorechain/pqc/v1/kem/${QOR}`);
  });

  it("refuses every other path, including traversal and query tricks", () => {
    for (const bad of TRICKS) assert.equal(upstreamFor(bad), undefined, bad);
  });
});

describe("Cloudflare Worker", () => {
  it("forwards an allowed GET and nothing else reaches upstream", async () => {
    const { res, calls } = await run(`/chain/testnet/rest/qorechain/pqc/v1/kem/${QOR}`);
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [`https://api-testnet.qore.host/qorechain/pqc/v1/kem/${QOR}`]);
    for (const bad of TRICKS) {
      const r = await run(bad);
      assert.equal(r.res.status, 404, bad);
      assert.equal(r.calls.length, 0, bad);
    }
  });

  it("is GET only", async () => {
    const { res, calls } = await run(`/chain/testnet/rest/qorechain/pqc/v1/kem/${QOR}`, { method: "POST", body: "{}" });
    assert.equal(res.status, 405);
    assert.equal(calls.length, 0);
  });

  it("hands every non-gateway path to the static assets", async () => {
    const { res, calls } = await run("/?inbox=demo");
    assert.equal(await res.text(), "asset /");
    assert.equal(calls.length, 0);
  });
});
