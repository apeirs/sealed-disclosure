// Is the live SealedInbox the contract in this repo? Compares the code at the inbox address with the
// runtime bytecode in contracts/SealedInbox.artifact.ts (which `npm run compile:contracts` rebuilds
// from contracts/SealedInbox.sol; CI checks that step). One eth_getCode call, no key needed.
//   npm run verify:deployment [-- testnet|mainnet]
import { sealedInboxDeployedBytecode } from "../contracts/SealedInbox.artifact";
import { publicClient } from "../src/core/inbox";
import { networkByName } from "../src/core/networks";

const net = networkByName(process.argv[2]);
if (!net.inbox) throw new Error(`No SealedInbox is deployed on ${net.chainId}.`);
const code = (await publicClient(net).getCode({ address: net.inbox })) ?? "0x";
const same = code.toLowerCase() === sealedInboxDeployedBytecode.toLowerCase();
console.log(`${net.chainId} ${net.inbox}: ${(code.length - 2) / 2} bytes on chain, ${(sealedInboxDeployedBytecode.length - 2) / 2} in the artifact`);
console.log(same ? "MATCH: the deployed inbox runs exactly the compiled contracts/SealedInbox.sol" : "MISMATCH");
process.exitCode = same ? 0 : 1;
