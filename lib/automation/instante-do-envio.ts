/**
 * O INSTANTE DO ENVIO — quem sabe que horas são no fuso do canal (#3687).
 *
 * `{{saudacao}}` só pode resolver na hora de MANDAR: cravar "Bom dia" na
 * preparação faria a mensagem chegar às 16h dizendo bom dia. Este helper existe
 * para que o motor não pague a leitura quando o texto não usa saudação — a régua
 * é a mesma de `{{resumo}}` em `send-email.ts`: uma consulta só quando há o que
 * resolver.
 *
 * O fuso é o da ORGANIZAÇÃO, como no follow-up (`texto-do-followup.ts`): a ação
 * de envio não tem, neste ponto, a sessão do canal em mãos — e o fuso da
 * organização é a mesma reserva que a janela usa (`fusoDaJanela`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { fusoDaOrganizacao } from "@/lib/automation/cron-de-data";
import type { InstanteDoEnvio } from "@/lib/variaveis/resolvedor";

/** O texto pede `{{saudacao}}`? (Só nesse caso vale a leitura extra.) */
export function usaSaudacao(texto: string): boolean {
  return /\{\{\s*saudacao\s*(?:\||\}\})/i.test(texto);
}

/**
 * Instante + fuso do envio, ou `undefined` quando o texto não usa saudação — e
 * aí o token continua literal, que é o comportamento de sempre.
 */
export async function instanteDoEnvio(
  admin: SupabaseClient,
  organizationId: string,
  ...textos: string[]
): Promise<InstanteDoEnvio | undefined> {
  if (!textos.some(usaSaudacao)) return undefined;
  const { data } = await admin
    .from("organizations")
    .select("timezone")
    .eq("id", organizationId)
    .maybeSingle();
  return {
    instante: new Date(),
    fuso: fusoDaOrganizacao((data as { timezone?: string | null } | null)?.timezone),
  };
}
