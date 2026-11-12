# Sealed Disclosure

[![CI](https://github.com/apeirs/sealed-disclosure/actions/workflows/ci.yml/badge.svg)](https://github.com/apeirs/sealed-disclosure/actions/workflows/ci.yml)

Post-quantum vulnerability disclosure for QoreChain projects: a report is encrypted in the reporter's browser to the
project's registered ML-KEM-1024 key, dropped into an on-chain inbox that checks the reporter's ML-DSA-87 signature,
and opened only by the project, in its own browser. The inbox records who reported first.

**Live demo: https://sealed-disclosure.apeir.workers.dev** ·
[Demo video](https://github.com/apeirs/sealed-disclosure/releases/download/v0.1.0/sealed-disclosure-demo.mp4) ·
`SealedInbox` on QoreChain testnet: [`0x56b6706d009db5357ee076e62c7c7e317e45c353`](https://explore.qore.network/address/0x56b6706d009db5357ee076e62c7c7e317e45c353)
(Category: Encrypted Apps)

![Sealed Disclosure](docs/featured.png)

## Try it in two minutes

1. **Open a real inbox, decrypt in your browser:**
   [`?inbox=demo&key=demo`](https://sealed-disclosure.apeir.workers.dev/?inbox=demo&key=demo). The page lists the
   testnet demo project's drops straight from the contract, loads the demo project's seal key and opens them in the
   tab: #0 and #2 open; **#1 is refused** because it is a copy of #0 that a second account dropped under its own
   name (see [threat model](#threat-model)).
2. **Check a recipient and seal a report:**
   [`?project=demo`](https://sealed-disclosure.apeir.workers.dev/?project=demo) reads the project's ML-KEM-1024 key
   from the chain's KEM registry and its ML-DSA-87 key from the PQC module, and verifies its signed recipient card
   (3 checks). Write a report and press "Seal in this browser": the envelope is built in the page and offered as a
   download; nothing is sent anywhere.
3. **Confirm it on chain:** the [drop](https://explore.qore.network/tx/0x915ef838efdaeee4749fa70764dc7385da2f93bebc51b57dedc59dd21c3c1aa4),
   the [project's signed receipt](https://explore.qore.network/tx/0xf1826ed8d2386cd445157546f03fe1b20e3c19660ad1fe133ba313713e00e73a)
   and the [copied drop](https://explore.qore.network/tx/0x5666716a8be51fdca5a8f9b22803561ed403faaf1e0ae89ac9422fad38b2f63e).
   The explorer opens on mainnet: switch it to Testnet. `npm run verify:deployment` shows the deployed bytecode is
   exactly the compiled [`contracts/SealedInbox.sol`](contracts/SealedInbox.sol)
   ([output](docs/e2e/verify-deployment.txt)).
4. **Run the tests:** `npm ci && npm test` (20 offline tests, a few seconds). The live checks are in
   [End-to-end checks](#end-to-end-checks-against-the-live-inbox).

## Encrypted Apps requirements: where to find each one

| Requirement | Where |
| --- | --- |
| **ML-KEM-1024 encryption** | Reports are sealed with QoreSeal's hybrid envelope (ML-KEM-1024 + X25519, AES-256-GCM): `sealReport` in [`src/core/inbox.ts`](src/core/inbox.ts), from the browser ([`src/App.tsx`](src/App.tsx), "Seal in this browser") and the CLI (`sd seal`, `sd report`). Test: "only the recipient opens it, and only under the true sender" in [`test/protocol.test.ts`](test/protocol.test.ts). Envelopes on chain: drops [#0](https://explore.qore.network/tx/0x915ef838efdaeee4749fa70764dc7385da2f93bebc51b57dedc59dd21c3c1aa4) (2,245 bytes) and [#2](https://explore.qore.network/tx/0x7a4dbef7ad85c22aa6eb760b4fd6389b3b6a496152b07c1dee03ad7464fb2d73) (2,087 bytes, sealed in the browser) |
| **Registered recipient keys** | The project registers its ML-KEM-1024 key in the chain's KEM key registry with a hybrid-signed `MsgRegisterKEMKey` (`ensureKemKey` in [`src/cli/account.ts`](src/cli/account.ts); tx [`CA2E5552…5726`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/CA2E5552977ADFBFBDE67116BCAADE93B8300E97C249220FE67DDEA2571E5726)). Senders seal only to the key read from the registry (`fetchKemKey` in `resolveProject`, [`src/core/inbox.ts`](src/core/inbox.ts)); the page and `sd check` show it as the first check and refuse to seal without it (test: "refuses to seal to a project that failed its checks") |
| **ML-DSA key binding** | Three bindings, each checked against the ML-DSA-87 key registered with proof of possession: (1) the recipient card that names the project's ML-KEM-1024 and X25519 keys is signed by its ML-DSA-87 key, checked on chain by `publishCard` (PQC Verify precompile `0x0a01`, key from PQC Key Status `0x0a02`) and again by the sender against the registry key (tests: "a card does not verify against another account's keys", on-chain `BadSignature`/`BadCard`/`NotNewer` in [`docs/e2e/negative.txt`](docs/e2e/negative.txt)); (2) every drop is signed by the reporter's ML-DSA-87 key over a statement naming the chain, inbox, both accounts and the envelope's SHA-256, rebuilt and checked by `SealedInbox.drop`; (3) the project's receipt is signed the same way (`acknowledge`). Card tx [`0x352d7b11…`](https://explore.qore.network/tx/0x352d7b1176472960105eb552bfb110236fcb0b0322dbaa6701ff6101edf6c4f8); ML-DSA-87 registrations [`C57C78EA…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/C57C78EA4C7E33280A63FCF21003321141964D867C11F174B3A44550654C6160) (project) and [`0398795F…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/0398795F70032DBC28310D046A321AE2C298440EF218912CA4FB0BCC449E5C98) (reporter) |
| **Client-side encryption and decryption** | Both happen in the browser tab: sealing in the "Send a report" tab, opening in the "Inbox" tab with a seal-key file held in memory only (`openDrop` in [`src/core/inbox.ts`](src/core/inbox.ts)). No server ever sees plain text: the only server code is a GET-only gateway for two key queries ([`gateway.mjs`](gateway.mjs), [`worker/index.mjs`](worker/index.mjs), tests in [`test/gateway.test.mjs`](test/gateway.test.mjs)). Proof run: [`docs/e2e/browser.txt`](docs/e2e/browser.txt) (sealed in the page, dropped, opened in the page) and the screenshots in [`docs/screenshots/`](docs/screenshots) |
| QoreChain-addressed recipients | Recipients are `qor1…` accounts; the contract derives the bech32 address itself (`qorAddress`) so the signed statements name accounts the way QoreSign shows them |
| Repo, README, featured image, video <= 3 min, testnet addresses, licence, credits | This repo, [`docs/featured.png`](docs/featured.png), [demo video](https://github.com/apeirs/sealed-disclosure/releases/download/v0.1.0/sealed-disclosure-demo.mp4), the [testnet table](#live-on-qorechain-testnet-diana) below, [LICENSE](LICENSE) (MIT), [Built with](#built-with) |

## Live on QoreChain testnet (Diana)

| What | Where |
| --- | --- |
| `SealedInbox` contract | [`0x56b6706d009db5357ee076e62c7c7e317e45c353`](https://explore.qore.network/address/0x56b6706d009db5357ee076e62c7c7e317e45c353) (EVM, chain id 9800) |
| Deploy tx | [`0x859f4c0aedc4e819ad3c4582f7f4793e5ee86cf3eae8caa6b23733c17d70d4ae`](https://explore.qore.network/tx/0x859f4c0aedc4e819ad3c4582f7f4793e5ee86cf3eae8caa6b23733c17d70d4ae) (block 9965775, 1,598,049 gas) |
| Demo project | `qor1knxej2kffzpx9hcfjd54argxj72vs962nw60fg` |
| Demo reporter | `qor1uss0ahjc6kgygjmgamsqrmppnpdvd5u7vrlqa5` |
| Second reporter (copies drop #0) | `qor1678npj39yjmfeamjeapgju3uxxrtdjzn0gqehw` |

Transactions of the end-to-end run. EVM hashes (`0x…`) link to the QoreChain explorer, which opens on mainnet:
switch it to Testnet. Native hashes link to the raw transaction on the chain's REST API.

| Step | Tx |
| --- | --- |
| Project registers its ML-DSA-87 key | [`C57C78EA4C7E33280A63FCF21003321141964D867C11F174B3A44550654C6160`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/C57C78EA4C7E33280A63FCF21003321141964D867C11F174B3A44550654C6160) |
| Project registers its ML-KEM-1024 key | [`CA2E5552977ADFBFBDE67116BCAADE93B8300E97C249220FE67DDEA2571E5726`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/CA2E5552977ADFBFBDE67116BCAADE93B8300E97C249220FE67DDEA2571E5726) |
| Project publishes its recipient card | [`0x352d7b1176472960105eb552bfb110236fcb0b0322dbaa6701ff6101edf6c4f8`](https://explore.qore.network/tx/0x352d7b1176472960105eb552bfb110236fcb0b0322dbaa6701ff6101edf6c4f8) (block 9965788) |
| Reporter registers its ML-DSA-87 key | [`0398795F70032DBC28310D046A321AE2C298440EF218912CA4FB0BCC449E5C98`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/0398795F70032DBC28310D046A321AE2C298440EF218912CA4FB0BCC449E5C98) |
| Drop #0 (sealed by the CLI) | [`0x915ef838efdaeee4749fa70764dc7385da2f93bebc51b57dedc59dd21c3c1aa4`](https://explore.qore.network/tx/0x915ef838efdaeee4749fa70764dc7385da2f93bebc51b57dedc59dd21c3c1aa4) (2,245 bytes) |
| Project's signed receipt for #0 | [`0xf1826ed8d2386cd445157546f03fe1b20e3c19660ad1fe133ba313713e00e73a`](https://explore.qore.network/tx/0xf1826ed8d2386cd445157546f03fe1b20e3c19660ad1fe133ba313713e00e73a) (block 9965833) |
| Drop #1 (the same envelope, dropped by the second reporter) | [`0x5666716a8be51fdca5a8f9b22803561ed403faaf1e0ae89ac9422fad38b2f63e`](https://explore.qore.network/tx/0x5666716a8be51fdca5a8f9b22803561ed403faaf1e0ae89ac9422fad38b2f63e): accepted, but does not open |
| Drop #2 (sealed in the browser, dropped by the CLI) | [`0x7a4dbef7ad85c22aa6eb760b4fd6389b3b6a496152b07c1dee03ad7464fb2d73`](https://explore.qore.network/tx/0x7a4dbef7ad85c22aa6eb760b4fd6389b3b6a496152b07c1dee03ad7464fb2d73) (2,087 bytes) |

Each EVM write is sent by the account's relayer inside a hybrid-signed EVM window scoped to the inbox, one
transaction and the estimated fee at most, e.g. [`7E0BE970BB27661FF58FFE61765620D15C0C69E65DD98FA9838F374388C124D2`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/7E0BE970BB27661FF58FFE61765620D15C0C69E65DD98FA9838F374388C124D2)
(deploy) and [`CB8774F6BBCE5728E30BD89299BF24D9CDAD3C7E3741BA36B39FD609A40B83E7`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/CB8774F6BBCE5728E30BD89299BF24D9CDAD3C7E3741BA36B39FD609A40B83E7) (drop #2).

The captured output of these runs is in [`docs/e2e/`](docs/e2e).

## How it works

```
 project                          SealedInbox (EVM)                      reporter
 ───────                          ─────────────────                      ────────
 register ML-DSA-87 key  (PQC module, with proof of possession)
 register ML-KEM-1024 key (KEM registry)
 sign recipient card ───────────► publishCard: card text must name this
 (secp256k1 + ML-DSA-87)          chain and account, be newer than the last,
                                  and carry the account's ML-DSA-87 signature
                                                                          check the project: KEM key,
                                                                          ML-DSA key, card verifies
                                                                          seal report (ML-KEM-1024 + X25519,
                                                                          AES-256-GCM, AAD = from/to)
                                  drop ◄──────────────────────────────── sign "Sealed Disclosure drop v1"
                                  rebuilds the statement (chain, inbox,   with ML-DSA-87
                                  from, to, SHA-256 of the envelope),
                                  checks it with precompile 0x0a01,
                                  stores the drop and its block
 read drops, open with the
 seal key; a copy under another
 name fails the AAD check
 acknowledge ───────────────────► acknowledge: receipt statement signed
                                  by the recipient's ML-DSA-87 key
```

The statements the keys sign are plain text that the contract rebuilds byte for byte (`dropText`, `receiptText`),
so a wallet that shows what it signs shows exactly what the inbox will accept. The client refuses to sign when the
contract's text differs from its own.

```
Sealed Disclosure drop v1
Chain ID: qorechain-diana
Inbox: 0x56b6706d009db5357ee076e62c7c7e317e45c353
From: qor1uss0ahjc6kgygjmgamsqrmppnpdvd5u7vrlqa5
To: qor1knxej2kffzpx9hcfjd54argxj72vs962nw60fg
Envelope SHA-256: 0x5072e781bcf3317d5260777f02f7c90833f722dcea7230c824eb8aec3f5b056b
```

**The seal key.** A project's ML-KEM-1024 and X25519 keys come from its mnemonic through a one-way HKDF
(QoreSeal's `sealSeedFromMnemonic`). `sd setup --seal-key-out` writes just that seed to a file: it decrypts reports
but cannot sign or spend, so a triage team can read the inbox without holding the project's account key.

**In the browser** you can check a project, seal a report and download the envelope, and open an inbox with a
seal-key file (kept in memory only). Signing stays in the CLI: browser wallets don't offer a way to sign an
arbitrary ML-DSA-87 message yet, and the drop is a signature over a message.

## Run it

Node.js 20 or newer.

```sh
npm ci
npm test                     # 20 offline tests: protocol, cards, seal/open, refusals, gateway, Worker
npm run build && npm start   # web app on http://localhost:8080
npm run dev                  # or the Vite dev server
npm run verify:deployment    # the live inbox's bytecode == the compiled contracts/SealedInbox.sol
```

The browser reads the chain's REST API through a small read-only gateway (`gateway.mjs`, used by `server.mjs` and
the Vite dev server) because the public REST endpoint sends no CORS headers. It forwards only GET requests for
`/qorechain/pqc/v1/kem/<qor1…>` and `/qorechain/pqc/v1/account/<qor1…>`. EVM reads go straight to the public RPC.

### Command line

```sh
npm run sd -- keygen keys/project.mnemonic                 # new 24-word account, file mode 600
npm run sd -- fund   --key keys/funded.mnemonic --to qor1... --qor 5
npm run sd -- setup  --key keys/project.mnemonic --seal-key-out project.sealkey.json
#   registers the ML-DSA-87 key (with proof of possession) and the ML-KEM-1024 key, then publishes the card
npm run sd -- export-seal-key --key keys/project.mnemonic --out project.sealkey.json   # decrypt-only key for triage
npm run sd -- check  qor1...                               # can this project receive reports? (exit 1 if not)
npm run sd -- report --key keys/reporter.mnemonic --to qor1... --title "..." --severity high --body-file r.md
#   = seal + drop in one go
npm run sd -- seal   --from qor1... --to qor1... --title "..." --severity high --body-file r.md --out r.sealed
npm run sd -- drop   --key keys/reporter.mnemonic --to qor1... --envelope r.sealed
npm run sd -- inbox  --seal-key project.sealkey.json        # list and open every drop
npm run sd -- ack    --key keys/project.mnemonic --id 0
npm run sd -- deploy --key keys/funded.mnemonic            # your own SealedInbox
```

Every command takes `--network testnet|mainnet` (default testnet) and `--inbox 0x...` for another deployment.
Every write is simulated before anything is signed for the chain, so a bad signature or a replay costs nothing.

### End-to-end checks against the live inbox

```sh
npx tsx scripts/e2e-negative.ts keys/project.mnemonic keys/reporter.mnemonic keys/copier.mnemonic
node scripts/browser-e2e.mjs        # needs playwright-core (PLAYWRIGHT_CORE=/path/to/it) and a Chromium (CHROME=...)
```

`e2e-negative.ts` runs 17 checks as `eth_call` simulations, so they cost nothing: the contract's statements match
the client's, and a replayed drop, a drop signed over another envelope or by another key, an empty envelope, a
sender with no ML-DSA-87 key, a second receipt, a receipt from someone other than the recipient, an older card, a
card signed by another key and a card for another chain all revert with the right error; a tampered envelope,
the wrong keys and the copied drop #1 do not open. `browser-e2e.mjs` drives the web app in headless Chromium: it
checks the demo project, seals a report in the page, drops the downloaded envelope with the CLI, then opens the
inbox in the page; then it checks the `?inbox=demo&key=demo` and `?project=demo` links. Its screenshots are in
`docs/screenshots/`.

### Hosted demo

```sh
./deploy.sh --dry-run          # tests, build, secret check, Worker bundle; nothing uploaded
./deploy.sh --with-demo-key    # deploy to Cloudflare Workers (needs `npx wrangler login`)
BASE=https://sealed-disclosure.apeir.workers.dev node scripts/browser-e2e.mjs --no-drop   # browser checks on the deployed copy
```

One Cloudflare Worker serves the built app and the same GET-only gateway ([`worker/index.mjs`](worker/index.mjs),
[`wrangler.jsonc`](wrangler.jsonc)); no storage, no secrets. `--with-demo-key` also serves the throwaway testnet demo
project's seal key, which is what lets visitors open its inbox; without it the build ships no key at all.
[`scripts/check-secrets.sh`](scripts/check-secrets.sh) refuses any other key material in the build or the repo.

## Layout

```
contracts/SealedInbox.sol     the inbox (solc 0.8.24, via-IR); compile.mjs regenerates SealedInbox.artifact.ts
src/core/                     protocol (statements, report format, AAD), inbox reads, sealing and opening
src/cli/                      sd command line: keys, PQC/KEM registration, EVM windows, writes
src/App.tsx                   web app: send a report, inbox, how it works
gateway.mjs, server.mjs       read-only REST gateway and static server
worker/, wrangler.jsonc       the same app and gateway as one Cloudflare Worker (deploy.sh)
test/                         offline tests (npm test)
scripts/                      live negative checks, browser end-to-end run, deployment check, secret check
```

## Threat model

What is protected: the content of a report, from everyone but the recipient project, now and after large quantum
computers exist; and the record of who reported what, when.

| Attacker | What they can do | What they cannot do |
| --- | --- | --- |
| Records every envelope today, decrypts later with a quantum computer | Read the envelopes: they are public in the inbox's event logs | Open them: the key exchange is ML-KEM-1024 (combined with X25519, so both have to fall), the content AES-256-GCM |
| Holds the project's or a reporter's **secp256k1 key** (Q-Day) | Whatever the classical key alone allows on the account | Forge a drop, a receipt or a card: each needs the account's ML-DSA-87 signature, checked on chain against the key registered with proof of possession. Read reports: the seal key comes from the mnemonic through a one-way HKDF, not from the secp256k1 key. Redirect reports to a key of their own: the ML-DSA-signed card names the ML-KEM key, so a sender refuses a registry key the card does not name (test: "a card does not verify against another account's keys"); the worst case is that the project cannot receive until it fixes its keys |
| Watches the mempool and copies a reporter's envelope | Drop the same bytes under their own name, even in an earlier block (drop [#1](https://explore.qore.network/tx/0x5666716a8be51fdca5a8f9b22803561ed403faaf1e0ae89ac9422fad38b2f63e) does this) | Make the copy open: the envelope's authenticated data names the real sender, so the copy is refused and the genuine drop keeps its place. Block the genuine drop: duplicates are tracked per reporter, not globally |
| Relays the transaction, or runs the RPC | Delay or drop the transaction (anyone else can relay the same signed drop) | Change it: the signature covers chain, inbox, both accounts and the envelope's SHA-256 |
| Replays an old card or signature | Nothing | Cards must be newer than the last (`NotNewer`); statements name the chain and the inbox |
| Hosts the web page | Serve modified JavaScript, as with any web app | Read anything through the gateway: it forwards two public key queries and nothing else. Reporters who do not trust a host can run the page locally or use the CLI |

Limits, honestly stated:

- Testnet software, not audited.
- Metadata is public by design: that `A` sent `B` a report of `N` bytes at block `X`.
- No spam control beyond gas and a registered ML-DSA-87 key; a stake or an allowlist per inbox would be the next step.
- No forward secrecy: whoever later obtains a project's seal key can open its past reports. Key rotation (new
  ML-KEM key, newer card) is not automated yet.
- Signing a drop needs the CLI: browser wallets cannot yet sign an arbitrary message with ML-DSA-87. Dropping a
  browser-sealed envelope (`sd drop`) never shows the plain text to the CLI.
- The demo project's seal key is public on the hosted demo, so anything sent to the demo project is readable by
  everyone. Never publish the seal key of a project you use; this repository holds no key.

## Built with

- [create-qorechain-dapp](https://www.npmjs.com/package/create-qorechain-dapp) 0.13.1 (fullstack-web template),
  the starting point of this repo.
- [@qorechain/sdk](https://www.npmjs.com/package/@qorechain/sdk) and
  [@qorechain/evm](https://www.npmjs.com/package/@qorechain/evm) 0.13 (Apache-2.0): accounts, PQC key
  registration, KEM registration, EVM windows.
- [@qorechain/qoresign](https://www.npmjs.com/package/@qorechain/qoresign) 0.2 (Apache-2.0): hybrid secp256k1 +
  ML-DSA-87 signing and message signatures.
- [@qorechain/qoreseal](https://www.npmjs.com/package/@qorechain/qoreseal) 0.1 (Apache-2.0): ML-KEM-1024 + X25519
  envelopes and recipient cards.
- [viem](https://viem.sh) (MIT), [React](https://react.dev) (MIT), [Vite](https://vitejs.dev) (MIT),
  [solc-js](https://github.com/ethereum/solc-js) (MIT), CosmJS (Apache-2.0).

## License

MIT, see [LICENSE](LICENSE).
