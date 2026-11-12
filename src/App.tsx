import { sealKeysFromSeed, fromHex, type SealKeyPair } from "@qorechain/qoreseal";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listDrops, openDrop, parseSealKeyFile, resolveProject, sealReport, type Check, type DropEntry, type Opened, type ProjectStatus, type Sealed } from "./core/inbox";
import { browserNetwork } from "./core/networks";
import { SEVERITIES, newReport, shortHex, type Severity } from "./core/protocol";

/** The testnet demo project: its seal key ships with the page, so anything sent to it is readable by everyone. */
export const DEMO_PROJECT = "qor1knxej2kffzpx9hcfjd54argxj72vs962nw60fg";
const DEMO_SEAL_KEY = "/demo-project.sealkey.json";

type Tab = "report" | "inbox" | "how";

/**
 * Deep links, so a reviewer can land on a result in one click:
 *   ?project=<qor1…|demo>          check a project (Send a report tab)
 *   ?inbox=<qor1…|demo>[&key=demo] list an inbox, and open it with the demo seal key if this host serves it
 */
interface Link {
  tab: Tab;
  project?: string;
  inbox?: string;
  demoKey?: boolean;
}

function readLink(search: string): Link {
  const q = new URLSearchParams(search);
  const who = (v: string | null) => (v === "demo" ? DEMO_PROJECT : v?.trim() || undefined);
  const inbox = who(q.get("inbox"));
  if (inbox) return { tab: "inbox", inbox, demoKey: q.get("key") === "demo" };
  const project = who(q.get("project"));
  if (project) return { tab: "report", project };
  const tab = q.get("tab");
  return { tab: tab === "inbox" || tab === "how" ? tab : "report" };
}

/** Run `fn` once on mount (React strict mode mounts twice in dev). */
function useOnce(fn: () => void) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    fn();
  }, []);
}

function errorText(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return e?.shortMessage ?? e?.message ?? String(err);
}

function Checks({ checks }: { checks: Check[] }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.label}>
          <span className={`mark ${c.ok ? "pass" : "fail"}`}>{c.ok ? "PASS" : "FAIL"}</span>
          <strong>{c.label}</strong>
          {c.detail && <span className="muted"> · {c.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function AddressInput(props: { value: string; onChange: (v: string) => void; onGo: () => void; busy: boolean; go: string; id: string }) {
  return (
    <div className="row">
      <input
        id={props.id}
        value={props.value}
        placeholder="qor1… or 0x…"
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && props.onGo()}
      />
      <button className="primary" disabled={props.busy || !props.value.trim()} onClick={props.onGo}>
        {props.busy ? "Checking…" : props.go}
      </button>
    </div>
  );
}

function download(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ReportTab({ initial }: { initial?: string }) {
  const net = useMemo(() => browserNetwork("testnet", location.origin), []);
  const [project, setProject] = useState(initial ?? "");
  const [status, setStatus] = useState<ProjectStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [from, setFrom] = useState("");
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<Severity>("high");
  const [body, setBody] = useState("");
  const [contact, setContact] = useState("");
  const [sealed, setSealed] = useState<Sealed & { file: string; to: string }>();

  async function check(address = project) {
    setBusy(true);
    setError("");
    setStatus(undefined);
    setSealed(undefined);
    try {
      setStatus(await resolveProject(net, address));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  useOnce(() => initial && check(initial));

  async function seal() {
    setError("");
    setSealed(undefined);
    try {
      const report = newReport({ title, severity, body, contact });
      const s = await sealReport({ chainId: net.chainId, from, to: status!, report });
      setSealed({ ...s, file: `report-${s.digest.slice(2, 10)}.sealed`, to: status!.address });
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <>
      <section className="panel">
        <h2>1. Check the project</h2>
        <p>Before anything is written, the page reads the project's keys from the chain and checks they belong together.</p>
        <AddressInput id="project" value={project} onChange={setProject} onGo={() => check()} busy={busy} go="Check" />
        <div className="actions">
          <button className="link" onClick={() => { setProject(DEMO_PROJECT); check(DEMO_PROJECT); }}>
            Use the testnet demo project
          </button>
        </div>
        {status && (
          <div className={`verify ${status.recipient ? "ok" : "bad"}`} data-testid="project-checks">
            <p className="verify-head">{status.recipient ? "Ready to receive sealed reports" : "Not ready to receive reports"}</p>
            <code className="addr">{status.address}</code>
            <Checks checks={status.checks} />
          </div>
        )}
      </section>

      {status?.recipient && (
        <section className="panel">
          <h2>2. Write and seal the report</h2>
          <p>
            Sealed here, in this tab, to the project's ML-KEM-1024 + X25519 keys. The plain text is never sent anywhere; the
            envelope also names your address, so nobody can re-send it as their own.
          </p>
          <label htmlFor="from">Your address (the one that will sign the drop)</label>
          <input id="from" className="wide" value={from} placeholder="qor1…" spellCheck={false} onChange={(e) => setFrom(e.target.value)} />
          <div className="grid2">
            <div>
              <label htmlFor="title">Title</label>
              <input id="title" className="wide" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <label htmlFor="severity">Severity</label>
              <select id="severity" value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
                {SEVERITIES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
          <label htmlFor="body">Details: affected component, steps to reproduce, impact, suggested fix</label>
          <textarea id="body" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          <label htmlFor="contact">How to reach you (optional, travels encrypted)</label>
          <input id="contact" className="wide" value={contact} onChange={(e) => setContact(e.target.value)} />
          <div className="actions">
            <button className="primary" disabled={!from.trim() || !title.trim() || !body.trim()} onClick={seal}>
              Seal in this browser
            </button>
          </div>
        </section>
      )}

      {sealed && (
        <section className="panel" data-testid="sealed">
          <h2>3. Drop it in the inbox</h2>
          <ul className="facts">
            <li>Envelope: <strong>{sealed.envelope.length.toLocaleString()} bytes</strong></li>
            <li>SHA-256: <code>{shortHex(sealed.digest, 10)}</code></li>
            <li>Opens for: <strong>{sealed.to.slice(0, 12)}…</strong> only</li>
          </ul>
          <div className="actions">
            <button className="primary" onClick={() => download(sealed.file, sealed.envelope)}>Download {sealed.file}</button>
          </div>
          <p className="muted">
            Then sign and drop it with your key (QoreX cannot sign arbitrary messages yet, so the hybrid signature is made by the
            command line, which never sees your report in plain text):
          </p>
          <pre className="cmd">npm run sd -- drop --key &lt;your key file&gt; --to {sealed.to} --envelope {sealed.file}</pre>
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}

function DropCard({ d, opened }: { d: DropEntry; opened?: Opened }) {
  return (
    <article className={`card ${opened && !opened.ok ? "card-refused" : ""}`} data-testid="drop">
      <div className="drop-head">
        <span className="drop-id">#{d.id.toString()}</span>
        <div>
          <span className="muted">from</span> <code className="addr inline">{d.reporter}</code>
          <div className="muted small">
            block {d.blockNumber.toString()} · {new Date(Number(d.timestamp) * 1000).toISOString().replace(".000", "")} · {d.size.toLocaleString()} bytes ·{" "}
            {d.receiptBlock ? `acknowledged in block ${d.receiptBlock}` : "not acknowledged yet"}
          </div>
          <div className="muted small">
            tx <code>{shortHex(d.txHash, 8)}</code> · envelope <code>{shortHex(d.digest, 8)}</code>
          </div>
        </div>
      </div>
      {!opened && <p className="muted sealed-note">Sealed. Load the project's seal key to open it here.</p>}
      {opened && !opened.ok && <p className="error">Refused: {opened.reason}</p>}
      {opened?.ok && (
        <div className={`finding sev-${opened.report.severity}`}>
          <div>
            <span className="sev">{opened.report.severity}</span>
            <span className="finding-title">{opened.report.title}</span>
          </div>
          <p className="muted small">
            Opened in this browser. Written {opened.report.createdAt}; sealed by the address the inbox recorded as sender.
            {opened.report.contact && <> Contact: {opened.report.contact}</>}
          </p>
          <pre className="body">{opened.report.body}</pre>
        </div>
      )}
    </article>
  );
}

function InboxTab({ initial, demoKey }: { initial?: string; demoKey?: boolean }) {
  const net = useMemo(() => browserNetwork("testnet", location.origin), []);
  const [address, setAddress] = useState(initial ?? "");
  const [drops, setDrops] = useState<DropEntry[]>();
  const [opened, setOpened] = useState<Record<string, Opened>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [keyNote, setKeyNote] = useState("");

  async function load(a = address): Promise<DropEntry[] | undefined> {
    setBusy(true);
    setError("");
    setDrops(undefined);
    setOpened({});
    setKeyNote("");
    try {
      const list = await listDrops(net, a);
      setDrops(list);
      return list;
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function useKey(text: string, list = drops) {
    setError("");
    try {
      const f = parseSealKeyFile(text);
      if (f.chainId !== net.chainId) throw new Error(`This seal key is for ${f.chainId}, not ${net.chainId}.`);
      if (list?.length && list[0].recipient !== f.address) throw new Error(`This seal key belongs to ${f.address}, not to this inbox.`);
      const keys: SealKeyPair = sealKeysFromSeed(fromHex(f.seed));
      const out: Record<string, Opened> = {};
      for (const d of list ?? []) out[d.id.toString()] = await openDrop(net.chainId, d, keys);
      setOpened(out);
      const n = Object.values(out).filter((o) => o.ok).length;
      setKeyNote(`Seal key for ${shortHex(f.address, 6)} loaded in memory only. Opened ${n} of ${list?.length ?? 0}.`);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function useDemoKey(list = drops) {
    const r = await fetch(DEMO_SEAL_KEY).catch(() => undefined);
    if (!r?.ok) return setError("This deployment does not serve the demo seal key. Load a seal-key file instead.");
    await useKey(await r.text(), list);
  }

  useOnce(async () => {
    if (!initial) return;
    const list = await load(initial);
    if (demoKey && list?.[0]?.recipient === DEMO_PROJECT) await useDemoKey(list);
  });

  return (
    <>
      <section className="panel">
        <h2>Read an inbox</h2>
        <p>Anyone can list an inbox: the envelopes are public, the reports are not.</p>
        <AddressInput id="inbox" value={address} onChange={setAddress} onGo={() => load()} busy={busy} go="List drops" />
        <div className="actions">
          <button className="link" onClick={() => { setAddress(DEMO_PROJECT); load(DEMO_PROJECT); }}>
            Open the testnet demo project's inbox
          </button>
        </div>
      </section>
      {drops && (
        <section className="panel">
          <div className="inbox-head">
            <h2>{drops.length} drop{drops.length === 1 ? "" : "s"}</h2>
            <div className="actions">
              <label className="file">
                Load seal key…
                <input type="file" accept=".json,application/json" onChange={async (e) => { const f = e.target.files?.[0]; if (f) await useKey(await f.text()); e.target.value = ""; }} />
              </label>
              {drops[0]?.recipient === DEMO_PROJECT && (
                <button onClick={() => useDemoKey()}>Use the demo seal key</button>
              )}
            </div>
          </div>
          <p className="muted small">
            A seal key holds only the 32-byte QoreSeal seed: it decrypts, it cannot sign or move funds. Make one with{" "}
            <code>npm run sd -- export-seal-key --key &lt;key file&gt; --out me.sealkey.json</code>. It stays in this tab.
          </p>
          {keyNote && <p className="status">{keyNote}</p>}
          <div className="results">
            {drops.map((d) => (
              <DropCard key={d.id.toString()} d={d} opened={opened[d.id.toString()]} />
            ))}
          </div>
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}

function HowTab() {
  const net = browserNetwork("testnet", location.origin);
  const steps: [string, ReactNode][] = [
    ["Project publishes keys", <>an ML-KEM-1024 key in the chain's KEM registry (<code>MsgRegisterKEMKey</code>, hybrid-signed) and a recipient card naming that key and an X25519 key, signed with its secp256k1 + ML-DSA-87 keys and stored in the inbox contract. A newer card replaces an older one; an old card cannot be replayed.</>],
    ["Reporter checks and seals", <>the page reads both keys, verifies the card against the account's registered ML-DSA-87 key, and seals the report with QoreSeal (ML-KEM-1024 + X25519 → AES-256-GCM). The sender and recipient addresses are authenticated data of the envelope.</>],
    ["Reporter drops it", <>the reporter's ML-DSA-87 key signs a statement naming the inbox, both addresses and the envelope's SHA-256. <code>SealedInbox.drop</code> checks that signature on chain with the <code>pqcVerify</code> precompile against the key from <code>pqcKeyStatus</code> (proof of possession required), and records the block: a public, post-quantum-signed timestamp of who reported what, first.</>],
    ["Project opens it", <>only the project's keys open the envelope, in its browser. It opens only under the sender the inbox recorded, so a copied envelope re-dropped by someone else stays shut.</>],
    ["Project acknowledges", <>the project signs a receipt for the drop with its ML-DSA-87 key; the contract checks it the same way. The reporter can point to it.</>],
  ];
  return (
    <section className="panel">
      <h2>How it works</h2>
      <ol className="steps big">
        {steps.map(([h, t]) => (
          <li key={h}><strong>{h}:</strong> {t}</li>
        ))}
      </ol>
      <p className="muted small">
        Inbox on {net.chainId}: <code>{net.inbox}</code>. Every write is relayed by the account's own Ethereum-type key inside a
        one-transaction EVM window scoped to the inbox, opened with a hybrid-signed native message.
      </p>
    </section>
  );
}

export function App() {
  const link = useMemo(() => readLink(location.search), []);
  const [tab, setTab] = useState<Tab>(link.tab);
  // A deep link acts once, on the tab it opened; switching tabs starts clean.
  const [fresh, setFresh] = useState(true);
  const tabs: [Tab, string][] = [
    ["report", "Send a report"],
    ["inbox", "Inbox"],
    ["how", "How it works"],
  ];
  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Sealed Disclosure</h1>
          <p className="tag">Post-quantum vulnerability reports for QoreChain projects: sealed in your browser with ML-KEM-1024, opened only by the project, timestamped on chain with ML-DSA-87.</p>
        </div>
        <span className="pill">QoreChain testnet</span>
      </header>
      <nav className="tabs" role="tablist">
        {tabs.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => { setFresh(false); setTab(t); }}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "report" && <ReportTab initial={fresh ? link.project : undefined} />}
      {tab === "inbox" && <InboxTab initial={fresh ? link.inbox : undefined} demoKey={fresh && link.demoKey} />}
      {tab === "how" && <HowTab />}
      <footer className="foot">
        Open source (MIT). Built with create-qorechain-dapp, @qorechain/sdk, QoreSign, QoreSeal and viem. Testnet only: do not send real
        vulnerability details to the demo project, whose seal key is public.
      </footer>
    </div>
  );
}
