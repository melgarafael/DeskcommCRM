/**
 * RECUSA DEFINITIVA DO CANAL ENCERRA O TURNO — SEM RE-TENTAR, COM AVISO.
 *
 * Antes: todo `failed` do envio lançava no fim do turno ("run re-tentado pela
 * fila"). Para uma queda do provedor (5xx, rede) isso é o certo — a próxima
 * tentativa sai. Para uma recusa do CONTEÚDO (4xx: formato, mídia, conversa)
 * era um laço: a fila re-rodava o turno inteiro, o modelo escrevia de novo, o
 * canal recusava de novo, e cada volta deixava mais um balão vermelho na
 * conversa do cliente (medido ao vivo em 15/11/2026, áudio numa rede social).
 *
 * A natureza nasce no adapter e chega aqui pronta no desfecho
 * (`ChannelSendResult.permanente` — ver `lib/channels/falha-de-envio.ts`). Este
 * módulo só decide o que o turno faz com ela.
 *
 * Mandar duas vezes é pior que não mandar: a falha permanente NUNCA vira nova
 * tentativa, nem neste turno nem pela fila. Quem resolve é uma pessoa, avisada
 * na Central.
 */
import type pg from 'pg';

import type { ChannelSendResult } from '../channel-adapter';
import { insertInboxItem } from '../db/repository';
import type { Logger } from '../obs/logger';

type Queryable = Pick<pg.Pool, 'query'>;

/**
 * O que o fim do turno faz com os envios dele.
 *
 *   - `retentar`: houve falha TRANSITÓRIA — o turno lança e a fila re-tenta.
 *     Ganha da permanente: a próxima volta pode entregar o que caiu, e a recusa
 *     definitiva do mesmo corpo não sai de novo (o `send_ledger` a devolve sem
 *     chamar o canal);
 *   - `falha_permanente`: só recusas definitivas — o turno termina, sem retry;
 *   - `segue`: nenhuma falha.
 */
export type DesfechoDosEnvios = 'segue' | 'retentar' | 'falha_permanente';

export function desfechoDosEnvios(outcomes: readonly ChannelSendResult[]): DesfechoDosEnvios {
  const falhas = outcomes.filter((o) => o.kind === 'failed');
  if (falhas.length === 0) return 'segue';
  if (falhas.some((o) => o.kind === 'failed' && o.permanente !== true)) return 'retentar';
  return 'falha_permanente';
}

/** O desfecho que o modelo vê quando o canal recusou em definitivo. */
export const ERRO_DA_FALHA_PERMANENTE = {
  code: 'envio_recusado_pelo_canal',
  message:
    'o canal recusou esta mensagem em definitivo — não reenvie nem reescreva neste turno: ' +
    'encerre o turno agora. A equipe foi avisada e vai assumir a conversa.',
} as const;

/** Título FIXO: é parte da chave do dedupe (`kind_ref_e_titulo`) — mudar o texto reabre avisos. */
export const TITULO_DO_AVISO_DE_FALHA_PERMANENTE =
  'A IA não conseguiu responder: o canal recusou a mensagem';

/**
 * Avisa a equipe na Central, um aviso ABERTO por conversa (dedupe
 * `kind_ref_e_titulo`, o molde de `teto-de-respostas.ts`). O motivo exato está
 * na própria mensagem que falhou, na conversa — o aviso leva até ela.
 *
 * **Nunca lança.** A falha já está registrada na mensagem e no log; o aviso é
 * camada auxiliar, e falhar nele não pode transformar o fim do turno num retry
 * — que é justamente o laço que este módulo fecha.
 */
export async function avisarEquipeDaFalhaPermanenteDeEnvio(
  db: Queryable,
  input: { organizationId: string; conversationId: string; log?: Logger },
): Promise<void> {
  try {
    await insertInboxItem(
      db,
      input.organizationId,
      {
        kind: 'other',
        severity: 'warn',
        title: TITULO_DO_AVISO_DE_FALHA_PERMANENTE,
        body:
          'O canal recusou a resposta da IA nesta conversa, e o sistema não vai tentar de novo: ' +
          'repetir só repetiria a recusa. Abra a conversa para ver o motivo na mensagem que falhou ' +
          'e responda o cliente.',
        refKind: 'conversation',
        refId: input.conversationId,
      },
      'kind_ref_e_titulo',
    );
  } catch (err) {
    input.log?.warn('falha permanente de envio: aviso na Central não gravado', {
      conversation_id: input.conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
