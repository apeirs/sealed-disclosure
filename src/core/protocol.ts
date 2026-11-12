/**
 * The Sealed Disclosure protocol: what gets encrypted, what gets signed, and how
 * a recipient card travels through the SealedInbox contract. Pure functions,
 * shared by the CLI, the web app and the tests. The statements here must stay
 * byte-identical to SealedInbox.dropText / receiptText (the e2e run compares them
 * with the deployed contract).
 */
import { fromBase64, toBase64, type MessageSignature } from "@qorechain/qoresign";
import { recipientCardText, type RecipientCard, type RecipientCardFields } from "@qorechain/qoreseal";

/** QoreSeal purpose: an envelope sealed for Sealed Disclosure opens nowhere else. */
export const PURPOSE = "sealed-disclosure/v1";
export const REPORT_VERSION = 1;
export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** The plaintext of a report, before sealing. */
export interface Report {
  v: typeof REPORT_VERSION;
  title: string;
  severity: Severity;
  /** Free text: affected component, steps to reproduce, impact, suggested fix. */
  body: string;
  /** Optional way back to the reporter (an address, a handle, an email): it travels encrypted. */
  contact?: string;
  createdAt: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export function newReport(fields: { title: string; severity: Severity; body: string; contact?: string; now?: Date }): Report {
  const title = fields.title.trim();
  const body = fields.body.trim();
  if (!title) throw new Error("A report needs a title.");
  if (title.length > 200) throw new Error("Keep the title under 200 characters.");
  if (!body) throw new Error("A report needs a body.");
  if (!SEVERITIES.includes(fields.severity)) throw new Error(`Severity must be one of ${SEVERITIES.join(", ")}.`);
  const contact = fields.contact?.trim();
  return {
    v: REPORT_VERSION,
    title,
    severity: fields.severity,
    body,
    ...(contact ? { contact } : {}),
    createdAt: (fields.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

export function encodeReport(r: Report): Uint8Array {
  return enc.encode(JSON.stringify(r));
}

export function decodeReport(bytes: Uint8Array): Report {
  const r = JSON.parse(dec.decode(bytes));
  if (!r || r.v !== REPORT_VERSION || typeof r.title !== "string" || typeof r.body !== "string") {
    throw new Error("The plaintext is not a Sealed Disclosure report (v1).");
  }
  if (!SEVERITIES.includes(r.severity)) throw new Error("The report names an unknown severity.");
  return r as Report;
}

/**
 * Authenticated data of every envelope: who sends it to whom. The recipient opens
 * with the reporter the inbox recorded, so an envelope copied and re-dropped under
 * another name does not open (AES-GCM fails), and the first genuine drop is clear.
 */
export function reportAad(from: string, to: string): Uint8Array {
  return enc.encode(`sealed-disclosure/v1|from=${from}|to=${to}`);
}

function lowerHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource));
}

export function digestHex(digest: Uint8Array): `0x${string}` {
  if (digest.length !== 32) throw new Error("A SHA-256 digest is 32 bytes.");
  return `0x${lowerHex(digest)}`;
}

/** SealedInbox.dropText: what the reporter's keys sign (QoreSign signMessage). */
export function dropText(a: { chainId: string; inbox: string; from: string; to: string; digest: `0x${string}` }): string {
  return [
    "Sealed Disclosure drop v1",
    `Chain ID: ${a.chainId}`,
    `Inbox: ${a.inbox.toLowerCase()}`,
    `From: ${a.from}`,
    `To: ${a.to}`,
    `Envelope SHA-256: ${a.digest.toLowerCase()}`,
  ].join("\n");
}

/** SealedInbox.receiptText: what the recipient's keys sign to acknowledge drop `id`. */
export function receiptText(a: { chainId: string; inbox: string; id: bigint | number; from: string; to: string; digest: `0x${string}` }): string {
  return [
    "Sealed Disclosure receipt v1",
    `Chain ID: ${a.chainId}`,
    `Inbox: ${a.inbox.toLowerCase()}`,
    `Drop: ${BigInt(a.id).toString()}`,
    `From: ${a.from}`,
    `To: ${a.to}`,
    `Envelope SHA-256: ${a.digest.toLowerCase()}`,
  ].join("\n");
}

// ── recipient cards on chain ────────────────────────────────────────────────

/** The publishCard() arguments for a signed QoreSeal recipient card. */
export function cardToChain(card: RecipientCard) {
  if (card.signature.signatureType !== "ml-dsa-87-hybrid" || !card.signature.pq) {
    throw new Error("The card has no ML-DSA-87 signature; sign it with the account's post-quantum key.");
  }
  if (card.signature.classical.keyType !== "secp256k1") {
    throw new Error("Only native (secp256k1) accounts can publish a card here for now.");
  }
  const { version: _v, signature, ...fields } = card;
  return {
    cardText: recipientCardText(fields),
    classicalPubKey: fromBase64(signature.classical.publicKey),
    classicalSig: fromBase64(signature.classical.signature),
    pqSig: fromBase64(signature.pq!.signature),
  };
}

const CARD_LINES: [keyof RecipientCardFields, string][] = [
  ["chainId", "Chain ID: "],
  ["address", "Address: "],
  ["mlkemKeySha3", "ML-KEM-1024 key SHA3-256: "],
  ["x25519PublicKey", "X25519 key: "],
  ["issuedAt", "Issued at: "],
];

/** Rebuild the card from a CardPublished event. The caller still runs verifyRecipientCard. */
export function cardFromChain(ev: { cardText: string; classicalPubKey: Uint8Array; classicalSig: Uint8Array; pqSig: Uint8Array }): RecipientCard {
  const lines = ev.cardText.split("\n");
  if (lines.length !== 6 || lines[0] !== "QoreSeal recipient card v1") throw new Error("Not a QoreSeal recipient card v1.");
  const fields = {} as RecipientCardFields;
  CARD_LINES.forEach(([k, prefix], i) => {
    const line = lines[i + 1];
    if (!line.startsWith(prefix)) throw new Error(`Card line ${i + 2} should start with "${prefix}".`);
    (fields as unknown as Record<string, string>)[k] = line.slice(prefix.length);
  });
  if (recipientCardText(fields) !== ev.cardText) throw new Error("The card text is not in canonical form.");
  const signature: MessageSignature = {
    signatureType: "ml-dsa-87-hybrid",
    classical: { keyType: "secp256k1", publicKey: toBase64(ev.classicalPubKey), signature: toBase64(ev.classicalSig) },
    pq: { algorithmId: 1, signature: toBase64(ev.pqSig) },
  };
  return { version: 1, ...fields, signature };
}

export function shortHex(h: string, n = 8): string {
  return h.length <= 2 * n + 3 ? h : `${h.slice(0, n + 2)}…${h.slice(-n)}`;
}
