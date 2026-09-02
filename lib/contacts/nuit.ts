/**
 * NUIT normalization + hashing helpers.
 *
 * `nuit_hash` is sha256(hex) of the normalized NUIT — used for exact-match
 * lookup and dedup without exposing plaintext. At-rest encryption (column
 * `nuit_encrypted bytea`) requires a server-side `encrypt_nuit` SQL function which
 * is not yet provisioned — see follow-up note in EPIC-05 commit message.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export function normalizeNuit(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Stable sha256 hex of normalized NUIT for fuzzy/exact search via `nuit_hash`.
 */
export function hashNuit(raw: string): string {
  return createHash("sha256").update(normalizeNuit(raw)).digest("hex");
}

/**
 * At-rest NUIT encryption via pgcrypto-backed `encrypt_nuit` RPC.
 *
 * Returns null when the RPC is not yet provisioned in the database — caller
 * should still persist `nuit_hash` and emit a single console.warn (we tolerate
 * the gap until the migration lands).
 */
export async function encryptNuitSql(
  supabase: SupabaseClient,
  plaintext: string,
): Promise<Uint8Array | null> {
  const { data, error } = await supabase.rpc("encrypt_nuit", { p_plaintext: plaintext });
  if (error) {
    console.warn(
      "[contacts.nuit] encrypt_nuit RPC unavailable — storing nuit_hash only.",
      error.message,
    );
    return null;
  }
  if (!data) return null;
  return data as Uint8Array;
}
