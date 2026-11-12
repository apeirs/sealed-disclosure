/**
 * Negative checks against the live testnet inbox, all as eth_call simulations (free):
 * every forged, replayed or stale write must revert with the right error, and an
 * envelope copied under another sender's name must not open.
 *
 *   tsx scripts/e2e-negative.ts keys/project.mnemonic keys/reporter.mnemonic [keys/copier.mnemonic]
 */
import { fromBase64 } from "@qorechain/qoresign";
import { signRecipientCard } from "@qorechain/qoreseal";
import { BaseError, bytesToHex, ContractFunctionRevertedError, type Address } from "viem";
import { sealedInboxAbi } from "../contracts/SealedInbox.artifact";
import { evmClients, loadAccount, signText, type Account } from "../src/cli/account";
import { inboxOf, latestCard, listDrops, openDrop, publicClient } from "../src/core/inbox";
import { NETWORKS } from "../src/core/networks";
import { cardToChain, dropText, receiptText } from "../src/core/protocol";

const net = NETWORKS.testnet;
const inbox = inboxOf(net);
let failures = 0;

function report(ok: boolean, label: string, detail: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${detail}`);
}

async function expectRevert(label: string, sender: Account, functionName: string, args: readonly unknown[], want: string) {
  const { client, account } = await evmClients(sender, net);
  try {
    await client.publicClient.simulateContract({ address: inbox, abi: sealedInboxAbi, functionName, args, account } as any);
    report(false, label, `accepted, expected ${want}`);
  } catch (err) {
    const rev = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : undefined;
    const name = rev instanceof ContractFunctionRevertedError ? rev.data?.errorName : undefined;
    report(name === want, label, `reverted with ${name ?? (err as Error).message.split("\n")[0]}`);
  }
}

const pqSigOver = (a: Account, text: string) => bytesToHex(fromBase64(signText(a, net, text).pq!.signature));

async function main() {
  const [projectFile, reporterFile, copierFile] = process.argv.slice(2);
  const project = await loadAccount(projectFile);
  const reporter = await loadAccount(reporterFile);
  const client = publicClient(net);
  const drops = await listDrops(net, project.address);
  const d0 = drops[0];
  if (!d0) throw new Error("No drop in the project's inbox yet; run the happy path first.");
  console.log(`Inbox ${inbox}, project ${project.address}, ${drops.length} drop(s).\n`);

  // 1. The statements this client signs are byte-identical to the contract's.
  const tsDrop = dropText({ chainId: net.chainId, inbox, from: d0.reporter, to: d0.recipient, digest: d0.digest });
  const chainDrop = await client.readContract({ address: inbox, abi: sealedInboxAbi, functionName: "dropText", args: [reporter.evm, project.evm, d0.digest] });
  report(tsDrop === chainDrop, "dropText matches the contract", JSON.stringify(chainDrop.split("\n")[0]) + ` (${chainDrop.length} chars)`);
  const tsReceipt = receiptText({ chainId: net.chainId, inbox, id: d0.id, from: d0.reporter, to: d0.recipient, digest: d0.digest });
  const chainReceipt = await client.readContract({ address: inbox, abi: sealedInboxAbi, functionName: "receiptText", args: [d0.id] });
  report(tsReceipt === chainReceipt, "receiptText matches the contract", `${chainReceipt.length} chars`);

  // 2. Forged and replayed writes revert.
  const env = bytesToHex(d0.envelope);
  await expectRevert("the same envelope dropped twice by its reporter", reporter, "drop", [reporter.evm, project.evm, env, pqSigOver(reporter, tsDrop)], "AlreadyDropped");
  const fresh = new Uint8Array(d0.envelope);
  fresh[fresh.length - 1] ^= 1;
  await expectRevert("a drop signed over a different envelope", reporter, "drop", [reporter.evm, project.evm, bytesToHex(fresh), pqSigOver(reporter, tsDrop)], "BadSignature");
  const forgedText = dropText({ chainId: net.chainId, inbox, from: reporter.address, to: project.address, digest: d0.digest });
  await expectRevert("a drop in the reporter's name signed by another key", project, "drop", [reporter.evm, project.evm, bytesToHex(fresh), pqSigOver(project, forgedText)], "BadSignature");
  await expectRevert("an empty envelope", reporter, "drop", [reporter.evm, project.evm, "0x", "0x"], "EmptyEnvelope");
  await expectRevert("a drop from an address with no ML-DSA-87 key", reporter, "drop", ["0x000000000000000000000000000000000000dEaD" as Address, project.evm, env, "0x"], "NoPqcKey");
  await expectRevert("acknowledging the same drop again", project, "acknowledge", [d0.id, pqSigOver(project, tsReceipt)], d0.receiptBlock ? "AlreadyAcknowledged" : "BadSignature");
  const open = drops.find((d) => !d.receiptBlock);
  if (open) {
    const text = receiptText({ chainId: net.chainId, inbox, id: open.id, from: open.reporter, to: open.recipient, digest: open.digest });
    await expectRevert(`acknowledging #${open.id} as someone other than the recipient`, reporter, "acknowledge", [open.id, pqSigOver(reporter, text)], "BadSignature");
  }
  await expectRevert("acknowledging a drop that does not exist", project, "acknowledge", [99_999n, "0x"], "UnknownDrop");

  const current = await latestCard(net, project.evm);
  const stale = cardToChain(signRecipientCard({ chainId: net.chainId, address: project.address, keys: project.sealKeys, classicalKey: project.classical, pqKey: project.pq, issuedAt: new Date(Date.parse(current!.card.issuedAt) - 60_000) }));
  await expectRevert("replaying an older recipient card", project, "publishCard", [project.evm, stale.cardText, bytesToHex(stale.classicalPubKey), bytesToHex(stale.classicalSig), bytesToHex(stale.pqSig)], "NotNewer");
  const foreign = cardToChain(signRecipientCard({ chainId: net.chainId, address: project.address, keys: reporter.sealKeys, classicalKey: project.classical, pqKey: reporter.pq, issuedAt: new Date() }));
  await expectRevert("a card for the project signed with someone else's ML-DSA key", reporter, "publishCard", [project.evm, foreign.cardText, bytesToHex(foreign.classicalPubKey), bytesToHex(foreign.classicalSig), bytesToHex(foreign.pqSig)], "BadSignature");
  const wrongChain = cardToChain(signRecipientCard({ chainId: "qorechain-vladi", address: project.address, keys: project.sealKeys, classicalKey: project.classical, pqKey: project.pq, issuedAt: new Date() }));
  await expectRevert("a card issued for another chain", project, "publishCard", [project.evm, wrongChain.cardText, bytesToHex(wrongChain.classicalPubKey), bytesToHex(wrongChain.classicalSig), bytesToHex(wrongChain.pqSig)], "BadCard");

  // 3. Client-side opening refuses what it should.
  const tampered = new Uint8Array(d0.envelope);
  tampered[200] ^= 1;
  const t = await openDrop(net.chainId, { ...d0, envelope: tampered }, project.sealKeys);
  report(!t.ok && /digest/.test(t.reason), "a tampered envelope", t.ok ? "opened" : t.reason);
  const w = await openDrop(net.chainId, d0, reporter.sealKeys);
  report(!w.ok, "opening with keys that are not the recipient's", w.ok ? "opened" : w.reason);
  if (copierFile) {
    const copier = await loadAccount(copierFile);
    const c = await openDrop(net.chainId, { ...d0, reporter: copier.address }, project.sealKeys);
    report(!c.ok, "the same envelope under another sender's name", c.ok ? "opened" : c.reason);
    const copiedDrop = drops.find((d) => d.reporter === copier.address);
    if (copiedDrop) {
      const cc = await openDrop(net.chainId, copiedDrop, project.sealKeys);
      report(!cc.ok, `on-chain copy #${copiedDrop.id} by ${copier.address}`, cc.ok ? "opened" : cc.reason);
    }
  }
  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(`Error: ${(err as { shortMessage?: string }).shortMessage ?? (err as Error).message}`);
  process.exitCode = 1;
});
