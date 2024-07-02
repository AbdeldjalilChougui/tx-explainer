import type { RpcTransaction } from "./explain.js";

export const CLUSTERS: Record<string, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  localnet: "http://127.0.0.1:8899",
  mainnet: "https://api.mainnet-beta.solana.com",
};

/** Fetch a transaction by signature (read-only JSON-RPC call). */
export async function fetchTransaction(signature: string, rpcUrl: string, fetchImpl: typeof fetch = fetch): Promise<RpcTransaction> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: RpcTransaction | null; error?: { message: string } };
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  if (!body.result) throw new Error(`transaction ${signature} not found (wrong cluster, or too old for this RPC?)`);
  return body.result;
}
