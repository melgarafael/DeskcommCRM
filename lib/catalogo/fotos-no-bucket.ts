import "server-only";

import { BUCKET_DAS_FOTOS, fotoPertenceAoProduto } from "@/lib/catalogo/fotos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Apaga do bucket — só o que é DESTE produto. A lista vem da linha, e a linha é
 * gravável pelo PostgREST: sem o filtro, um caminho de outra organização
 * gravado ali seria apagado por esta rota, que roda como service role.
 * Falha aqui não desfaz nada: a foto já saiu do produto, e o que sobra é um
 * arquivo que ninguém referencia.
 */
export async function apagarDoBucket(
  orgId: string,
  id: string,
  caminhos: readonly string[],
  requestId: string,
): Promise<void> {
  const deste = caminhos.filter((c) => fotoPertenceAoProduto(c, orgId, id));
  if (deste.length === 0) return;
  const { error } = await createAdminClient().storage.from(BUCKET_DAS_FOTOS).remove(deste);
  if (error) {
    logger.warn("[produtos/fotos] remoção do arquivo falhou", { detalhe: error.message, requestId });
  }
}
