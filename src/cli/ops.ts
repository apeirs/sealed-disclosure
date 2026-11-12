/**
 * Writes to SealedInbox: deploy, publish a card, drop an envelope, acknowledge.
 * Each call is simulated first (a bad signature costs nothing), then sent by the
 * account's relayer inside a one-transaction EVM window scoped to the inbox.
 */
import { fromBase64 } from "@qorechain/qoresign";
import { signRecipientCard } from "@qorechain/qoreseal";
import { bytesToHex, type Address, type Hex } from "viem";
import { sealedInboxAbi, sealedInboxBytecode } from "../../contracts/SealedInbox.artifact";
import { inboxOf, publicClient, toAccount } from "../core/inbox";
import type { Network } from "../core/networks";
import { cardToChain, dropText, receiptText } from "../core/protocol";
import { evmClients, evmFees, openWindow, prepareEvmWrite, readyRelayer, signText, type Account, type Log } from "./account";

const DEPLOY_GAS = 3_000_000n;

type WriteFn = "publishCard" | "drop" | "acknowledge";

/** Simulate, size the window from the estimate, open it, send, wait. */
async function write(a: Account, net: Network, functionName: WriteFn, args: readonly unknown[], log: Log) {
  const inbox = inboxOf(net);
  const { client, account, wallet } = await evmClients(a, net);
  const call = { address: inbox, abi: sealedInboxAbi, functionName, args, account } as any;
  const sim = await client.publicClient.simulateContract(call);
  log(`${functionName}: the inbox accepts it in simulation.`);
  // Gas estimation needs a relayer that can pay, so fund it (once) before estimating.
  await readyRelayer(a, net, log);
  const estimate = await client.publicClient.estimateContractGas(call);
  const gas = (estimate * 13n) / 10n + 20_000n;
  const windowTx = await openWindow(a, net, gas, [inbox], log);
  const hash = await wallet.writeContract({ ...call, chain: wallet.chain, gas, ...evmFees });
  log(`${functionName} tx: ${hash}`);
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`${functionName} ${hash} reverted.`);
  return { txHash: hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed, windowTx, result: (sim as any).result };
}

export async function deployInbox(a: Account, net: Network, log: Log) {
  const windowTx = await prepareEvmWrite(a, net, DEPLOY_GAS, undefined, log);
  const { client, account, wallet } = await evmClients(a, net);
  const hash = await wallet.deployContract({
    abi: sealedInboxAbi,
    bytecode: sealedInboxBytecode as Hex,
    args: [net.chainId],
    account,
    chain: wallet.chain,
    gas: DEPLOY_GAS,
    ...evmFees,
  } as any);
  log(`Deploy tx: ${hash}`);
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`Deploy ${hash} failed (${receipt.status}).`);
  return { address: receipt.contractAddress as Address, txHash: hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed, windowTx };
}

/** Sign a fresh recipient card (secp256k1 + ML-DSA-87) and publish it in the inbox. */
export async function publishCard(a: Account, net: Network, log: Log, issuedAt?: Date) {
  const card = signRecipientCard({
    chainId: net.chainId,
    address: a.address,
    keys: a.sealKeys,
    classicalKey: a.classical,
    pqKey: a.pq,
    issuedAt: issuedAt ?? new Date(),
  });
  const c = cardToChain(card);
  const args = [a.evm, c.cardText, bytesToHex(c.classicalPubKey), bytesToHex(c.classicalSig), bytesToHex(c.pqSig)] as const;
  return { card, ...(await write(a, net, "publishCard", args, log)) };
}

/** The drop() arguments for an envelope: the reporter signs dropText with its ML-DSA-87 key. */
export function dropArgs(a: Account, net: Network, to: string, envelope: Uint8Array, digest: `0x${string}`) {
  const recipient = toAccount(to);
  const text = dropText({ chainId: net.chainId, inbox: inboxOf(net), from: a.address, to: recipient.bech32, digest });
  const sig = signText(a, net, text);
  return { text, args: [a.evm, recipient.evm, bytesToHex(envelope), bytesToHex(fromBase64(sig.pq!.signature))] as const };
}

export async function dropEnvelope(a: Account, net: Network, to: string, envelope: Uint8Array, digest: `0x${string}`, log: Log) {
  const { text, args } = dropArgs(a, net, to, envelope, digest);
  const onChain = await publicClient(net).readContract({ address: inboxOf(net), abi: sealedInboxAbi, functionName: "dropText", args: [args[0], args[1], digest] });
  if (onChain !== text) throw new Error("The inbox builds a different drop statement than this client; refusing to sign for it.");
  const r = await write(a, net, "drop", args, log);
  return { ...r, id: r.result as bigint, statement: text };
}

export async function acknowledgeDrop(a: Account, net: Network, id: bigint, log: Log) {
  const client = publicClient(net);
  const inbox = inboxOf(net);
  const d = (await client.readContract({ address: inbox, abi: sealedInboxAbi, functionName: "getDrop", args: [id] })) as any;
  const text = receiptText({ chainId: net.chainId, inbox, id, from: toAccount(d.reporter).bech32, to: toAccount(d.recipient).bech32, digest: d.envelopeSha256 });
  const onChain = await client.readContract({ address: inbox, abi: sealedInboxAbi, functionName: "receiptText", args: [id] });
  if (onChain !== text) throw new Error("The inbox builds a different receipt statement than this client; refusing to sign for it.");
  if (toAccount(d.recipient).bech32 !== a.address) throw new Error(`Drop ${id} is addressed to ${toAccount(d.recipient).bech32}, not to this key.`);
  const sig = signText(a, net, text);
  return { ...(await write(a, net, "acknowledge", [id, bytesToHex(fromBase64(sig.pq!.signature))], log)), statement: text };
}
