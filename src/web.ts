// Browser entry, bundled by scripts/build-web.mjs into web/app.js.
import { explain, render } from "./explain.js";
import { fetchTransaction, CLUSTERS } from "./rpc.js";
import type { Idl } from "./anchor.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function run() {
  const out = $<HTMLPreElement>("out");
  out.textContent = "…";
  try {
    const input = $<HTMLTextAreaElement>("input").value.trim();
    const cluster = $<HTMLSelectElement>("cluster").value;
    const idlText = $<HTMLTextAreaElement>("idl").value.trim();
    const idls: Idl[] = idlText ? [JSON.parse(idlText)] : [];
    const isSig = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(input);
    const e = isSig
      ? explain({ rpc: await fetchTransaction(input, CLUSTERS[cluster]) }, { idls })
      : explain({ raw: input }, { idls });
    out.textContent = render(e);
  } catch (err) {
    out.textContent = `Error: ${(err as Error).message}`;
  }
}

$("go").addEventListener("click", run);
