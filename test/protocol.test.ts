/** Offline tests: statements, reports, cards, sealing and opening. No network. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fromHex, sealKeysFromSeed, signRecipientCard, verifyRecipientCard } from "@qorechain/qoreseal";
import { generateMnemonic } from "@qorechain/sdk";
import { keygen, loadAccount, sealKeyFile, type Account } from "../src/cli/account";
import { openDrop, parseSealKeyFile, sealReport, type ProjectStatus } from "../src/core/inbox";
import { NETWORKS } from "../src/core/networks";
import { cardFromChain, cardToChain, decodeReport, dropText, encodeReport, newReport, receiptText, reportAad } from "../src/core/protocol";

const net = NETWORKS.testnet;
const CHAIN = net.chainId;
let dir: string;
let project: Account;
let reporter: Account;
let other: Account;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "sd-test-"));
  const make = async (name: string) => {
    const file = join(dir, `${name}.mnemonic`);
    await keygen(file);
    return loadAccount(file);
  };
  [project, reporter, other] = await Promise.all([make("project"), make("reporter"), make("other")]);
});
after(() => rmSync(dir, { recursive: true, force: true }));

function readyProject(a: Account): ProjectStatus {
  const card = signRecipientCard({ chainId: CHAIN, address: a.address, keys: a.sealKeys, classicalKey: a.classical, pqKey: a.pq });
  const back = cardFromChain(cardToChain(card));
  const recipient = verifyRecipientCard({ card: back, chainId: CHAIN, address: a.address, pqPublicKey: a.pq.publicKey, mlkemPublicKey: a.sealKeys.mlkemPublicKey });
  return { address: a.address, evm: a.evm, checks: [], recipient, card: back };
}

const report = () => newReport({ title: "Reentrancy in withdraw", severity: "high", body: "Steps...\nImpact...", contact: "@someone", now: new Date("2026-11-12T18:00:00.123Z") });

describe("statements", () => {
  const digest = `0x${"ab".repeat(32)}` as const;
  it("dropText has the contract's exact shape", () => {
    assert.equal(
      dropText({ chainId: CHAIN, inbox: "0xABCDEF0000000000000000000000000000000001", from: "qor1from", to: "qor1to", digest }),
      `Sealed Disclosure drop v1\nChain ID: qorechain-diana\nInbox: 0xabcdef0000000000000000000000000000000001\nFrom: qor1from\nTo: qor1to\nEnvelope SHA-256: 0x${"ab".repeat(32)}`,
    );
  });
  it("receiptText names the drop id in decimal", () => {
    const t = receiptText({ chainId: CHAIN, inbox: "0x01", id: 42n, from: "a", to: "b", digest });
    assert.match(t, /^Sealed Disclosure receipt v1\nChain ID: qorechain-diana\nInbox: 0x01\nDrop: 42\nFrom: a\nTo: b\n/);
  });
  it("AAD binds sender and recipient", () => {
    assert.equal(new TextDecoder().decode(reportAad("qor1a", "qor1b")), "sealed-disclosure/v1|from=qor1a|to=qor1b");
  });
});

describe("reports", () => {
  it("round-trips and trims", () => {
    const r = newReport({ title: "  T  ", severity: "low", body: " b ", contact: "  " });
    assert.equal(r.title, "T");
    assert.equal(r.body, "b");
    assert.equal(r.contact, undefined);
    assert.deepEqual(decodeReport(encodeReport(r)), r);
    assert.equal(report().createdAt, "2026-11-12T18:00:00Z");
  });
  it("rejects missing fields and unknown severities", () => {
    assert.throws(() => newReport({ title: "", severity: "high", body: "x" }), /title/);
    assert.throws(() => newReport({ title: "x", severity: "high", body: " " }), /body/);
    assert.throws(() => newReport({ title: "x".repeat(201), severity: "high", body: "x" }), /200/);
    assert.throws(() => newReport({ title: "x", severity: "urgent" as never, body: "x" }), /Severity/);
    assert.throws(() => decodeReport(new TextEncoder().encode('{"v":2}')), /not a Sealed Disclosure report/);
  });
});

describe("keys and cards", () => {
  it("QoreSign and the SDK agree on every derived key (asserted in loadAccount)", () => {
    assert.match(project.address, /^qor1/);
    assert.equal(project.pq.publicKey.length, 2592);
    assert.equal(project.sealKeys.mlkemPublicKey.length, 1568);
  });
  it("a card survives the trip through publishCard arguments and verifies", () => {
    const st = readyProject(project);
    assert.ok(st.recipient);
    assert.equal(cardToChain(st.card!).cardText.split("\n").length, 6);
  });
  it("a card does not verify against another account's keys", () => {
    const card = signRecipientCard({ chainId: CHAIN, address: project.address, keys: project.sealKeys, classicalKey: project.classical, pqKey: project.pq });
    assert.throws(() => verifyRecipientCard({ card, chainId: CHAIN, address: project.address, pqPublicKey: other.pq.publicKey, mlkemPublicKey: project.sealKeys.mlkemPublicKey }));
    assert.throws(() => verifyRecipientCard({ card, chainId: CHAIN, address: project.address, pqPublicKey: project.pq.publicKey, mlkemPublicKey: other.sealKeys.mlkemPublicKey }));
  });
  it("cardFromChain refuses non-canonical text", () => {
    const c = cardToChain(signRecipientCard({ chainId: CHAIN, address: project.address, keys: project.sealKeys, classicalKey: project.classical, pqKey: project.pq }));
    assert.throws(() => cardFromChain({ ...c, cardText: c.cardText + "\n" }), /card/);
    assert.throws(() => cardFromChain({ ...c, cardText: c.cardText.replace("Address: ", "Addr: ") }), /Address/);
  });
  it("the seal-key file reproduces the keys and nothing else", () => {
    const f = parseSealKeyFile(JSON.stringify(sealKeyFile(project, net)));
    assert.deepEqual(Object.keys(f).sort(), ["address", "chainId", "kind", "seed", "version"]);
    const k = sealKeysFromSeed(fromHex(f.seed));
    assert.deepEqual(k.mlkemPublicKey, project.sealKeys.mlkemPublicKey);
    assert.deepEqual(k.x25519PublicKey, project.sealKeys.x25519PublicKey);
    assert.throws(() => parseSealKeyFile('{"kind":"x"}'), /seal-key/);
  });
});

describe("seal and open", () => {
  it("only the recipient opens it, and only under the true sender", async () => {
    const to = readyProject(project);
    const r = report();
    const s = await sealReport({ chainId: CHAIN, from: reporter.address, to, report: r });
    const drop = { envelope: s.envelope, digest: s.digest, reporter: reporter.address, recipient: project.address };
    const ok = await openDrop(CHAIN, drop, project.sealKeys);
    assert.ok(ok.ok);
    assert.deepEqual(ok.ok && ok.report, r);
    const wrongKeys = await openDrop(CHAIN, drop, other.sealKeys);
    assert.ok(!wrongKeys.ok && /not among/.test(wrongKeys.reason));
    const copied = await openDrop(CHAIN, { ...drop, reporter: other.address }, project.sealKeys);
    assert.ok(!copied.ok && /copied/.test(copied.reason));
    const env = new Uint8Array(s.envelope);
    env[env.length - 3] ^= 0x80;
    const tampered = await openDrop(CHAIN, { ...drop, envelope: env }, project.sealKeys);
    assert.ok(!tampered.ok && /digest/.test(tampered.reason));
  });
  it("an optional copy to the reporter opens for both", async () => {
    const to = readyProject(project);
    const self = readyProject(reporter).recipient!;
    const s = await sealReport({ chainId: CHAIN, from: reporter.address, to, report: report(), copyTo: self });
    assert.equal(s.recipients, 2);
    const drop = { envelope: s.envelope, digest: s.digest, reporter: reporter.address, recipient: project.address };
    assert.ok((await openDrop(CHAIN, drop, project.sealKeys)).ok);
    assert.ok((await openDrop(CHAIN, drop, reporter.sealKeys)).ok);
  });
  it("refuses to seal to a project that failed its checks", async () => {
    await assert.rejects(sealReport({ chainId: CHAIN, from: reporter.address, to: { address: project.address, evm: project.evm, checks: [] }, report: report() }), /every check/);
  });
  it("an envelope sealed for another chain does not open here", async () => {
    const s = await sealReport({ chainId: "qorechain-vladi", from: reporter.address, to: readyProject(project), report: report() });
    const r = await openDrop(CHAIN, { envelope: s.envelope, digest: s.digest, reporter: reporter.address, recipient: project.address }, project.sealKeys);
    assert.ok(!r.ok);
  });
});

it("generateMnemonic gives 24 words", () => assert.equal(generateMnemonic(256).split(" ").length, 24));
