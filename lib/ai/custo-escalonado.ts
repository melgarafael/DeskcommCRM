/**
 * O degrau de preço do Claude Haiku 5.5 — a ÚNICA definição no código (#4123).
 *
 * Fonte da regra (Anthropic, platform.claude.com/docs/en/about-claude/pricing,
 * lida em 11/10/2026 e citada na issue #4123): quando o prompt de UMA requisição
 * passa de 100 mil tokens de ENTRADA, o Haiku 5.5 cobra 5× pela chamada
 * inteira — entrada, saída e cache. Medido numa instalação real: 34% das
 * chamadas `agent_turn` passaram de 100k e responderam por 54% do gasto
 * daquele ponto, e o estimado do painel de Uso de IA ficava abaixo da fatura
 * justamente por não ter o degrau.
 *
 * ─── Por que aqui, e não no catálogo ───────────────────────────────────────
 *
 * O catálogo (`ai_models`) guarda taxa POR MILHÃO; o degrau não é tarifa nova,
 * é regra de CÁLCULO sobre o volume da chamada. Gravá-lo como preço no banco
 * exigiria uma linha por faixa e um "qual faixa vale" que o `select` não sabe
 * responder — e o mesmo modelo voltaria a ter dois preços concorrentes.
 *
 * ─── O que este arquivo NÃO decide ─────────────────────────────────────────
 *
 * Qual é o token de entrada. Cada chamador passa o número que ele já cobra: no
 * runtime nativo é o total do turno (soma dos passos do laço, a mesma régua de
 * `llm_calls.input_tokens` que a issue mediu); na rota legada é o
 * `promptTokens` da chamada. O multiplicador é aplicado ao centavo final, e não
 * a cada parcela: entrada, saída e cache escalam pelo MESMO fator, então
 * multiplicar o total é equivalente a multiplicar cada uma — e preserva o
 * contrato fracionado (nada de arredondar por chamada).
 *
 * Fora do degrau: o Haiku 4.5 (`claude-haiku-4-5`) e qualquer outro modelo não
 * têm essa faixa — multiplicá-los cobraria 5× a mais de quem não deve.
 */
import { normalizarModeloId } from "@/lib/ai/modelo-id";

/** Acima disto (> 100.000, não ≥) a chamada inteira do Haiku 5.5 custa 5×. */
export const LIMITE_DE_ENTRADA_EM_TOKENS = 100_000;

/** Dado da issue #4123 / tabela da Anthropic: 5× acima do limite. */
export const MULTIPLICADOR_ACIMA_DE_100K = 5;

/** Id canônico do catálogo, sem prefixo de provedor. */
const FAMILIA_HAIKU_55 = "claude-haiku-5-5";

/** Sufixo de data do vendor (`claude-haiku-5-5-20260101`) — o mesmo tolerado pela tabela de preço. */
const SUFIXO_DE_DATA = /^claude-haiku-5-5-\d{8}$/;

/**
 * O modelo é da família Haiku 5.5? Compara pelo id NORMALIZADO — as três
 * grafias que chegam (`claude-haiku-5-5`, `claude-haiku-5.5`,
 * `anthropic/claude-haiku-5.5:beta`) passam por `normalizarModeloId`, que já
 * absorve ponto, prefixo de provedor e sufixo de variante do roteador.
 */
export function ehHaiku55(model: string): boolean {
  // `:free` é outra linha do catálogo (preço 0): não é a família paga.
  if (model.split(":").slice(1).includes("free")) return false;
  return normalizarModeloId(model).some((candidato) => {
    const nome = (candidato.includes("/")
      ? candidato.slice(candidato.indexOf("/") + 1)
      : candidato
    ).replace(/\./g, "-");
    return nome === FAMILIA_HAIKU_55 || SUFIXO_DE_DATA.test(nome);
  });
}

/**
 * O fator a aplicar no custo da chamada: 5 acima de 100k de entrada num Haiku
 * 5.5; 1 em tudo o mais (o comportamento de antes). `inputTokens` ausente ou
 * negativo é tratado como 0 — não escala.
 */
export function multiplicadorDoDegrau(model: string, inputTokens: number | undefined): number {
  if (!model) return 1;
  if (!Number.isFinite(inputTokens ?? 0) || (inputTokens ?? 0) <= LIMITE_DE_ENTRADA_EM_TOKENS) {
    return 1;
  }
  return ehHaiku55(model) ? MULTIPLICADOR_ACIMA_DE_100K : 1;
}
