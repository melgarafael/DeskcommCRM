/**
 * A CHAMADA DE DECISÃO da `ai_decide` (#1970) — a metade que fala com o
 * modelo. A outra metade é pura e mora em `lib/automation/decider.ts` (prompt e
 * leitura da resposta, testáveis sem nada em volta); aqui só se monta a chamada
 * pelo seam único (`runModelCall`), com a mesma receita dos irmãos auxiliares
 * (`abordagem-de-formulario.ts`, `intent-classifier.ts`): pool da instalação,
 * config da org, SEM tools e SEM `maxSteps` — `result.text` vem pronto, e quem
 * executa a ação escolhida é o motor, nunca o modelo.
 *
 * ─── O ponto de custo ───────────────────────────────────────────────────────
 *
 * `purpose: 'automation_ai_message'` — o ponto de IA das AUTOMAÇÕES, já
 * registrado em `lib/ai/pontos/registro.ts`. Um propósito próprio
 * (`automation_ai_decide`) nasceria aqui, mas a regra do registro é que o ponto
 * entra no MESMO commit das traduções dele em `lib/i18n/dicionario.ts`, e esta
 * fatia é backend + schema (a tela do builder fica para F2, declarado no PR).
 * Reapontar o custo para o ponto das automações mantém o gasto VISIBILIZADO —
 * aba Execuções, telemetria em `llm_calls`, binding por organização — em vez de
 * criar um ponto escondido que a tela não mostra. Trocar o id por um próprio é
 * um commit de três linhas quando a tradução entrar.
 *
 * Nada roda sem o registro explícito no schema (`custo_de_token: true`): esta
 * função é chamada por quem já passou por aquela checagem, e de novo pela
 * defesa em profundidade do executor.
 */
import type pg from 'pg';

import { env } from '@/lib/env';

import { getRequestPool } from '../db/request-pool';
import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import { llmEdgeConfigFromEnv } from '../edge/llm/credentials';
import {
  interpretarDecisao,
  montarMensagemDaDecisao,
  type DecisaoDeAcao,
  type EntradaDaDecisao,
} from '@/lib/automation/decider';

/** O ponto de custo reapontado — ver o cabeçalho deste arquivo. */
const PONTO_DAS_AUTOMACOES = 'automation_ai_message';

/**
 * Teto de saída da decisão: é UM id em JSON, não texto. Sem teto, um modelo
 * em modo de raciocínio gasta o orçamento da org para escrever a justificativa
 * que ninguém pediu.
 */
const TETO_DE_SAIDA = 300;

export interface EntradaDaDecisaoDeAcao extends EntradaDaDecisao {
  /** Organização dona da regra — de onde sai o custo e a chave. */
  tenantId: string;
  /** Contato/negócio do contexto, quando existe — `leadId` do seam. */
  leadId?: string | null;
}

/**
 * Pergunta ao modelo e devolve a ESCOLHA (ou o motivo de não haver escolha).
 *
 * Pode lançar (pool ausente, orçamento estourado, provedor fora): o executor da
 * ação é quem captura e grava a causa no run — mesma disciplina de
 * `send_ai_message.ts`, onde a causa inteira é o que a tela mostra a quem
 * pergunta "por que nada rodou?".
 */
export async function decidirAcao(entrada: EntradaDaDecisaoDeAcao): Promise<DecisaoDeAcao> {
  const pool: pg.Pool = getRequestPool();
  const cfg: LlmEdgeConfig = llmEdgeConfigFromEnv(env);

  const { result } = await runModelCall(pool, cfg, {
    tenantId: entrada.tenantId,
    leadId: entrada.leadId ?? null,
    jobId: null,
    purpose: PONTO_DAS_AUTOMACOES,
    messages: [{ role: 'user', content: montarMensagemDaDecisao(entrada) }],
    maxOutputTokens: TETO_DE_SAIDA,
  });

  return interpretarDecisao(result.text, entrada.opcoes);
}
