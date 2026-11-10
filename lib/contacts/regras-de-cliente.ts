/**
 * AS REGRAS QUE DECIDEM "É CLIENTE?" — lidas do banco de UMA vez (#3644).
 *
 * ═══ Por que existe, se `lerClientePelaAgenda` já lia a mesma linha ═══
 *
 * Porque a pergunta cresceu de uma chave para três. O nascimento do lead decide
 * o funil por `settings.crm.cliente_pela_agenda` E `settings.crm.cliente_pela_venda`,
 * e a janela de `pos_venda_dias` pela terceira. Lendo chave por chave, seriam
 * três `select settings` na MESMA linha de `organizations` — no caminho quente
 * da ingestão, a cada mensagem recebida que chega perto de criar um card. Uma
 * leitura, três respostas.
 *
 * ═══ Falha = desligado, e isso é o desenho ═══
 *
 * Quem consome isto escolhe o funil de um lead que vai nascer de qualquer jeito.
 * Errar para o funil padrão é o comportamento de antes das regras existirem,
 * visível e corrigível; lançar aqui impediria o lead de nascer — a pessoa
 * sumiria, que é a doença que `nascimento-do-lead.ts` inteiro existe para curar.
 * O erro não some: vai para o log com a organização.
 *
 * `organizationId` vem sempre de fonte confiável (o chamador já filtrou por ela);
 * o filtro explícito é a regra de todo acesso com service role.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { regrasDeCliente, type RegrasDeCliente } from "@/lib/schemas/settings";

/** O estado de uma organização que nunca configurou nada — e o de toda falha. */
export const REGRAS_DE_CLIENTE_PADRAO: RegrasDeCliente = {
  pelaAgenda: false,
  pelaVenda: false,
  posVendaDias: 0,
};

export async function lerRegrasDeCliente(
  db: SupabaseClient,
  organizationId: string,
): Promise<RegrasDeCliente> {
  const { data, error } = await db
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();

  if (error) {
    logger.warn("[regras-de-cliente] leitura das regras falhou", {
      organization_id: organizationId,
      error: error.message,
    });
    return REGRAS_DE_CLIENTE_PADRAO;
  }
  if (!data) return REGRAS_DE_CLIENTE_PADRAO;
  return regrasDeCliente((data as { settings?: unknown }).settings);
}
