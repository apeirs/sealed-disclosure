/** Save drop <id>'s envelope from the live inbox to a file: tsx scripts/save-envelope.ts <recipient> <id> <out> */
import { writeFileSync } from "node:fs";
import { listDrops } from "../src/core/inbox";
import { NETWORKS } from "../src/core/networks";
const [to, id, out] = process.argv.slice(2);
const d = (await listDrops(NETWORKS.testnet, to)).find((x) => x.id === BigInt(id));
if (!d) throw new Error(`No drop ${id} for ${to}.`);
writeFileSync(out, d.envelope);
console.log(`Saved ${d.envelope.length} bytes (SHA-256 ${d.digest}) to ${out}.`);
