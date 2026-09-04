/**
 * "Qual agente atende ESTA conversa?" — a pergunta que faltava ao lado de
 * `lib/ai/agents/no-ar.ts`.
 *
 * ## O defeito que este arquivo existe para consertar (issue #486)
 *
 * `no-ar.ts` responde **se** um agente atende. `workers/ai-sentiment-worker.ts`
 * precisava de outra coisa — **qual** deles atende a conversa que disparou o
 * evento — e usava a primeira como se fosse a segunda: pegava o primeiro agente
 * da organização que atende, ordenado por `is_default` e depois `created_at`.
 *
 * Com um agente só a resposta é certa por acidente. Com dois, o
 * `sentiment_threshold` em vigor passa a depender da ORDEM DE CRIAÇÃO: numa
 * clínica, cliente triste é sinal de problema; numa assistência técnica, é o
 * cliente normal. O mesmo limiar erra nos dois sentidos, e quem configurou o
 * campo do agente B fica vendo o comportamento do agente A sem nenhuma pista na
 * tela.
 *
 * ## Por que uma função pura, e por que ela NÃO inventa régua nova
 *
 * O cabeçalho de `no-ar.ts` documenta o custo de ter três respostas discordando
 * para a mesma pergunta. A quarta régua seria pior. Então a ordem aqui é a que
 * o motor já executa, e nada além:
 *
 *   1. `conversations.active_ai_agent_id` — a stickiness que o Intent Router
 *      grava (`lib/agent-engine/agent/inbound-turn.ts`). Se o router já decidiu
 *      quem atende esta conversa, a pergunta está respondida.
 *   2. O agente cuja VERSÃO PUBLICADA aponta para o `channel_session_id` da
 *      conversa, desempatando por `priority desc, created_at asc` — a mesma
 *      cláusula de `loadPublishedAgentConfig` (`agent-config.ts`), que é quem
 *      de fato responde ao cliente por aquele número.
 *   3. O agente ÚNICO da organização. Não é fallback "por ordem": é o caso em
 *      que não há ambiguidade nenhuma para resolver. Ele existe porque a
 *      instalação nova — um `rag_bot` legado, ativo, sem versão publicada e sem
 *      vínculo com sessão — é o estado mais comum do produto self-host, e
 *      derrubá-la para o padrão do produto trocaria um defeito por uma
 *      regressão.
 *
 * Com dois ou mais agentes e nenhum vínculo com a conversa, a resposta é
 * `null`. Quem chama usa o SEU padrão — chutar o limiar do vizinho é o defeito
 * de novo, agora com cara de configuração.
 *
 * O `motivo` volta junto de propósito: sem ele, o próximo diagnóstico de "por
 * que este limiar valeu?" recomeça do zero.
 */

import { agenteAtende, type FatosDoAgente } from "@/lib/ai/agents/no-ar";

/**
 * As colunas de que a régua precisa — nada além. Como em `no-ar.ts`,
 * `undefined` significa "o SELECT não pediu esta coluna", nunca "zero".
 */
export interface CandidatoDeAgente extends FatosDoAgente {
  id: string;
  priority?: number | null;
  created_at?: string | null;
  published_version_id?: string | null;
}

export interface FatosDaConversa {
  /** `conversations.active_ai_agent_id`: a stickiness gravada pelo router. */
  active_ai_agent_id?: string | null;
  /**
   * Ids das versões **publicadas** ligadas ao `channel_session_id` desta
   * conversa. Vem de uma consulta a `ai_agent_versions`; lista vazia significa
   * "consultei e não há", e é diferente de `null`/ausente, que significa "não
   * consegui consultar" — nos dois casos a regra 2 não elege ninguém, mas quem
   * lê o log precisa distinguir.
   */
  versoesPublicadasNaSessao?: readonly string[] | null;
}

export type MotivoDoAgente =
  /** O router já tinha grudado esta conversa neste agente. */
  | "stickiness_da_conversa"
  /** A versão publicada dele atende o número em que a conversa acontece. */
  | "versao_publicada_na_sessao"
  /** Não há ambiguidade: a organização tem um agente atendendo, e é este. */
  | "unico_da_organizacao"
  /** Dois ou mais agentes e nenhum vínculo com a conversa. */
  | "indefinido";

export interface AgenteDaConversa<T> {
  agente: T | null;
  motivo: MotivoDoAgente;
}

/** `priority desc, created_at asc` — a cláusula de `loadPublishedAgentConfig`. */
function ordemDoMotor(a: CandidatoDeAgente, b: CandidatoDeAgente): number {
  const prioridadeA = a.priority ?? 0;
  const prioridadeB = b.priority ?? 0;
  if (prioridadeA !== prioridadeB) return prioridadeB - prioridadeA;
  const nascimentoA = a.created_at ?? "";
  const nascimentoB = b.created_at ?? "";
  if (nascimentoA === nascimentoB) return 0;
  return nascimentoA < nascimentoB ? -1 : 1;
}

export function resolverAgenteDaConversa<T extends CandidatoDeAgente>(
  candidatos: readonly T[],
  conversa: FatosDaConversa | null,
): AgenteDaConversa<T> {
  const atendem = candidatos.filter((c) => agenteAtende(c));

  const grudado = conversa?.active_ai_agent_id ?? null;
  if (grudado !== null) {
    const dono = atendem.find((c) => c.id === grudado);
    if (dono !== undefined) return { agente: dono, motivo: "stickiness_da_conversa" };
  }

  const versoes = conversa?.versoesPublicadasNaSessao ?? null;
  if (versoes !== null && versoes.length > 0) {
    const naSessao = atendem
      .filter((c) => c.published_version_id != null && versoes.includes(c.published_version_id))
      .sort(ordemDoMotor);
    const primeiro = naSessao[0];
    if (primeiro !== undefined) {
      return { agente: primeiro, motivo: "versao_publicada_na_sessao" };
    }
  }

  const unico = atendem[0];
  if (atendem.length === 1 && unico !== undefined) {
    return { agente: unico, motivo: "unico_da_organizacao" };
  }

  return { agente: null, motivo: "indefinido" };
}
