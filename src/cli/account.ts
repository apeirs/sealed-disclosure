/**
 * Account keys and chain writes for the CLI (Node only). A mnemonic is read from
 * a 0600 file, kept in memory, and never printed or logged. Everything a browser
 * user does (check a project, seal, read an inbox, decrypt) needs no account key.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { encodeSecp256k1Pubkey } from "@cosmjs/amino";
import { encodePubkey, makeAuthInfoBytes } from "@cosmjs/proto-signing";
import { StargateClient } from "@cosmjs/stargate";
import { createEvmClient, evmAccountFromPrivateKey, evmWindowCost, evmWindowStatus } from "@qorechain/evm";
import {
  addressFromPublicKey,
  deriveCanonicalPqKey,
  deriveClassicalKey,
  signHybrid,
  signMessage,
  type ClassicalKey,
  type PqKeyPair,
} from "@qorechain/qoresign";
import { simulateTx, submitWithSignBytesFallback } from "@qorechain/qoresign/network";
import {
  buildRegisterKemKeyMessage,
  deriveSealKeys,
  describeKemRegistryError,
  sealSeedFromMnemonic,
  toHex,
  type SealKeyPair,
} from "@qorechain/qoreseal";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  createClient,
  deriveNativeAccount,
  derivePqcCanonical,
  deriveUnifiedAccount,
  directSignerFromPrivateKey,
  ensurePqcRegistered,
  generateMnemonic,
  openEvmWindowMsg,
  signProofOfPossession,
  validateMnemonic,
  type EncodeObject,
  type PqcKeypair,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import type { Address, Hex } from "viem";
import { getJson } from "../core/http";
import type { SealKeyFile } from "../core/inbox";
import type { Network } from "../core/networks";

export type Log = (line: string) => void;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Account {
  address: string;
  evm: Address;
  classical: ClassicalKey;
  pq: PqKeyPair;
  /** The same ML-DSA-87 key in the SDK's shape (for its tx client). */
  sdkPqc: PqcKeypair;
  privateKey: Uint8Array;
  sealKeys: SealKeyPair;
  sealSeed: Uint8Array;
  /** The Ethereum-type (m/44'/60') account of the same mnemonic: pays for EVM writes. */
  relayer: UnifiedAccount;
}

function readMnemonic(file: string): string {
  const st = statSync(file);
  if ((st.mode & 0o077) !== 0) throw new Error(`${file} is readable by others; run chmod 600 on it.`);
  const mnemonic = readFileSync(file, "utf8").trim().split(/\s+/).join(" ");
  if (!validateMnemonic(mnemonic)) throw new Error(`${file} does not hold a valid BIP-39 mnemonic.`);
  return mnemonic;
}

/** Write a fresh 24-word mnemonic to `file` (0600, refuses to overwrite) and return its address. */
export async function keygen(file: string): Promise<string> {
  const mnemonic = generateMnemonic(256);
  writeFileSync(file, mnemonic + "\n", { mode: 0o600, flag: "wx" });
  return (await deriveNativeAccount(mnemonic)).address;
}

export async function loadAccount(file: string): Promise<Account> {
  const mnemonic = readMnemonic(file);
  const classical = deriveClassicalKey({ mnemonic });
  const address = addressFromPublicKey(classical.publicKey, "secp256k1").bech32;
  const native = await deriveNativeAccount(mnemonic);
  if (native.address !== address) throw new Error("QoreSign and the SDK derive different addresses from this key file.");
  const pq = deriveCanonicalPqKey({ mnemonic, address });
  const sdkPqc = derivePqcCanonical(address, mnemonic);
  if (toHex(sdkPqc.publicKey) !== toHex(pq.publicKey)) throw new Error("QoreSign and the SDK derive different ML-DSA-87 keys.");
  const evm = addressFromPublicKey(classical.publicKey, "secp256k1").hex as Address;
  return {
    address,
    evm,
    classical,
    pq,
    sdkPqc,
    privateKey: native.privateKey,
    sealKeys: deriveSealKeys({ mnemonic }),
    sealSeed: sealSeedFromMnemonic({ mnemonic }),
    relayer: await deriveUnifiedAccount(mnemonic, 0),
  };
}

export function sealKeyFile(a: Account, net: Network): SealKeyFile {
  return { kind: "sealed-disclosure/seal-key", version: 1, chainId: net.chainId, address: a.address, seed: toHex(a.sealSeed) };
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function balanceUqor(net: Network, address: string): Promise<bigint> {
  const r = await getJson<any>(net.rest, `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uqor`);
  return BigInt(r.json?.balance?.amount ?? 0);
}

export function formatQor(uqor: bigint): string {
  const whole = uqor / 1_000_000n;
  const frac = (uqor % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} QOR`;
}

async function pqcRegistered(net: Network, address: string): Promise<boolean> {
  const r = await getJson<any>(net.rest, `/qorechain/pqc/v1/account/${address}`);
  return Boolean(r.json?.found ?? r.json?.account);
}

async function waitTx(net: Network, hash: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const r = await getJson<any>(net.rest, `/cosmos/tx/v1beta1/txs/${hash}`);
    if (r.status === 200 && r.json?.tx_response) {
      if (r.json.tx_response.code !== 0) throw new Error(`Transaction ${hash} failed: code ${r.json.tx_response.code} ${r.json.tx_response.raw_log ?? ""}`);
      return;
    }
    await sleep(1500);
  }
  throw new Error(`Transaction ${hash} was not committed within a minute.`);
}

// ── native writes ────────────────────────────────────────────────────────────

function sdkClient(net: Network) {
  return createClient({ network: net.name, chainId: net.chainId, endpoints: { rest: net.rest, rpc: net.rpc, evmRpc: net.evmRpc } });
}

/** Register the account's ML-DSA-87 key (with proof of possession) unless it already is. */
export async function ensurePqKey(a: Account, net: Network, log: Log): Promise<string | undefined> {
  const tx = await sdkClient(net).connectTx(await directSignerFromPrivateKey(a.privateKey, "qor"), { pqcKeypair: a.sdkPqc });
  try {
    const reg = await ensurePqcRegistered(tx, { pqcKeypair: a.sdkPqc, rest: net.rest, chainId: net.chainId });
    if (reg.alreadyRegistered) {
      log("ML-DSA-87 key already registered.");
      return undefined;
    }
    log(`Registered the ML-DSA-87 key: ${reg.txHash}`);
    for (let i = 0; i < 10 && !(await pqcRegistered(net, a.address)); i++) await sleep(1500);
    return reg.txHash;
  } finally {
    tx.disconnect();
  }
}

/** A hybrid-signed (secp256k1 + ML-DSA-87) bank transfer. */
export async function sendQor(a: Account, net: Network, to: string, uqor: bigint, memo: string): Promise<string> {
  const tx = await sdkClient(net).connectTx(await directSignerFromPrivateKey(a.privateKey, "qor"), { pqcKeypair: a.sdkPqc });
  try {
    const msg = { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: a.address, toAddress: to, amount: [{ denom: "uqor", amount: uqor.toString() }] } };
    const res = await tx.signAndBroadcast([msg], "auto", memo);
    if (res.code !== 0) throw new Error(`Transfer ${res.transactionHash} failed with code ${res.code}.`);
    return res.transactionHash;
  } finally {
    tx.disconnect();
  }
}

/** One message in a hybrid-signed tx built with QoreSign (the QoreSeal quickstart's path). */
async function sendHybridRaw(a: Account, net: Network, msg: { typeUrl: string; value: Uint8Array }): Promise<string> {
  const info = await getJson<any>(net.rest, `/cosmos/auth/v1beta1/account_info/${a.address}`);
  if (!info.json?.info) throw new Error(`${a.address} has no account on ${net.chainId} yet; fund it first.`);
  const accountNumber = BigInt(info.json.info.account_number);
  const sequence = BigInt(info.json.info.sequence ?? "0");
  const bodyBytes = TxBody.encode(TxBody.fromPartial({ messages: [msg] })).finish();
  const sign = (gas: bigint) =>
    signHybrid({
      chainId: net.chainId,
      accountNumber,
      bodyBytes,
      authInfoBytes: makeAuthInfoBytes(
        [{ pubkey: encodePubkey(encodeSecp256k1Pubkey(a.classical.publicKey)), sequence }],
        [{ denom: "uqor", amount: ((gas * 15n + 99n) / 100n).toString() }], // 0.15 uqor per gas
        Number(gas),
        undefined,
        undefined,
        SignMode.SIGN_MODE_DIRECT,
      ),
      classicalKey: a.classical,
      pqKey: a.pq,
    }).txBytes;
  const sim = await simulateTx({ rest: net.rest, txBytes: sign(800_000n) });
  const res = await submitWithSignBytesFallback({ rest: net.rest, chainId: net.chainId, sign: () => sign(sim.suggestedGasLimit) });
  if (res.code !== 0) throw new Error(`Refused: ${describeKemRegistryError(res.codespace, res.code) ?? res.log}`);
  await waitTx(net, res.txhash);
  return res.txhash;
}

/** Publish the account's ML-KEM-1024 key (MsgRegisterKEMKey) unless that exact key is already registered. */
export async function ensureKemKey(a: Account, net: Network, log: Log): Promise<string | undefined> {
  const r = await getJson<any>(net.rest, `/qorechain/pqc/v1/kem/${a.address}`);
  const current: string | undefined = r.json?.key?.public_key;
  if (current && Buffer.from(current, "base64").equals(Buffer.from(a.sealKeys.mlkemPublicKey))) {
    log(`ML-KEM-1024 key already registered (height ${r.json.key.registered_height ?? "?"}).`);
    return undefined;
  }
  const hash = await sendHybridRaw(a, net, buildRegisterKemKeyMessage({ sender: a.address, mlkemPublicKey: a.sealKeys.mlkemPublicKey }));
  log(`Registered the ML-KEM-1024 key (hybrid-signed MsgRegisterKEMKey): ${hash}`);
  return hash;
}

/** QoreSign message signature (secp256k1 ADR-36 + ML-DSA-87 over "qorechain-msg-v1|chain|text"). */
export function signText(a: Account, net: Network, text: string) {
  return signMessage({ chainId: net.chainId, signer: a.address, data: text, classicalKey: a.classical, pqKey: a.pq });
}

// ── EVM writes through a scoped window ───────────────────────────────────────

/** Window: blocks open (~5 min at Diana's ~1.5 s blocks). */
const WINDOW_BLOCKS = 200;
/** Fee cap per EVM gas: a bit over twice the 112.5 gwei base fee seen on Diana. */
export const MAX_FEE_PER_GAS = 250_000_000_000n;
const PRIORITY_FEE_PER_GAS = 1_000_000_000n;
export const evmFees = { maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS };
const NATIVE_GAS = 800_000;
const NATIVE_FEE_UQOR = 120_000n;
const RELAYER_FLOOR_UQOR = 1_500_000n;
const RELAYER_TOPUP_UQOR = 3_000_000n;

async function accountSeq(net: Network, address: string) {
  const r = await getJson<any>(net.rest, `/cosmos/auth/v1beta1/accounts/${address}`);
  const base = r.json?.account?.base_account ?? r.json?.account;
  if (!base) throw new Error(`${address} has no account on ${net.chainId} yet.`);
  return { accountNumber: BigInt(base.account_number ?? 0), sequence: BigInt(base.sequence ?? 0) };
}

async function relayerNativeTx(relayer: UnifiedAccount, net: Network, messages: EncodeObject[], signMode: "hybrid" | "classical") {
  const signer = new EthNativeSigner(relayer, { signMode, signBytesVersion: "auto", rest: net.rest });
  const client = await StargateClient.connect(net.rpc);
  try {
    const res = await signer.signAndBroadcast(client, {
      chainId: net.chainId,
      messages,
      fee: { amount: [{ denom: "uqor", amount: NATIVE_FEE_UQOR.toString() }], gas: String(NATIVE_GAS) },
      ...(await accountSeq(net, relayer.cosmos)),
    });
    if (res.code !== 0) throw new Error(`Relayer tx ${res.transactionHash} failed with code ${res.code}: ${res.rawLog ?? ""}`);
    return res.transactionHash;
  } finally {
    client.disconnect();
  }
}

/** Fund the relayer from the account if it is low, and register its ML-DSA-87 key once. */
export async function readyRelayer(a: Account, net: Network, log: Log) {
  const relayer = a.relayer;
  let bal = await balanceUqor(net, relayer.cosmos);
  if (bal < RELAYER_FLOOR_UQOR) {
    const hash = await sendQor(a, net, relayer.cosmos, RELAYER_TOPUP_UQOR, "sealed-disclosure relayer gas");
    log(`Funded the relayer ${relayer.cosmos} with ${formatQor(RELAYER_TOPUP_UQOR)} (hybrid-signed): ${hash}`);
    for (let i = 0; i < 10 && bal < RELAYER_FLOOR_UQOR; i++) {
      await sleep(1500);
      bal = await balanceUqor(net, relayer.cosmos);
    }
  }
  if (!(await pqcRegistered(net, relayer.cosmos))) {
    const proofOfPossession = signProofOfPossession({ chainId: net.chainId, account: relayer.cosmos, keypair: relayer.pqc, algorithmId: 1 });
    const msg = buildRegisterPqcKeyMsg(relayer.cosmos, { pqcKeypair: relayer.pqc, keyType: "hybrid", proofOfPossession });
    // Registration is the one message the chain lets the classical key sign alone.
    const hash = await relayerNativeTx(relayer, net, [msg], "classical");
    log(`Registered the relayer's ML-DSA-87 key (with proof of possession): ${hash}`);
    for (let i = 0; i < 10 && !(await pqcRegistered(net, relayer.cosmos)); i++) await sleep(1500);
  }
}

/**
 * On QoreChain an EVM transaction is admitted only inside a window the account opened with a
 * hybrid-signed native message. Each write opens the narrowest one: 1 tx, 200 blocks, value for
 * its own fee only, and (except for a deploy) the inbox as the only allowed target.
 */
export async function openWindow(a: Account, net: Network, gas: bigint, allowedTargets: string[] | undefined, log: Log) {
  const maxValue = evmWindowCost({ gas, maxFeePerGas: MAX_FEE_PER_GAS });
  const msg = openEvmWindowMsg({ sender: a.relayer.cosmos, blocks: WINDOW_BLOCKS, maxTxs: 1, maxValue, ...(allowedTargets ? { allowedTargets } : {}) });
  const hash = await relayerNativeTx(a.relayer, net, [msg], "hybrid");
  log(`Opened a scoped EVM window (hybrid-signed): ${hash} (1 tx, ${WINDOW_BLOCKS} blocks, ${formatQor(maxValue)} max${allowedTargets ? `, only ${allowedTargets.join(", ")}` : ""})`);
  for (let i = 0; i < 15; i++) {
    const w = await evmWindowStatus({ rest: net.rest, address: a.relayer.cosmos });
    if (w.live) return hash;
    await sleep(1500);
  }
  throw new Error("The EVM window did not show up as live within ~20 s.");
}

export async function evmClients(a: Account, net: Network) {
  const client = await createEvmClient({ endpoints: { evmRpc: net.evmRpc } });
  const account = evmAccountFromPrivateKey(a.relayer.privateKey as Hex);
  if (account.address.toLowerCase() !== a.relayer.evm.toLowerCase()) throw new Error("Relayer key and address disagree.");
  return { client, account, wallet: client.getWalletClient(account) };
}

/** Make the relayer ready and open a window sized for `gas`; returns the window tx. */
export async function prepareEvmWrite(a: Account, net: Network, gas: bigint, target: string | undefined, log: Log) {
  await readyRelayer(a, net, log);
  log(`Relayer ${a.relayer.cosmos} (${a.relayer.evm}), the Ethereum-type account of the same key file.`);
  return openWindow(a, net, gas, target ? [target] : undefined, log);
}
