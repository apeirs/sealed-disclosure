/**
 * Reads and client-side crypto against SealedInbox: resolve a project (keys and
 * card, every check spelled out), seal a report to it, list its inbox, open a drop.
 * Runs in the browser and in Node; nothing here holds an account key.
 */
import { parseAddress } from "@qorechain/qoresign";
import { fetchPqKeyStatus } from "@qorechain/qoresign/network";
import {
  open,
  parseEnvelope,
  seal,
  verifyRecipientCard,
  type RecipientCard,
  type SealKeyPair,
  type SealRecipient,
} from "@qorechain/qoreseal";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { createPublicClient, hexToBytes, http, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { sealedInboxAbi } from "../../contracts/SealedInbox.artifact";
import type { Network } from "./networks";
import { PURPOSE, cardFromChain, decodeReport, digestHex, encodeReport, reportAad, sha256, type Report } from "./protocol";

export const cardPublishedEvent = parseAbiItem(
  "event CardPublished(address indexed account, bytes20 issuedAt, string cardText, bytes classicalPubKey, bytes classicalSig, bytes pqSig)",
);
export const droppedEvent = parseAbiItem(
  "event Dropped(uint256 indexed id, address indexed recipient, address indexed reporter, bytes32 envelopeSha256, bytes envelope)",
);

/** Diana's EVM RPC answers eth_getLogs over at most this many blocks per call. */
const LOG_SPAN = 9_000n;

export function publicClient(net: Network): PublicClient {
  return createPublicClient({ transport: http(net.evmRpc, { timeout: 20_000, retryCount: 1 }) }) as PublicClient;
}

export function inboxOf(net: Network): Address {
  if (!net.inbox) throw new Error(`No SealedInbox is deployed on ${net.chainId}.`);
  return net.inbox;
}

export function toAccount(address: string) {
  try {
    const a = parseAddress(address.trim());
    return { bech32: a.bech32, evm: a.hex as Address };
  } catch {
    throw new Error(`"${address}" is not a qor1 or 0x address.`);
  }
}

async function getLogsChunked<T>(net: Network, fetchRange: (from: bigint, to: bigint) => Promise<T[]>, from?: bigint, to?: bigint): Promise<T[]> {
  const head = to ?? (await publicClient(net).getBlockNumber());
  const out: T[] = [];
  for (let start = from ?? net.inboxFromBlock ?? 0n; start <= head; start += LOG_SPAN) {
    const end = start + LOG_SPAN - 1n < head ? start + LOG_SPAN - 1n : head;
    out.push(...(await fetchRange(start, end)));
  }
  return out;
}

export interface Check {
  ok: boolean;
  label: string;
  detail?: string;
}

export interface ProjectStatus {
  address: string;
  evm: Address;
  checks: Check[];
  /** Ready to seal to: the registered ML-KEM-1024 key plus the verified card's X25519 key. */
  recipient?: SealRecipient;
  card?: RecipientCard;
  cardBlock?: bigint;
  mlkemHeight?: bigint;
}

/** The newest card published for `evm`, or undefined. */
export async function latestCard(net: Network, evm: Address): Promise<{ card: RecipientCard; block: bigint } | undefined> {
  const client = publicClient(net);
  const inbox = inboxOf(net);
  const block = (await client.readContract({ address: inbox, abi: sealedInboxAbi, functionName: "cardBlock", args: [evm] })) as bigint;
  if (!block) return undefined;
  const logs = await client.getLogs({ address: inbox, event: cardPublishedEvent, args: { account: evm }, fromBlock: block, toBlock: block });
  const ev = logs.at(-1)?.args;
  if (!ev) throw new Error(`The inbox says a card was published at block ${block}, but its event was not found.`);
  const hex = (h: Hex) => hexToBytes(h);
  return {
    block,
    card: cardFromChain({ cardText: ev.cardText!, classicalPubKey: hex(ev.classicalPubKey!), classicalSig: hex(ev.classicalSig!), pqSig: hex(ev.pqSig!) }),
  };
}

/** Everything a reporter needs to know before sealing to `address`, as a list of checks. */
export async function resolveProject(net: Network, address: string): Promise<ProjectStatus> {
  const { bech32, evm } = toAccount(address);
  const st: ProjectStatus = { address: bech32, evm, checks: [] };
  const [kem, pq] = await Promise.all([fetchKemKey({ rest: net.rest, address: bech32 }), fetchPqKeyStatus({ rest: net.rest, address: bech32 })]);
  st.checks.push(
    kem.registered && kem.publicKey
      ? { ok: true, label: "ML-KEM-1024 key registered on chain", detail: `${kem.publicKey.length} bytes, height ${kem.registeredHeight}` }
      : { ok: false, label: "No ML-KEM-1024 key registered", detail: "The project has to publish one (MsgRegisterKEMKey) before it can receive reports." },
  );
  st.mlkemHeight = kem.registeredHeight;
  st.checks.push(
    pq.registered && pq.publicKey
      ? { ok: true, label: "ML-DSA-87 key registered", detail: pq.possessionProven ? "with proof of possession" : "without proof of possession" }
      : { ok: false, label: "No ML-DSA-87 key registered", detail: "The card cannot be checked without it." },
  );
  let found: Awaited<ReturnType<typeof latestCard>>;
  try {
    found = await latestCard(net, evm);
  } catch (err) {
    st.checks.push({ ok: false, label: "Recipient card unreadable", detail: (err as Error).message });
  }
  if (!found) {
    if (!st.checks.some((c) => c.label.startsWith("Recipient card"))) {
      st.checks.push({ ok: false, label: "No recipient card in the inbox", detail: "The project has not published its card (X25519 key) yet." });
    }
    return st;
  }
  st.card = found.card;
  st.cardBlock = found.block;
  if (!kem.publicKey || !pq.publicKey) return st;
  try {
    st.recipient = verifyRecipientCard({ card: found.card, chainId: net.chainId, address: bech32, pqPublicKey: pq.publicKey, mlkemPublicKey: kem.publicKey });
    st.checks.push({
      ok: true,
      label: "Recipient card verified",
      detail: `signed with secp256k1 + ML-DSA-87, names the registered ML-KEM key, issued ${found.card.issuedAt} (EVM block ${found.block})`,
    });
  } catch (err) {
    st.checks.push({ ok: false, label: "Recipient card does not verify", detail: (err as Error).message });
  }
  return st;
}

export interface Sealed {
  envelope: Uint8Array;
  digest: `0x${string}`;
  recipients: number;
}

/** Seal a report to the project (and, optionally, to the reporter's own keys for a readable copy). */
export async function sealReport(a: {
  chainId: string;
  from: string;
  to: ProjectStatus;
  report: Report;
  copyTo?: SealRecipient;
}): Promise<Sealed> {
  if (!a.to.recipient) throw new Error("The project's keys did not pass every check; nothing was sealed.");
  const recipients = [a.to.recipient, ...(a.copyTo ? [a.copyTo] : [])];
  const envelope = seal({
    chainId: a.chainId,
    purpose: PURPOSE,
    recipients,
    plaintext: encodeReport(a.report),
    aad: reportAad(toAccount(a.from).bech32, a.to.address),
  });
  return { envelope, digest: digestHex(await sha256(envelope)), recipients: recipients.length };
}

export interface DropEntry {
  id: bigint;
  reporter: string;
  recipient: string;
  digest: `0x${string}`;
  blockNumber: bigint;
  timestamp: bigint;
  size: number;
  receiptBlock: bigint;
  envelope: Uint8Array;
  txHash: Hex;
}

/** Every drop addressed to `address`, oldest first, with its envelope. */
export async function listDrops(net: Network, address: string): Promise<DropEntry[]> {
  const { evm } = toAccount(address);
  const client = publicClient(net);
  const inbox = inboxOf(net);
  const ids = (await client.readContract({ address: inbox, abi: sealedInboxAbi, functionName: "inboxOf", args: [evm] })) as bigint[];
  if (!ids.length) return [];
  const records = await Promise.all(ids.map((id) => client.readContract({ address: inbox, abi: sealedInboxAbi, functionName: "getDrop", args: [id] })));
  const first = records.reduce((m, r: any) => (r.blockNumber < m ? r.blockNumber : m), (records[0] as any).blockNumber as bigint);
  // Each record names its drop's block, so the scan stops at the newest drop instead of the chain head
  // (Diana makes ~2,500 blocks an hour; scanning to the head would add a getLogs call every ~3.5 h).
  const last = records.reduce((m, r: any) => (r.blockNumber > m ? r.blockNumber : m), first);
  const logs = await getLogsChunked(net, (fromBlock, toBlock) => client.getLogs({ address: inbox, event: droppedEvent, args: { recipient: evm }, fromBlock, toBlock }), first, last);
  const byId = new Map(logs.map((l) => [l.args.id!, l]));
  return ids.map((id, i) => {
    const r = records[i] as any;
    const log = byId.get(id);
    if (!log) throw new Error(`Drop ${id} has no Dropped event between blocks ${first} and ${last}.`);
    return {
      id,
      reporter: toAccount(r.reporter).bech32,
      recipient: toAccount(r.recipient).bech32,
      digest: r.envelopeSha256,
      blockNumber: r.blockNumber,
      timestamp: r.timestamp,
      size: Number(r.size),
      receiptBlock: r.receiptBlock,
      envelope: hexToBytes(log.args.envelope!),
      txHash: log.transactionHash,
    };
  });
}

export type Opened =
  | { ok: true; report: Report; envelopeOk: true; authorship: "verified" }
  | { ok: false; reason: string };

/**
 * Open a drop with the recipient's QoreSeal keys. The reporter recorded on chain
 * is part of the authenticated data, so success also proves the envelope was
 * sealed by (or for) that reporter, not copied from someone else's drop.
 */
export async function openDrop(chainId: string, d: Pick<DropEntry, "envelope" | "digest" | "reporter" | "recipient">, keys: SealKeyPair): Promise<Opened> {
  if (digestHex(await sha256(d.envelope)) !== d.digest.toLowerCase()) return { ok: false, reason: "The envelope does not match the digest on record." };
  try {
    parseEnvelope(d.envelope);
  } catch (err) {
    return { ok: false, reason: `Malformed envelope: ${(err as Error).message}` };
  }
  try {
    const plain = open({ chainId, purpose: PURPOSE, envelope: d.envelope, keys, aad: reportAad(d.reporter, d.recipient) });
    return { ok: true, report: decodeReport(plain), envelopeOk: true, authorship: "verified" };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NOT_A_RECIPIENT") return { ok: false, reason: "These keys are not among the envelope's recipients." };
    if (code === "DECRYPTION_FAILED") {
      return { ok: false, reason: "Does not open under this reporter's name: the envelope was sealed for another sender (a copied drop) or altered." };
    }
    return { ok: false, reason: (err as Error).message };
  }
}

/** The 32-byte QoreSeal seed as a small JSON key file: decrypts, cannot sign or spend. */
export interface SealKeyFile {
  kind: "sealed-disclosure/seal-key";
  version: 1;
  chainId: string;
  address: string;
  seed: string;
}

export function parseSealKeyFile(text: string): SealKeyFile {
  const j = JSON.parse(text);
  if (j?.kind !== "sealed-disclosure/seal-key" || j.version !== 1 || !/^[0-9a-f]{64}$/.test(j.seed ?? "")) {
    throw new Error("Not a Sealed Disclosure seal-key file.");
  }
  return j as SealKeyFile;
}
