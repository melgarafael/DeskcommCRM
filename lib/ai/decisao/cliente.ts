/**
 * CLIENTE DO SYSTEM ONE (Jev, da TypeSafe AI) — decisões tipadas com probabilidade
 * calibrada, no lugar de texto.
 *
 * ═══ POR QUE ISTO EXISTE, E POR QUE NÃO É UM `LanguageModel` ═══
 *
 * O seam de modelo (`lib/agent-engine/edge/llm/run-model-call.ts`) termina em
 * `generateText`, e o `ProviderRegistry` devolve `LanguageModel`. O Jev não gera
 * texto: ele recebe um estado e um mapa de perguntas tipadas e devolve valores com
 * probabilidade, todas as perguntas avaliadas numa passada. Fingir que é um
 * `LanguageModel` — um adaptador que traduzisse prompt livre em `questions` — seria
 * gambiarra: o prompt é texto e as perguntas exigem `criteria` estruturados.
 *
 * Por isso este módulo é um seam IRMÃO, não um provider a mais.
 *
 * ═══ NUNCA LANÇA ═══
 *
 * Toda decisão que passa por aqui tem um caminho atual do lado. Se este cliente
 * lançasse, cada call site precisaria lembrar de um try/catch, e o primeiro que
 * esquecesse derrubaria um turno de atendimento por causa de um fornecedor em early
 * access (v0.01 na data desta escrita). Devolvendo um resultado discriminado, o
 * compilador obriga quem chama a tratar a ausência — o fallback deixa de depender
 * de disciplina.
 *
 * ═══ DOIS EIXOS NA FALHA: `exigeAcao` E `defeitoNosso` ═══
 *
 * 429/529/5xx/rede/teto são indisponibilidade PASSAGEIRA: o fornecedor não
 * respondeu, o caminho atual assume sem barulho, e esperar resolve.
 *
 * O resto não passa sozinho, e silenciado junto vira degradação permanente e
 * invisível — tudo cai no caminho atual para sempre e ninguém percebe. Por isso
 * a falha carrega `exigeAcao`, e quem consome avisa quem pode agir:
 *
 *  - 401/403: a chave foi recusada. Ação do OPERADOR (trocar a chave), não
 *    defeito nosso.
 *  - 402 e todo 4xx que o fornecedor não documenta: crédito esgotado. O status
 *    de "sem crédito" NÃO é documentado (o contrato só diz que ele pode recusar
 *    gerar), então o que não é pergunta ruim nem limite de taxa conta como isso.
 *  - 400/422: pergunta MALFORMADA ou versão fixada aposentada — o único caso em
 *    que `defeitoNosso` também é verdadeiro.
 *
 * ═══ VALIDAÇÃO DA RESPOSTA ═══
 *
 * O fornecedor promete "zero type errors by construction". A promessa vale para o
 * modelo, não para a rede: proxy, página de erro em HTML e versão nova do contrato
 * chegam aqui do mesmo jeito. Confiar na promessa sem validar é o mesmo erro de
 * confiar em saída de LLM sem `zod` — e é o erro que este repo já pagou em sete
 * arquivos de parse defensivo.
 */
import { z } from "zod";

import { env } from "@/lib/env";

/**
 * A base da API do fornecedor. O destino é intrínseco ao provider; a variável
 * existe só para o dublê do e2e. Vazio é ausente (`||`, não `??`): quem copia o
 * `.env.example` recebe a variável PRESENTE e vazia.
 */
export function baseDaApiDoJev(): string {
  const configurada = (env.JEV_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return configurada || "https://api.typesafe.ai";
}

/**
 * VERSÃO FIXADA, não o apelido `jev-latest`. O apelido anda sozinho quando o
 * fornecedor publica versão nova, e o limiar de passagem para humano foi
 * calibrado sobre esta — a régua se deslocaria sem deploy e sem rastro. O
 * próprio fornecedor recomenda fixar quando há limiar ajustado. Se ela for
 * aposentada, a API responde 400, que vira `contrato_invalido` com `exigeAcao`.
 */
export const MODELO_DO_JEV = "jev-1.13.0";

// ── As três primitivas, e só elas ────────────────────────────────────────────

export type Pergunta =
  /** Sim/não. A resposta é uma probabilidade de "sim", de 0 a 1. */
  | { tipo: "noul"; instrucao: string; criterios?: { true: string; false: string } }
  /** Uma entre até 255 opções, com a probabilidade de cada uma. */
  | { tipo: "choice"; instrucao: string; criterios: Record<string, string | null> }
  /** Posição numa escala ORDENADA de 2 a 10 níveis — a resposta é contínua (ex.: 1.4). */
  | { tipo: "score"; instrucao: string; criterios: readonly [string, string, ...string[]] };

export type Resposta =
  | { tipo: "noul"; noul: number }
  | { tipo: "choice"; escolha: string; probabilidades: Record<string, number>; confianca: number }
  | { tipo: "score"; score: number; probabilidades: Record<string, number>; confianca: number };

/** Por que não houve resposta. Vira `llm_calls.error_code`. */
export type MotivoDaAusencia =
  | "sem_credencial"
  | "credencial_invalida"
  | "sem_credito"
  | "contrato_invalido"
  | "limite_de_taxa"
  | "provedor_sobrecarregado"
  | "provedor_indisponivel"
  | "resposta_ilegivel"
  /** O disjuntor (`./disjuntor`) segurou a chamada: nada saiu para a rede. */
  | "disjuntor_aberto";

/** Os motivos em que a pergunta chegou a sair para a rede — os que viram linha em Execuções. */
export type MotivoComRede = Exclude<MotivoDaAusencia, "sem_credencial" | "disjuntor_aberto">;

export interface UsoDeTokens {
  tokensDeEntrada: number;
  /** O fornecedor não cobra saída; guardamos o campo para a telemetria não mentir por omissão. */
  tokensDeSaida: number;
}

export interface FalhaDaDecisao {
  ok: false;
  motivo: MotivoDaAusencia;
  /** Não passa sozinho: alguém precisa agir (trocar chave, pôr crédito, corrigir a pergunta). */
  exigeAcao: boolean;
  /** Só 400/422: a pergunta é nossa e está errada. */
  defeitoNosso: boolean;
  status: number | null;
  /** Do cabeçalho `retry-after`, quando o fornecedor o manda. Alimenta o disjuntor. */
  retryAfterMs?: number;
  /** Só a ida e a volta ao fornecedor. Ausente quando nada saiu para a rede. */
  latenciaMs?: number;
}

export type ResultadoDaDecisao =
  | {
      ok: true;
      respostas: Record<string, Resposta>;
      uso: UsoDeTokens;
      /** A versão que DE FATO respondeu, como a API a devolveu. */
      modelo: string;
      /**
       * Só a ida e a volta ao fornecedor — sem a busca da chave no banco. É a
       * mesma régua da IA de sempre em Execuções, que cronometra só a chamada.
       */
      latenciaMs: number;
    }
  | FalhaDaDecisao;

export interface EntradaDaDecisao {
  chave: string;
  estado: string | Record<string, unknown> | ReadonlyArray<unknown>;
  perguntas: Record<string, Pergunta>;
  /** Teto por chamada. */
  tetoMs?: number;
}

export interface DependenciasDaDecisao {
  fetchImpl?: typeof fetch;
  /** Base da API. Default: `baseDaApiDoJev()`. */
  baseUrl?: string;
}

/**
 * O dreno de eventos roda os handlers EM SÉRIE, e o clima vem antes do aviso ao
 * atendente: cada milissegundo aqui atrasa a fila inteira. Medido do Brasil:
 * p50 361 ms, p95 ~561 ms. 1,5 s cobre a cauda com folga sem somar 3 s ao pior
 * caso de toda mensagem.
 */
export const TETO_PADRAO_MS = 1_500;

// ── Contrato da resposta, validado ───────────────────────────────────────────

const respostaNoul = z.object({ type: z.literal("noul"), noul: z.number() });
const respostaChoice = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});
const respostaScore = z.object({
  type: z.literal("score"),
  score: z.number(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});

const corpoDaResposta = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.union([respostaNoul, respostaChoice, respostaScore])),
  usage: z
    .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
    .optional(),
});

/** Nosso vocabulário → o do fornecedor. A tradução mora num lugar só. */
function paraOFornecedor(p: Pergunta): Record<string, unknown> {
  if (p.tipo === "noul") {
    return { type: "noul", instructions: p.instrucao, ...(p.criterios ? { criteria: p.criterios } : {}) };
  }
  if (p.tipo === "choice") {
    return { type: "choice", instructions: p.instrucao, criteria: p.criterios };
  }
  return { type: "score", instructions: p.instrucao, criteria: p.criterios };
}

function daResposta(a: z.infer<typeof corpoDaResposta>["answers"][string]): Resposta {
  if (a.type === "noul") return { tipo: "noul", noul: a.noul };
  if (a.type === "choice") {
    return { tipo: "choice", escolha: a.choice, probabilidades: a.probabilities, confianca: a.confidence };
  }
  return { tipo: "score", score: a.score, probabilidades: a.probabilities, confianca: a.confidence };
}

/**
 * Traduz o status HTTP no motivo. `exigeAcao` e `defeitoNosso` saem daqui junto,
 * porque é a mesma decisão — ver o cabeçalho.
 */
function doStatus(
  status: number,
): Pick<FalhaDaDecisao, "motivo" | "exigeAcao" | "defeitoNosso"> {
  if (status === 401 || status === 403) {
    return { motivo: "credencial_invalida", exigeAcao: true, defeitoNosso: false };
  }
  if (status === 400 || status === 422) {
    return { motivo: "contrato_invalido", exigeAcao: true, defeitoNosso: true };
  }
  if (status === 429) return { motivo: "limite_de_taxa", exigeAcao: false, defeitoNosso: false };
  if (status === 529) return { motivo: "provedor_sobrecarregado", exigeAcao: false, defeitoNosso: false };
  if (status >= 400 && status < 500) {
    return { motivo: "sem_credito", exigeAcao: true, defeitoNosso: false };
  }
  return { motivo: "provedor_indisponivel", exigeAcao: false, defeitoNosso: false };
}

/** `retry-after` em segundos ou em data HTTP; ausente ou ilegível = `undefined`. */
function retryAfterMs(res: Response): number | undefined {
  const bruto = res.headers.get("retry-after");
  if (bruto === null || bruto.trim() === "") return undefined;
  const segundos = Number(bruto);
  if (Number.isFinite(segundos)) return Math.max(0, segundos * 1000);
  const data = Date.parse(bruto);
  return Number.isNaN(data) ? undefined : Math.max(0, data - Date.now());
}

/**
 * Pergunta ao System One. **Nunca lança** — ver o cabeçalho.
 *
 * O `fetch` entra por injeção porque quem chama já traz o seu: em produção é o
 * `allowlistedFetch` do egress (a allowlist deriva da MESMA base, em `./ponto`),
 * e em teste é o dublê.
 */
export async function decidir(
  entrada: EntradaDaDecisao,
  deps: DependenciasDaDecisao = {},
): Promise<ResultadoDaDecisao> {
  if (!entrada.chave.trim()) {
    // Sem credencial não se gasta requisição nem se espera timeout: a ausência é
    // configuração, e o caminho atual assume no mesmo milissegundo.
    return { ok: false, motivo: "sem_credencial", exigeAcao: false, defeitoNosso: false, status: null };
  }

  const questions: Record<string, unknown> = {};
  for (const [id, pergunta] of Object.entries(entrada.perguntas)) {
    questions[id] = paraOFornecedor(pergunta);
  }

  const abortador = new AbortController();
  const relogio = setTimeout(() => abortador.abort(), entrada.tetoMs ?? TETO_PADRAO_MS);
  const inicio = Date.now();
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${deps.baseUrl ?? baseDaApiDoJev()}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${entrada.chave}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODELO_DO_JEV, state: entrada.estado, questions }),
      signal: abortador.signal,
    });

    if (!res.ok) {
      const espera = retryAfterMs(res);
      return {
        ok: false,
        ...doStatus(res.status),
        status: res.status,
        latenciaMs: Date.now() - inicio,
        ...(espera !== undefined ? { retryAfterMs: espera } : {}),
      };
    }

    // Ler o corpo e interpretá-lo são falhas diferentes. A leitura que cai (abort
    // pelo teto no meio do corpo) é indisponibilidade; um 200 com página HTML de
    // proxy é resposta que o sistema não entende — e a frase de "costuma se
    // resolver sozinho" seria falsa para ela.
    const texto = await res.text();
    const latenciaMs = Date.now() - inicio;
    const ilegivel = {
      ok: false,
      motivo: "resposta_ilegivel",
      exigeAcao: false,
      defeitoNosso: false,
      status: res.status,
      latenciaMs,
    } as const;
    let cru: unknown;
    try {
      cru = JSON.parse(texto);
    } catch {
      return ilegivel;
    }
    const lido = corpoDaResposta.safeParse(cru);
    if (!lido.success) return ilegivel;

    const respostas: Record<string, Resposta> = {};
    for (const [id, a] of Object.entries(lido.data.answers)) respostas[id] = daResposta(a);

    return {
      ok: true,
      respostas,
      modelo: lido.data.model ?? MODELO_DO_JEV,
      latenciaMs,
      uso: {
        tokensDeEntrada: lido.data.usage?.input_tokens ?? 0,
        tokensDeSaida: lido.data.usage?.output_tokens ?? 0,
      },
    };
  } catch {
    // Rede e abort por teto: indisponibilidade do ponto de vista de quem chama,
    // e o caminho atual assume. O erro cru não sobe porque ele carrega URL e
    // cabeçalho — e o cabeçalho tem a chave (regra 8).
    return {
      ok: false,
      motivo: "provedor_indisponivel",
      exigeAcao: false,
      defeitoNosso: false,
      status: null,
      latenciaMs: Date.now() - inicio,
    };
  } finally {
    clearTimeout(relogio);
  }
}
