/**
 * A CÓPIA do material para a pasta da conversa (#4129).
 *
 * Mesmo contrato de `copiarFotoNoStorage` (`agent/fotos-do-produto.ts`): a
 * origem vem do bucket privado da empresa e o destino é a pasta da conversa em
 * `whatsapp-media`, por service role. `409/already exists` É SUCESSO — o
 * arquivo que precisamos já está lá, e é isso que torna o reenvio e o replay do
 * job idempotentes sem checar nada antes.
 *
 * Vive fora do módulo do agente porque o handler MCP (`crm_send_material`)
 * copia pelo MESMO caminho: duas cópias da cópia divergiriam justamente no
 * tratamento do 409, que é o ponto sutil.
 */
import { createAdminClient } from '@/lib/supabase/admin';

import { BUCKET_DA_CONVERSA, BUCKET_DOS_MATERIAIS } from './materiais';

/** Copia do bucket da empresa para a conversa. `true` = o arquivo está no destino. */
export type CopiarMaterial = (origem: string, destino: string) => Promise<boolean>;

interface Log {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export function copiarMaterialNoStorage(log: Log): CopiarMaterial {
  return async (origem, destino) => {
    const { error } = await createAdminClient()
      .storage.from(BUCKET_DOS_MATERIAIS)
      .copy(origem, destino, { destinationBucket: BUCKET_DA_CONVERSA });
    if (!error) return true;
    // Já copiado antes para esta conversa: o arquivo que precisamos está lá.
    if (/already exists/i.test(error.message) || (error as { statusCode?: string }).statusCode === '409') {
      return true;
    }
    log.warn('material da empresa não copiado para a conversa', {
      detalhe: error.message.slice(0, 120),
    });
    return false;
  };
}
