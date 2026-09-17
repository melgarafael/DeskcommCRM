import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { clientePelaAgendaLigado } from "@/lib/schemas/settings";

/**
 * A regra "cliente pela agenda" está ligada nesta organização? — para o SERVIDOR.
 *
 * Existe para o caminho que não passa pelo layout: o nascimento do lead, que
 * roda na ingestão com o client de service role. A tela lê a mesma chave pelo
 * `ActiveOrg` que o layout já monta.
 *
 * ⚠️ FALHA LÊ COMO DESLIGADA, e isso é o desenho. Quem consome isto escolhe o
 * funil de um lead que vai nascer de qualquer jeito: errar para o funil padrão
 * é o comportamento de antes da regra existir, visível e corrigível; lançar
 * aqui impediria o lead de nascer. O erro não some — vai para o log com a
 * organização.
 *
 * `organizationId` vem sempre de fonte confiável (o chamador já filtrou por
 * ela); o filtro explícito é a regra de todo acesso com service role.
 */
export async function lerClientePelaAgenda(
  db: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();

  if (error) {
    logger.warn("[cliente-pela-agenda] leitura do interruptor falhou", {
      organization_id: organizationId,
      error: error.message,
    });
    return false;
  }
  if (!data) return false;
  return clientePelaAgendaLigado((data as { settings?: unknown }).settings);
}
