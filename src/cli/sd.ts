/**
 * sd: the Sealed Disclosure command line.
 *
 *   npm run sd -- keygen keys/project.mnemonic
 *   npm run sd -- whoami   --key keys/project.mnemonic
 *   npm run sd -- setup    --key keys/project.mnemonic [--seal-key-out project.sealkey.json]
 *   npm run sd -- export-seal-key --key keys/project.mnemonic --out project.sealkey.json
 *   npm run sd -- check    qor1...                     (exit 1 if the project cannot receive reports)
 *   npm run sd -- report   --key keys/reporter.mnemonic --to qor1... --title "..." --severity high --body-file r.md
 *   npm run sd -- seal     --from qor1... --to qor1... --title ... --severity ... --body-file ... --out r.sealed
 *   npm run sd -- drop     --key keys/reporter.mnemonic --to qor1... --envelope r.sealed
 *   npm run sd -- inbox    --key keys/project.mnemonic | --seal-key project.sealkey.json
 *   npm run sd -- ack      --key keys/project.mnemonic --id 0
 *   npm run sd -- fund     --key keys/a.mnemonic --to qor1... --qor 5
 *   npm run sd -- deploy   --key keys/a.mnemonic
 *
 * Every command takes --network testnet|mainnet (default testnet) and --inbox 0x... to use another deployment.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sealKeysFromSeed, fromHex } from "@qorechain/qoreseal";
import type { Address } from "viem";
import { listDrops, openDrop, parseSealKeyFile, resolveProject, sealReport, toAccount, type ProjectStatus } from "../core/inbox";
import { networkByName, type Network } from "../core/networks";
import { newReport, type Severity } from "../core/protocol";
import { balanceUqor, ensureKemKey, ensurePqKey, formatQor, keygen, loadAccount, sealKeyFile, sendQor } from "./account";
import { acknowledgeDrop, deployInbox, dropEnvelope, publishCard } from "./ops";

const log = (line: string) => console.log(line);

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
    } else pos.push(a);
  }
  return { pos, flags };
}

function need(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (!v || v === "true") throw new Error(`--${name} is required.`);
  return v;
}

function printChecks(st: ProjectStatus) {
  console.log(`Project ${st.address} (${st.evm})`);
  for (const c of st.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  console.log(st.recipient ? "  Ready: reports sealed to this address open only with its keys." : "  Not ready to receive reports.");
  if (!st.recipient) process.exitCode = 1;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const base = networkByName(flags.network ?? "testnet");
  const net: Network = flags.inbox ? { ...base, inbox: flags.inbox as Address, inboxFromBlock: undefined } : base;
  const account = async () => loadAccount(need(flags, "key"));

  switch (cmd) {
    case "keygen": {
      const file = pos[0] ?? need(flags, "out");
      console.log(`New key file ${file} (mode 600) for ${await keygen(file)}. Back it up; it is never printed.`);
      return;
    }
    case "whoami": {
      const a = await account();
      console.log(`Address:  ${a.address}\nEVM:      ${a.evm}\nRelayer:  ${a.relayer.cosmos} (${a.relayer.evm})`);
      console.log(`Balance:  ${formatQor(await balanceUqor(net, a.address))} (relayer ${formatQor(await balanceUqor(net, a.relayer.cosmos))})`);
      return;
    }
    case "fund": {
      const a = await account();
      const uqor = BigInt(Math.round(Number(need(flags, "qor")) * 1_000_000));
      const to = toAccount(need(flags, "to")).bech32;
      console.log(`Sent ${formatQor(uqor)} to ${to} (hybrid-signed): ${await sendQor(a, net, to, uqor, "sealed-disclosure test funds")}`);
      return;
    }
    case "deploy": {
      const a = await account();
      await ensurePqKey(a, net, log);
      const d = await deployInbox(a, net, log);
      console.log(`SealedInbox deployed at ${d.address} (block ${d.block}, ${d.gasUsed} gas). Put it in src/core/networks.ts.`);
      return;
    }
    case "setup": {
      // Make an address able to receive reports: ML-DSA-87 key, ML-KEM-1024 key, signed card in the inbox.
      const a = await account();
      log(`Setting up ${a.address} on ${net.chainId}.`);
      await ensurePqKey(a, net, log);
      await ensureKemKey(a, net, log);
      const before = await resolveProject(net, a.address);
      if (before.recipient && before.card && !flags["new-card"]) {
        log(`A verified card is already in the inbox (issued ${before.card.issuedAt}); pass --new-card to replace it.`);
      } else {
        const r = await publishCard(a, net, log);
        log(`Card issued ${r.card.issuedAt} published in block ${r.block}.`);
      }
      if (flags["seal-key-out"]) {
        writeFileSync(flags["seal-key-out"], JSON.stringify(sealKeyFile(a, net), null, 2) + "\n", { mode: 0o600, flag: "wx" });
        log(`Seal key written to ${flags["seal-key-out"]} (mode 600): it decrypts the inbox in the browser, it cannot sign or spend.`);
      }
      printChecks(await resolveProject(net, a.address));
      return;
    }
    case "export-seal-key": {
      const a = await account();
      const out = need(flags, "out");
      writeFileSync(out, JSON.stringify(sealKeyFile(a, net), null, 2) + "\n", { mode: 0o600, flag: "wx" });
      console.log(`Seal key for ${a.address} written to ${out} (mode 600).`);
      return;
    }
    case "check": {
      printChecks(await resolveProject(net, pos[0] ?? need(flags, "address")));
      return;
    }
    case "seal":
    case "report": {
      const a = cmd === "report" ? await account() : undefined;
      const from = a?.address ?? toAccount(need(flags, "from")).bech32;
      const st = await resolveProject(net, need(flags, "to"));
      printChecks(st);
      const report = newReport({
        title: need(flags, "title"),
        severity: need(flags, "severity") as Severity,
        body: flags["body-file"] ? readFileSync(flags["body-file"], "utf8") : need(flags, "body"),
        contact: flags.contact,
      });
      const s = await sealReport({ chainId: net.chainId, from, to: st, report });
      console.log(`Sealed ${s.envelope.length} bytes to ${s.recipients} recipient(s); SHA-256 ${s.digest}.`);
      if (cmd === "seal") {
        const out = need(flags, "out");
        writeFileSync(out, s.envelope, { flag: "wx" });
        console.log(`Envelope written to ${out}. Drop it with: npm run sd -- drop --key <your key file> --to ${st.address} --envelope ${out}`);
        return;
      }
      await ensurePqKey(a!, net, log);
      const d = await dropEnvelope(a!, net, st.address, s.envelope, s.digest, log);
      console.log(`Dropped as #${d.id} in block ${d.block} (${d.gasUsed} gas).`);
      return;
    }
    case "drop": {
      const a = await account();
      const to = toAccount(need(flags, "to")).bech32;
      const envelope = new Uint8Array(readFileSync(need(flags, "envelope")));
      const digest = `0x${Buffer.from(await crypto.subtle.digest("SHA-256", envelope)).toString("hex")}` as const;
      await ensurePqKey(a, net, log);
      const d = await dropEnvelope(a, net, to, envelope, digest, log);
      console.log(`Dropped as #${d.id} in block ${d.block} (${d.gasUsed} gas).`);
      return;
    }
    case "inbox": {
      let address: string;
      let keys;
      if (flags["seal-key"]) {
        const f = parseSealKeyFile(readFileSync(flags["seal-key"], "utf8"));
        if (f.chainId !== net.chainId) throw new Error(`The seal key is for ${f.chainId}, not ${net.chainId}.`);
        address = f.address;
        keys = sealKeysFromSeed(fromHex(f.seed));
      } else {
        const a = await account();
        address = a.address;
        keys = a.sealKeys;
      }
      const drops = await listDrops(net, address);
      console.log(`${drops.length} drop(s) for ${address}.`);
      for (const d of drops) {
        const when = new Date(Number(d.timestamp) * 1000).toISOString();
        console.log(`\n#${d.id}  from ${d.reporter}  block ${d.blockNumber} (${when})  ${d.size} bytes  tx ${d.txHash}`);
        console.log(`    envelope SHA-256 ${d.digest}  ${d.receiptBlock ? `acknowledged in block ${d.receiptBlock}` : "not acknowledged"}`);
        const o = await openDrop(net.chainId, d, keys);
        if (!o.ok) {
          console.log(`    could not open: ${o.reason}`);
          continue;
        }
        console.log(`    opened; the sender named on chain is the one it was sealed by.`);
        console.log(`    [${o.report.severity.toUpperCase()}] ${o.report.title}  (written ${o.report.createdAt})`);
        if (o.report.contact) console.log(`    contact: ${o.report.contact}`);
        console.log(o.report.body.split("\n").map((l) => `    | ${l}`).join("\n"));
      }
      return;
    }
    case "ack": {
      const a = await account();
      const r = await acknowledgeDrop(a, net, BigInt(need(flags, "id")), log);
      console.log(`Acknowledged in block ${r.block} (${r.gasUsed} gas).`);
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?|^ \* ?/gm, ""));
      if (cmd && cmd !== "help") process.exitCode = 2;
  }
}

main().catch((err) => {
  // viem errors carry the whole calldata (several KB of envelope): print the short form.
  const e = err as { shortMessage?: string; details?: string; message: string };
  console.error(`Error: ${e.shortMessage ? `${e.shortMessage}${e.details ? ` (${e.details})` : ""}` : e.message}`);
  process.exitCode = 1;
});
