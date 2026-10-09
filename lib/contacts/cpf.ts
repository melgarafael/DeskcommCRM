/**
 * CPF normalization + hashing helpers.
 *
 * `cpf_hash` is sha256(hex) of the 11-digit normalized CPF — used for exact-match
 * lookup and dedup without exposing plaintext. At-rest encryption lives in the
 * column `cpf_encrypted bytea`, written by the server-side `encrypt_cpf` RPC
 * (migration 0597, #2522).
 *
 * ⚠️ The two columns are a PAIR: `contacts_cpf_consistency` requires
 * `(cpf_encrypted IS NULL) = (cpf_hash IS NULL)`, so a row with only `cpf_hash`
 * is refused by the database — that is exactly how every contact WITH CPF failed
 * to save before #2522. Use `camposCpfParaGravar`, never `hashCpf` alone.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export function normalizeCpf(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Stable sha256 hex of normalized CPF for fuzzy/exact search via `cpf_hash`.
 */
export function hashCpf(raw: string): string {
  return createHash("sha256").update(normalizeCpf(raw)).digest("hex");
}

/**
 * At-rest CPF encryption via pgcrypto-backed `encrypt_cpf` RPC (migration 0597).
 *
 * Returns `null` whenever the database cannot produce the ciphertext — the RPC
 * still missing on a database that predates 0597, or `CPF_ENCRYPTION_KEY` not
 * seeded yet (`encrypt_cpf` raises `CPF_ENCRYPTION_KEY ausente`). The caller
 * must then save the contact WITHOUT the CPF: `camposCpfParaGravar` is what
 * keeps the pair `cpf_hash`/`cpf_encrypted` consistent for the CHECK.
 */
export async function encryptCpfSql(
  supabase: SupabaseClient,
  plaintext: string,
): Promise<Uint8Array | null> {
  const { data, error } = await supabase.rpc("encrypt_cpf", { p_plaintext: plaintext });
  if (error) {
    console.warn(
      "[contacts.cpf] encrypt_cpf RPC unavailable — contact saved WITHOUT cpf " +
        "(contacts_cpf_consistency refuses a row with cpf_hash only).",
      error.message,
    );
    return null;
  }
  if (!data) return null;
  return data as Uint8Array;
}

/**
 * The CPF columns for an insert/patch row — BOTH or NEITHER (#2522).
 *
 * `contacts_cpf_consistency` is `(cpf_encrypted IS NULL) = (cpf_hash IS NULL)`:
 * writing `cpf_hash` while encryption is unavailable made the database refuse
 * the WHOLE row (CSV import, POST /api/v1/contacts and edit alike). Saving the
 * contact without the CPF is the degradation documented in the issue; losing
 * CPF search for that one row is the price, losing the row never was.
 *
 * Returns `{}` when the CPF cannot be encrypted, so spreading the result into
 * the row touches nothing.
 */
export async function camposCpfParaGravar(
  supabase: SupabaseClient,
  raw: string,
): Promise<{ cpf_hash?: string; cpf_encrypted?: Uint8Array }> {
  const enc = await encryptCpfSql(supabase, raw);
  if (!enc) return {};
  return { cpf_hash: hashCpf(raw), cpf_encrypted: enc };
}
