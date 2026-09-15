/**
 * Espelho do avanço de funil no kanban do CRM — LIGADO. O harness (lead_state) é
 * a fonte da verdade do funil do agente; quando o agente avança um passo, o card
 * do tenant anda junto no board, traduzido pelo `crm_stages.agent_stage_hint`.
 *
 * ⚠️ Este arquivo NÃO decide qual negócio do contato se move: ele DELEGA para
 * `sincronizaEstagioDoAgente`, que reusa o `resolveActiveLeadForContact` da wave
 * 4. Um segundo resolvedor aqui seriam duas fontes que começam iguais e divergem
 * no primeiro ajuste.
 *
 * Cada não-movimento vira o rótulo que diz a verdade sobre ele (ver MIRROR_WARN_ONLY):
 * configuração e conflito com humano são estado normal (warn-only); perda sem
 * motivo é estado normal MAS precisa de item de inbox (falta ação do humano); e
 * banco fora / escrita falha são incidente — os dois últimos abrem item no caller.
 */
import { sincronizaEstagioDoAgente } from '@/lib/leads/agent-stage-sync';
import type { Queryable } from '../../queue/queue';
import type { CrmEdgeConfig } from './mcp-client';
import type { LeadStage } from '../../agent/lead-state';

export type MirrorReason =
  | 'not_configured'
  | 'human_conflict'
  /**
   * O negócio está num funil que este agente não cuida (spec 17 passo 3).
   *
   * ⚠️ FORA de MIRROR_WARN_ONLY, de propósito. É estado legítimo do produto —
   * mas no dia 1 de cada agente ele é 100% dos movimentos, e um veto silencioso
   * em massa se lê como "a IA parou de funcionar". O aviso é o que transforma
   * uma proteção num fato compreensível.
   */
  | 'fora_do_escopo'
  /**
   * A etapa de destino é de PERDA e o motivo da perda é do humano (issue #917).
   *
   * ⚠️ FORA de MIRROR_WARN_ONLY, e por uma razão diferente da de
   * `fora_do_escopo`: não é estado que se resolve sozinho com paciência — o
   * negócio que o agente quis fechar como perdido CONTINUA aberto, e o dono
   * precisa saber que a IA parou ali e por quê. Warn silencioso deixaria o card
   * parado num funil que parece só atrasado. O item de inbox é o ensinamento:
   * mova o card e informe o motivo (o banco recusa motivo que o agente invente).
   */
  | 'perda_sem_motivo'
  | 'crm_error'
  | 'crm_unavailable';

export type MirrorResult = { ok: true } | { ok: false; reason: MirrorReason; detail: string };

/**
 * Os não-movimentos que são ESTADO LEGÍTIMO do produto: warn no log do run, sem
 * item de inbox. O que fica de fora (crm_error, crm_unavailable) é incidente de
 * verdade — o funil parou e alguém precisa saber. Um rótulo honesto de cada lado
 * é o que impede o inbox de virar ruído que o usuário aprende a ignorar.
 */
export const MIRROR_WARN_ONLY: ReadonlySet<MirrorReason> = new Set<MirrorReason>([
  'not_configured',
  'human_conflict',
]);

/** Injetável só para teste — em produção é sempre a implementação real. */
interface Deps {
  sync?: typeof sincronizaEstagioDoAgente;
}

export async function mirrorLeadStageToCrm(
  _db: Queryable,
  cfg: CrmEdgeConfig,
  input: { tenantId: string; leadId: string; toStage: LeadStage; reason?: string },
  deps: Deps = {},
): Promise<MirrorResult> {
  const sync = deps.sync ?? sincronizaEstagioDoAgente;
  try {
    // `input.leadId` é o contact_id do CRM: o funil do agente é por CONTATO
    // (lead_state.contact_id) e quem resolve "qual negócio deste contato" é o
    // `resolveActiveLeadForContact` lá dentro — não aqui.
    const r = await sync(cfg.supabase, {
      organizationId: input.tenantId,
      contactId: input.leadId,
      passo: input.toStage,
    });

    if (r.moveu || r.motivo === 'ja_esta_la') return { ok: true };

    // Cada motivo vira o rótulo que DIZ A VERDADE sobre ele. Os três primeiros
    // são configuração/estado normal (warn-only, sem inbox); `conflito_humano`
    // também não é incidente — o humano venceu a corrida e a decisão dele vale —
    // mas chamá-lo de `not_configured` mentiria sobre a causa para quem lê o log.
    // Banco fora e escrita falha SÃO incidentes: viram item de inbox no caller.
    const traduz: Record<string, { reason: MirrorReason; detail: string }> = {
      sem_mapeamento: {
        reason: 'not_configured',
        detail: `nenhum estágio do pipeline declara agent_stage_hint = "${input.toStage}"`,
      },
      sem_negocio: { reason: 'not_configured', detail: 'o contato não tem negócio aberto para mover' },
      // O detalhe vem do sync (distingue "nenhum funil liberado" de "funil de
      // outro time") e é o que o aviso na Central mostra ao dono.
      fora_do_escopo: {
        reason: 'fora_do_escopo',
        detail: 'este assistente não cuida do funil onde o negócio está',
      },
      perda_sem_motivo: {
        reason: 'perda_sem_motivo',
        detail: 'a etapa de destino fecha o negócio como perdido, e perder exige um motivo que o assistente não pode escolher',
      },
      ambiguo: {
        reason: 'not_configured',
        detail: 'o contato tem mais de um negócio aberto — nenhum foi movido',
      },
      conflito_humano: {
        reason: 'human_conflict',
        detail: 'um humano moveu o card durante a operação — a decisão dele prevalece',
      },
      falha_de_escrita: {
        reason: 'crm_error',
        detail: `o UPDATE do card falhou: ${r.detalhe ?? 'sem detalhe'}`,
      },
      indisponivel: {
        reason: 'crm_unavailable',
        detail: `o banco do CRM não respondeu: ${r.detalhe ?? 'sem detalhe'}`,
      },
    };
    const t = traduz[r.motivo];
    // O `detalhe` do sync VENCE o texto genérico da tabela quando existe: ele
    // sabe QUAL dos dois casos de escopo aconteceu, e o dono precisa dessa
    // diferença para saber se marca um funil ou não faz nada.
    if (t && r.detalhe) return { ok: false, reason: t.reason, detail: r.detalhe };
    // Motivo desconhecido NÃO pode virar warn-only silencioso: rótulo novo sem
    // tradução aqui é bug de programação, e o inbox é onde ele aparece.
    if (!t) return { ok: false, reason: 'crm_error', detail: `motivo não traduzido: ${r.motivo}` };
    return { ok: false, ...t };
  } catch (err) {
    return {
      ok: false,
      reason: 'crm_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
