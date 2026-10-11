/**
 * Apagar imagens da RESPOSTA RÁPIDA do bucket — o espelho de
 * `lib/catalogo/fotos-no-bucket.ts`.
 *
 * A remoção é sempre DEPOIS de a linha estar gravada (PATCH) ou apagada
 * (DELETE): arquivo órfão é recuperação fácil, arquivo apagado com a linha
 * ainda apontando para ele é tela quebrada. Por isso a falha aqui NÃO derruba a
 * operação — ela é logada e segue, que é o único desenho que não perde o
 * pedido do operador por causa do Storage.
 *
 * O caminho é conferido NA ROTA (`midiaPertenceAoTemplate`) antes de chegar
 * aqui: `storage.remove` roda por service role, sem RLS — apagar é a operação
 * mais cara de errar.
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { BUCKET_DAS_MIDIAS } from "@/lib/templates/midias";

export async function apagarMidiasDoTemplate(
  caminhos: readonly string[],
  requestId: string,
): Promise<void> {
  if (caminhos.length === 0) return;
  const { error } = await createAdminClient().storage.from(BUCKET_DAS_MIDIAS).remove([...caminhos]);
  if (error) {
    logger.error("[message-templates] falha ao apagar imagem do template", {
      detalhe: error.message,
      requestId,
      quantidade: caminhos.length,
    });
  }
}
