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
import { formatoDaVozParaCanal, type FormatoDaVoz } from '@/lib/ai/voz/formato';
import { lerPedidoDeAudio } from './pedido-de-audio';

export type VozQuando = 'nunca' | 'espelhar' | 'sempre' | 'quando_pede';

export interface ResolverVozDoTurnoInput {
  pool: pg.Pool;
  tenantId: string;
  vozEnabled: boolean;
  vozQuando: VozQuando;
  /**
   * O que o canal da conversa faz com áudio — e daí o FORMATO da síntese: mp3
   * para quem converte, ogg/opus para o canal oficial, que exige opus e não
   * converte (`lib/ai/voz/formato.ts`). Até 02/11/2026 o `opus-only` respondia
   * sempre em texto; a ElevenLabs sintetiza em opus, então ele também fala.
   */
  voiceNote: ChannelCapabilities['voiceNote'];
  /** `messages.type` da mensagem inbound que disparou o turno — `null` quando não há (ex.: follow-up proativo). */
  inboundType: string | null;
  /**
   * O TEXTO da mensagem inbound (#4345) — o que o cliente escreveu, já composto
   * por `corpoDaMensagem` (num áudio, a transcrição; sem transcrição, o marcador
   * `[audio]`). É daqui que sai o pedido de voz do `'quando_pede'`; ausente,
   * `null`, e o turno só pode espelhar o canal.
   */
  inboundText?: string | null;
  /**
   * A voz PRÓPRIA deste agente (`ai_agents.config.voz_voice_id`, #4228) — a
   * escolha que a tela do agente grava. `null`/ausente = herda a voz da
   * organização (`organizations.settings.voz.voice_id`), que é o comportamento
   * de antes desta fatia, byte a byte.
   */
  vozVoiceId?: string | null;
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
  /** O formato que ESTE canal entrega como nota de voz. */
  formato: FormatoDaVoz;
}

/** `organizations.settings->'voz'` — mesmo padrão jsonb de `settings->'llm'`. */
interface VozSettings {
  voice_id?: string;
  model_id?: string;
}

/**
 * "O agente fala NESTE turno?" — os quatro comportamentos de `voz_quando`.
 *
 * `'quando_pede'` (#4345) é o espelho MAIS a leitura do turno: fala quando o
 * cliente mandou áudio (como `'espelhar'`) OU quando pediu áudio por escrito /
 * avisou que não consegue ler. Quem pediu texto vence o espelho — o cliente que
 * grava "prefiro texto" quer texto, mesmo tendo mandado áudio.
 */
function deveFalar(
  vozQuando: VozQuando,
  inboundType: string | null,
  inboundText: string | null,
): boolean {
  if (vozQuando === 'nunca') return false;
  if (vozQuando === 'sempre') return true;
  if (vozQuando === 'quando_pede') {
    const pedido = lerPedidoDeAudio(inboundText);
    if (pedido === 'texto') return false;
    return pedido === 'audio' || inboundType === 'audio';
  }
  // 'espelhar': só quando o CLIENTE mandou áudio nesta mensagem.
  return inboundType === 'audio';
}

/**
 * O BLOCO QUE AVISA O MODELO DE QUE A RESPOSTA VAI SER OUVIDA.
 *
 * A síntese não reescreve nada: `textoFalavel` só tira emoji, markdown e
 * símbolo do texto que o modelo escreveu. Se o modelo não sabe que vai ser
 * ouvido, escreve para a TELA — e o que se lê de relance cansa no ouvido.
 * Medido numa instalação real (03/11/2026, número oficial): a resposta a um áudio de
 * cliente saiu numa nota de 35 segundos, com lista ("funil, follow-up, agente
 * de IA…") e sigla ("API oficial da Meta"). Uma nota confortável fica entre 15 e
 * 25 segundos — ~300 caracteres de fala.
 *
 * Só entra quando a voz JÁ foi resolvida para este turno (`null` = o turno sai em
 * texto e nada muda). Link e texto longo seguem caindo para texto em
 * `textoParaFalar`: o bloco pede o curto, a régua de lá continua sendo a garantia.
 */
export const BLOCO_DA_RESPOSTA_FALADA =
  '## Esta resposta vai sair como NOTA DE VOZ\n' +
  'O cliente vai OUVIR o que você mandar com send_message: a voz é gerada a partir do seu texto. ' +
  'Escreva para ser ouvido, no idioma da conversa:\n' +
  '- curto: no máximo uns 20 segundos de fala (cerca de 300 caracteres);\n' +
  '- uma ideia por vez, com frases simples, como num áudio de WhatsApp;\n' +
  '- sem listas, tópicos, emojis, siglas nem símbolos; números e preços escritos como se falam;\n' +
  '- se fizer sentido, termine com UMA pergunta.\n' +
  'Link, endereço longo ou dado para copiar não cabem em áudio: se precisar mandar, mande por escrito.';

/** O bloco da resposta falada, ou `null` quando este turno sai em texto. */
export function blocoDaRespostaFalada(voz: VozResolvidaDoTurno | null): string | null {
  return voz ? BLOCO_DA_RESPOSTA_FALADA : null;
}

export async function resolverVozDoTurno(
  input: ResolverVozDoTurnoInput,
): Promise<VozResolvidaDoTurno | null> {
  if (!input.vozEnabled) return null;
  if (!deveFalar(input.vozQuando, input.inboundType, input.inboundText ?? null)) return null;

  try {
    const { rows } = await input.pool.query<{ settings: Record<string, unknown> | null }>(
      'select settings from organizations where id = $1',
      [input.tenantId],
    );
    const voz = (rows[0]?.settings?.voz ?? {}) as VozSettings;
    // A voz do AGENTE vence a da organização; sem ela, cai na da organização —
    // exatamente o valor que esta função devolvia antes de existir voz por
    // agente. `trim()` porque um id só com espaço viraria 404 na ElevenLabs e
    // calaria o turno, quando a resposta certa é herdar.
    const vozDoAgente = typeof input.vozVoiceId === "string" ? input.vozVoiceId.trim() : "";
    const voiceId = vozDoAgente !== "" ? vozDoAgente : voz.voice_id;
    if (!voiceId) {
      // Ninguém escolheu uma voz ainda (não há tela — Fase 7). `voz_enabled`
      // só chega a `true` hoje por quem edita o banco direto, e essa pessoa
      // também não configurou `settings.voz` — não é falha, é "faltou o
      // segundo passo". Loga para quem for depurar, não trava o turno.
      logger.warn('[voz-do-turno] voz_enabled sem voice_id (nem do agente, nem da organização) — respondendo em texto', {
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
      voiceId,
      modelId,
      formato: formatoDaVozParaCanal(input.voiceNote),
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
