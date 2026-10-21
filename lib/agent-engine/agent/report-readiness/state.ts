/**
 * ESTADO do fluxo de consulta de laudo, em `conversations.metadata.report_status_flow`
 * (mesmo campo JSONB estruturado que o handoff já usa para a marca de caso
 * técnico — sem migration, sem coluna nova). O registro carrega a MENSAGEM que
 * o turno atual reivindicou: o claim (CAS por `msg`) é a trava de retry — a
 * mesma mensagem re-executada não reenvia nem re-entrega para humano, e um
 * turno interrompido (`processando: true`) é re-executado com segurança porque
 * os efeitos são idempotentes (ledger de envio por `(job, seq)` + recibo da
 * passagem em `conversations.metadata`: uma linha por tentativa, o "meio
 * idempotente" do #2885 — ver `gravarPassagemComRecibo`).
 */
import type { Queryable } from '../../queue/queue';
import type { Idioma, Servico } from './intent';

export type EtapaFluxo = 'inicio' | 'categoria' | 'coleta' | 'encerrado';

export interface EstadoFluxo {
  v: 1;
  /** Mensagem inbound que este registro processa (claim de retry). */
  msg: string;
  /** true = turno em processamento; completado zera, e duplicata completa é no-op. */
  processando: boolean;
  etapa: EtapaFluxo;
  idioma: Idioma;
  servico?: Servico;
  /** Campo que a coleta está perguntando agora. */
  pendente?: string;
  detalhes?: Record<string, string>;
  /** Tentativas gastas no campo pendente (teto → entrega para humano). */
  tentativas?: number;
}

export const CHAVE_DO_FLUXO = 'report_status_flow';

export async function lerEstado(
  db: Queryable,
  ids: { tenantId: string; conversationId: string },
): Promise<EstadoFluxo | null> {
  const { rows } = await db.query<{ estado: EstadoFluxo | null }>(
    `select metadata->'${CHAVE_DO_FLUXO}' as estado
       from conversations where organization_id = $1 and id = $2`,
    [ids.tenantId, ids.conversationId],
  );
  const estado = rows[0]?.estado ?? null;
  return estado !== null && typeof estado === 'object' && estado.v === 1 ? estado : null;
}

/**
 * Claim da mensagem: grava o registro novo APENAS quando a mensagem ainda não
 * foi tratada — ou quando o registro anterior ficou INTERROMPIDO
 * (`processando: true`, turno que morreu no meio: re-executa, seguro porque os
 * efeitos são idempotentes). Mensagem já concluída = 0 linhas = no-op de retry
 * (é a trava "sem reply/handover duplicado" do spec).
 */
export async function reivindicarMensagem(
  db: Queryable,
  ids: { tenantId: string; conversationId: string },
  estado: EstadoFluxo,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `update conversations
        set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object($4, $3::jsonb)
      where organization_id = $1 and id = $2
        and not (
          coalesce(metadata->$4->>'msg', '') = $3::jsonb->>'msg'
          and coalesce(metadata->$4->>'processando', 'false') = 'false'
        )`,
    [ids.tenantId, ids.conversationId, JSON.stringify(estado), CHAVE_DO_FLUXO],
  );
  return (rowCount ?? 0) > 0;
}

/** Persiste o estado seguinte; `null` remove a chave (fluxo encerrado). */
export async function salvarEstado(
  db: Queryable,
  ids: { tenantId: string; conversationId: string },
  estado: EstadoFluxo | null,
): Promise<void> {
  if (estado === null) {
    await db.query(
      `update conversations set metadata = coalesce(metadata, '{}'::jsonb) - $3::text
        where organization_id = $1 and id = $2`,
      [ids.tenantId, ids.conversationId, CHAVE_DO_FLUXO],
    );
    return;
  }
  await db.query(
    `update conversations
        set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object($3, $4::jsonb)
      where organization_id = $1 and id = $2`,
    [ids.tenantId, ids.conversationId, CHAVE_DO_FLUXO, JSON.stringify(estado)],
  );
}
