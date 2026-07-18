import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * G4-00 — hardening (INB-07): 6 funções SECURITY DEFINER de ESCRITA NÃO podem
 * ser executáveis por `anon` (migration 0034). O ALTER DEFAULT PRIVILEGES do
 * baseline (paridade Supabase) concede EXECUTE a anon em toda função nova de
 * public, e `revoke from public` não cobre esse grant direto — sem o revoke
 * explícito o PostgREST as exporia como RPC à anon key pública.
 *
 * Prova SOB role `anon` REAL no container (set role anon + JWT vazio, o mesmo
 * shape do PostgREST anônimo) que cada função → permission denied, e que o
 * caminho service_role continua com EXECUTE (probe positivo).
 */

// [nome, chamada com args dummy, assinatura regprocedure].
// O permission denied acontece na resolução da função (antes do corpo), então
// args dummy bastam. A assinatura exata é a que o revoke/regprocedure exige.
const DEFINER_WRITE_FNS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "fn_upsert_wa_contact",
    "public.fn_upsert_wa_contact(null::uuid, null::text, null::text, null::text, null::text, null::text)",
    "public.fn_upsert_wa_contact(uuid, text, text, text, text, text)",
  ],
  [
    "fn_upsert_wa_conversation",
    "public.fn_upsert_wa_conversation(null::uuid, null::uuid, null::uuid)",
    "public.fn_upsert_wa_conversation(uuid, uuid, uuid)",
  ],
  [
    "fn_mark_conversation_message",
    "public.fn_mark_conversation_message(null::uuid, null::text, null::text, null::timestamptz)",
    "public.fn_mark_conversation_message(uuid, text, text, timestamptz)",
  ],
  [
    "emit_event",
    "public.emit_event(null::text, null::text, null::uuid, null::jsonb, null::jsonb, null::uuid)",
    "public.emit_event(text, text, uuid, jsonb, jsonb, uuid)",
  ],
  [
    "fn_log_event",
    "public.fn_log_event(null::uuid, null::text, null::jsonb)",
    "public.fn_log_event(uuid, text, jsonb)",
  ],
  ["fn_audit_log_row", "public.fn_audit_log_row()", "public.fn_audit_log_row()"],
];

/** Executa a chamada sob role anon real; devolve o stderr do psql (permission denied esperado). */
function callAsAnon(call: string): string {
  try {
    sql(`
      set role anon;
      select set_config('request.jwt.claims', '{}', false);
      select ${call};
    `);
    return "";
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? "";
  }
}

function hasExecute(role: string, signature: string): boolean {
  return (
    lastLine(sql(`select has_function_privilege('${role}', '${signature}'::regprocedure, 'EXECUTE');`)) ===
    "t"
  );
}

describe("G4-00 — hardening: anon sem EXECUTE em SECURITY DEFINER de escrita", () => {
  it.each(DEFINER_WRITE_FNS)("%s → permission denied sob role anon", (_name, call) => {
    const stderr = callAsAnon(call);
    expect(stderr).toContain("permission denied");
  });

  it.each(DEFINER_WRITE_FNS)(
    "%s: EXECUTE revogado de anon, preservado em service_role (probe positivo)",
    (_name, _call, signature) => {
      expect(hasExecute("anon", signature)).toBe(false);
      expect(hasExecute("service_role", signature)).toBe(true);
    },
  );
});
