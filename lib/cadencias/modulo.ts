/**
 * Duas decisões: a instalação TER o módulo e ESTA empresa tê-lo ligado.
 *
 * ─── Por que a organização entra na pergunta do módulo (#4871) ──────────────
 *
 * `cadencias` é módulo de TABELA (ADR-0002): a instalação o provisiona, e a
 * linha por empresa (`organization_modules`) só vale para módulos por FLAG — a
 * exceção por empresa dos módulos de tabela é a F3 do #3868, a mesma conversa de
 * `honorarios`/`financeiro`. Ou seja: passar `orgId` aqui NÃO muda a resposta
 * hoje. Ele entra porque a instalação é TETO, e teto perguntado sem a empresa é
 * a forma de o chamador esquecer que existe um nível abaixo; no dia em que a F3
 * abrir a linha por empresa para os módulos de tabela, este gate já a honra, sem
 * uma segunda função de decisão no meio.
 *
 * O que a EMPRESA desliga hoje, e que este arquivo já consulta, é a capacidade
 * dela: `settings.cadencias.enabled` (`fn_cadencias_configurar`), ligada a uma
 * empresa operante. Desligada ali, o worker não envia e o pixel não conta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehOperante } from "@/lib/organizacao/operante";
import { moduloLigado } from "@/lib/instalacao/modulos";

export function cadenciasHabilitadas(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  const value = (settings as { cadencias?: unknown }).cadencias;
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as { enabled?: unknown }).enabled === true;
}

/** Sem memo: desativar precisa impedir o próximo efeito do worker/pixel. */
export async function cadenciasLigadas(db: SupabaseClient, orgId: string): Promise<boolean> {
  try {
  if (!(await moduloLigado(db, "cadencias", orgId))) return false;
  const { data, error } = await db.from("organizations").select("settings, status").eq("id", orgId).maybeSingle();
  return !error && ehOperante(data?.status) && cadenciasHabilitadas(data?.settings);
  } catch { return false; }
}
