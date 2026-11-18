/**
 * Depois de o `send_message` com `produto_codigo` SAIR, o produto vira etiqueta
 * do negócio (a regra e o porquê estão em `lib/leads/etiqueta-do-produto-apresentado.ts`).
 *
 * Mora fora do `execute` do `send_message` por uma razão só: aquele `execute`
 * é uma closure do turno sem ponto de injeção barato, e as três garantias que
 * importam aqui precisam ser provadas por COMPORTAMENTO, não por leitura do
 * fonte —
 *
 *   1. só etiqueta o que o canal disse que ENVIOU (`sent`/`already_sent`):
 *      prévia, veto, fila, bloqueio e falha não são produto apresentado;
 *   2. NUNCA lança: a mensagem ao cliente já saiu quando isto roda, e uma
 *      exceção aqui viraria erro da ferramenta — o modelo leria "falhou" sobre
 *      uma mensagem entregue e mandaria de novo;
 *   3. o que aconteceu vai para o log do turno — etiquetou, por que não
 *      etiquetou, ou o erro.
 */
import type pg from 'pg';

import { etiquetarNegocioComProdutoApresentado } from '@/lib/leads/etiqueta-do-produto-apresentado';

import type { ChannelSendResult } from '../channel-adapter';
import type { Logger } from '../obs/logger';

export async function etiquetarProdutoAposEnvio(
  pool: pg.Pool,
  log: Logger,
  input: {
    /** Turno de prévia (teste da tela): nada sai, nada se etiqueta. */
    preview: boolean;
    /** O código que resolveu um produto ativo do catálogo; `null` sem produto. */
    produtoApresentado: string | null;
    outcome: ChannelSendResult;
    tenantId: string;
    /** No motor, "lead" é o CONTATO. */
    contactId: string;
    agentId: string | null;
  },
  etiquetar: typeof etiquetarNegocioComProdutoApresentado = etiquetarNegocioComProdutoApresentado,
): Promise<void> {
  const { outcome } = input;
  if (input.preview || input.produtoApresentado === null) return;
  if (outcome.kind !== 'sent' && outcome.kind !== 'already_sent') return;
  try {
    const r = await etiquetar(pool, {
      organizationId: input.tenantId,
      contactId: input.contactId,
      codigo: input.produtoApresentado,
      agentId: input.agentId,
      messageId: outcome.messageId,
    });
    if (r.etiquetou) {
      log.info('negócio etiquetado com o produto apresentado', {
        lead_id: r.leadId,
        etiqueta: r.etiqueta,
        ...(r.falhasDoRastro.length > 0 ? { falhas_do_rastro: r.falhasDoRastro } : {}),
      });
    } else {
      log.info('produto apresentado sem etiqueta no negócio', {
        motivo: r.motivo,
        ...(r.leadId ? { lead_id: r.leadId } : {}),
        ...(r.etiqueta ? { etiqueta: r.etiqueta } : {}),
      });
    }
  } catch (err) {
    log.warn('falha ao etiquetar o negócio com o produto apresentado (segue)', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}
