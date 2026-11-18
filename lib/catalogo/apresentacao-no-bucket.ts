import "server-only";

import { audioPertenceAoProduto, BUCKET_DA_APRESENTACAO } from "@/lib/catalogo/apresentacao";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export async function removeCatalogPresentationAudio(
  organizationId: string,
  productId: string,
  path: string | null | undefined,
  requestId: string,
): Promise<void> {
  if (!path || !audioPertenceAoProduto(path, organizationId, productId)) return;
  const { error } = await createAdminClient()
    .storage.from(BUCKET_DA_APRESENTACAO)
    .remove([path]);
  if (error) {
    logger.warn("[products/ai-presentation/audio] remoção do arquivo falhou", {
      detail: error.message,
      requestId,
    });
  }
}
