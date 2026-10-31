/**
 * A DECISÃO "O AGENTE FALA NESTE TURNO?" — Fase 6b do plano de voz
 * (`docs/superpowers/plans/2026-10-29-voz-elevenlabs.md`).
 *
 * Resolvida UMA vez por turno (não por chamada de `send_message`): a
 * pergunta não muda entre tentativas do MESMO turno, e resolver credencial a
 * cada bolha pagaria uma ida ao banco por mensagem sem motivo.
 *
 * Falha SEMPRE para texto, nunca para "turno travado": sem credencial, sem
 * `voice_id` configurado, ou qualquer erro de rede com o ElevenLabs, a
 * resposta é `null` — "não fale agora" — e quem chama segue pelo caminho de
 * bolhas de texto de sempre. Voz é um EXTRA sobre um caminho que já
 * funciona; travar o turno por causa dela seria pior que nunca ter oferecido.
 */
import type pg from 'pg';

import { resolveOrgLlmConfig, type LlmEdgeConfig } from '../edge/llm/credentials';
import { aplicarOrcamento, LlmBudgetExceededError, type RastroDaChamada } from '../edge/llm/run-model-call';
import { chaveDeOrcamentoDaInstalacao } from '@/lib/instalacao/comportamento';
import { logger } from '@/lib/logger';
import type { ChannelCapabilities } from '@/lib/channels/types';

export type VozQuando = 'nunca' | 'espelhar' | 'sempre';

export interface ResolverVozDoTurnoInput {
  pool: pg.Pool;
  tenantId: string;
  vozEnabled: boolean;
  vozQuando: VozQuando;
  /**
   * O que o canal da conversa faz com áudio. A síntese grava mp3, e só o canal
   * que CONVERTE o entrega como nota de voz — no `opus-only` ele chegaria como
   * anexo de música (`lib/channels/capabilities.ts`). Lá, a resposta segue em texto.
   */
  voiceNote: ChannelCapabilities['voiceNote'];
  /** `messages.type` da mensagem inbound que disparou o turno — `null` quando não há (ex.: follow-up proativo). */
  inboundType: string | null;
  /**
   * Config do ambiente desta instalação — a MESMA `deps.llmCfg` que o turno
   * já usa para o `runModelCall` de chat. Precisa vir do chamador, não `{}`
   * local: é dela que o kill switch `AI_BUDGET_ENFORCEMENT` (`budgetEnforcement`)
   * chega aqui — sem ele, o gate de orçamento da voz nunca saberia que o
   * operador afrouxou o teto.
   */
  cfg: LlmEdgeConfig;
  /** Para a linha de `llm_calls` ficar tão rica quanto a de um turno de chat recusado por orçamento. */
  leadId?: string | null;
  jobId?: string | null;
  agentId?: string | null;
}

export interface VozResolvidaDoTurno {
  apiKey: string;
  voiceId: string;
  modelId?: string;
}

/** `organizations.settings->'voz'` — mesmo padrão jsonb de `settings->'llm'`. */
interface VozSettings {
  voice_id?: string;
  model_id?: string;
}

function deveFalar(vozQuando: VozQuando, inboundType: string | null): boolean {
  if (vozQuando === 'nunca') return false;
  if (vozQuando === 'sempre') return true;
  // 'espelhar': só quando o CLIENTE mandou áudio nesta mensagem.
  return inboundType === 'audio';
}

export async function resolverVozDoTurno(
  input: ResolverVozDoTurnoInput,
): Promise<VozResolvidaDoTurno | null> {
  if (!input.vozEnabled) return null;
  if (input.voiceNote !== 'server-convert') return null;
  if (!deveFalar(input.vozQuando, input.inboundType)) return null;

  try {
    const { rows } = await input.pool.query<{ settings: Record<string, unknown> | null }>(
      'select settings from organizations where id = $1',
      [input.tenantId],
    );
    const voz = (rows[0]?.settings?.voz ?? {}) as VozSettings;
    if (!voz.voice_id) {
      // Ninguém escolheu uma voz ainda (não há tela — Fase 7). `voz_enabled`
      // só chega a `true` hoje por quem edita o banco direto, e essa pessoa
      // também não configurou `settings.voz` — não é falha, é "faltou o
      // segundo passo". Loga para quem for depurar, não trava o turno.
      logger.warn('[voz-do-turno] voz_enabled sem voice_id configurado — respondendo em texto', {
        organization_id: input.tenantId,
      });
      return null;
    }

    const elevenlabs = await resolveOrgLlmConfig(input.pool, input.cfg, input.tenantId, {
      provider: 'elevenlabs',
    });

    const modelId = voz.model_id ?? 'eleven_multilingual_v2';
    const orcamentoInput: RastroDaChamada = {
      tenantId: input.tenantId,
      leadId: input.leadId ?? null,
      jobId: input.jobId ?? null,
      agentId: input.agentId ?? null,
    };
    // ═══ O MESMO TETO QUE O CHAT JÁ RESPEITA ═══
    //
    // Achado na revisão de código: sem isto, uma organização que esgota o
    // orçamento vê o CHAT parar (LlmBudgetExceededError, aviso crítico na
    // Central) enquanto a VOZ continuava chamando o ElevenLabs sem parar e
    // sem avisar — contradizendo a própria promessa do recurso ("entra no
    // mesmo orçamento mensal"). `aplicarOrcamento` já abre o aviso crítico
    // (ou o de 80%) sozinha; aqui só falta decidir o que fazer com o erro.
    await aplicarOrcamento({
      db: input.pool,
      organizationId: input.tenantId,
      orcamentoDaConfig: elevenlabs.orcamento,
      orcamentoIndisponivelPorque: elevenlabs.orcamentoIndisponivelPorque,
      // A tela de admin (comportamento da instalação) vence o env, como no chat.
      chave: chaveDeOrcamentoDaInstalacao(input.cfg.budgetEnforcement ?? 'on'),
      // O teto do plano só vincula a chave da INSTALAÇÃO — mesmo critério do chat.
      origemDaChave: elevenlabs.origemDaChave,
      purpose: 'sintese_de_voz',
      provider: 'elevenlabs',
      model: modelId,
      origem: 'fixo_do_produto',
      input: orcamentoInput,
    });

    return {
      apiKey: elevenlabs.apiKey,
      voiceId: voz.voice_id,
      modelId,
    };
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) {
      // O aviso crítico já abriu na Central (dentro de `aplicarOrcamento`) —
      // aqui só cai para texto, como qualquer outra razão de não falar.
      logger.warn('[voz-do-turno] orçamento de IA esgotado — respondendo em texto', {
        organization_id: input.tenantId,
      });
      return null;
    }
    // `LlmNotConfiguredError` (sem credencial) e qualquer falha de rede caem
    // aqui igual — a resposta para o chamador é a MESMA: fale em texto agora.
    logger.warn('[voz-do-turno] não consegui resolver voz para este turno — respondendo em texto', {
      organization_id: input.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
