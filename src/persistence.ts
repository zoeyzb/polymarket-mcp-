import type { ScanResult } from "./types.js";

const SUPABASE_URL = process.env.POLYMARKET_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.POLYMARKET_SUPABASE_PUBLISHABLE_KEY || "";
const INGEST_SECRET = process.env.POLYMARKET_INGEST_SECRET || "";
const TIMEOUT_MS = Math.max(1000, Number(process.env.PERSISTENCE_TIMEOUT_MS || 8000));

function configured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY && INGEST_SECRET);
}

async function rpc<T>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!configured()) throw new Error("persistence_not_configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        apikey: SUPABASE_KEY,
        authorization: `Bearer ${SUPABASE_KEY}`,
        "content-type": "application/json",
        "x-polymarket-ingest-secret": INGEST_SECRET
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`persistence_rpc_${response.status}: ${text.slice(0, 300)}`);
    }

    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function persistScan(scan: ScanResult) {
  if (!configured()) return { ok: false, configured: false, reason: "not_configured" };
  const result = await rpc<Record<string, unknown>>("ingest_polymarket_scan", {
    scan_payload: scan
  });
  return { configured: true, ...result };
}

export async function getPersistentStats() {
  if (!configured()) return { configured: false, reason: "not_configured" };
  const result = await rpc<Record<string, unknown>>("polymarket_brain_stats");
  return { configured: true, ...result };
}

export function persistenceConfig() {
  return {
    configured: configured(),
    backend: configured() ? "supabase_postgres" : "disabled"
  };
}
