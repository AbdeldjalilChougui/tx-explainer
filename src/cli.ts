#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { explain, render, toJSON } from "./explain.js";
import { fetchTransaction, CLUSTERS } from "./rpc.js";
import type { Idl } from "./anchor.js";

const HELP = `tx-explainer: decode a Solana transaction into plain language

Usage:
  tx-explainer <signature> [--cluster devnet|testnet|localnet|mainnet] [--rpc URL]
  tx-explainer --raw <base64|base58>
  tx-explainer --file tx.json          # saved getTransaction (base64) response
  tx-explainer serve [--port 8787]     # small web UI

Options:
  --idl path.json   Anchor IDL (0.30+) to decode that program (repeatable)
  --json            print JSON instead of text
`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function all(args: string[], name: string): string[] {
  return args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  if (args[0] === "serve") return serve(Number(arg(args, "--port") ?? 8787));
  const idls = all(args, "--idl").map((p) => JSON.parse(readFileSync(p, "utf8")) as Idl);
  let e;
  const raw = arg(args, "--raw");
  const file = arg(args, "--file");
  if (raw) e = explain({ raw }, { idls });
  else if (file) e = explain({ rpc: JSON.parse(readFileSync(file, "utf8")) }, { idls });
  else {
    const sig = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
    if (!sig) throw new Error("missing signature");
    const rpc = arg(args, "--rpc") ?? CLUSTERS[arg(args, "--cluster") ?? "devnet"];
    if (!rpc) throw new Error("unknown cluster");
    e = explain({ rpc: await fetchTransaction(sig, rpc) }, { idls });
  }
  process.stdout.write(args.includes("--json") ? JSON.stringify(toJSON(e), null, 2) + "\n" : render(e));
}

function serve(port: number) {
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = [join(here, "../web"), join(here, "../../web")].find((d) => existsSync(join(d, "index.html")));
  if (!webDir) throw new Error("web/ not found; run `pnpm build` first");
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  createServer((req, res) => {
    const p = req.url === "/" || !req.url ? "/index.html" : req.url.split("?")[0];
    const f = join(webDir, p.replace(/\.\./g, ""));
    if (!existsSync(f)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
  }).listen(port, "127.0.0.1", () => console.log(`tx-explainer UI on http://127.0.0.1:${port}`));
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
