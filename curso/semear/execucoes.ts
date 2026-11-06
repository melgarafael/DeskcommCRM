/**
 * Semente do módulo "Execuções" (Agente de IA › Ver tudo em IA › Execuções,
 * /app/ai/runs): o dia da Bia em `llm_calls`, a tabela que o motor grava a cada
 * chamada de IA — inclusive quando ela falha (migration 0128). Cinco chamadas
 * que deram certo e três que falharam, com os dois motivos mais comuns: a
 * chave recusada pelo provedor e o provedor fora do ar.
 *
 * Os códigos de erro e as origens da escolha são os do vocabulário da rota
 * (`O_QUE_FAZER` em app/api/v1/ai/runs/route.ts e `EXPLICACAO_DA_ORIGEM` em
 * lib/ai/pontos/resolver.ts): é por
 * eles que a tela escreve "O que fazer" e "por que este modelo".
 *
 * `limpar` é exportado: a tela de Uso e orçamento soma estas mesmas linhas, e
 * uma sobra mudaria o gasto do mês nas fotos dela. O gatilho de orçamento
 * (`trg_llm_calls_budget`) soma cada inserção num contador acumulado que nada
 * zera; por isso o custo daqui é de poucos centavos de dólar por rodada.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos) e recria.
 */
import { type Contexto, ha, semErro } from "../semear-demonstracao";

const execucaoId = (n: number) => `f1d00006-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SONNET = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-4-5";

type Chamada = {
  n: number;
  min: number;
  purpose: "agent_turn" | "stage_classifier";
  model: string;
  origem: "agente_publicado" | "economico_do_provedor";
  entrada?: number;
  saida?: number;
  ms?: number;
  erro?: { codigo: string; http: number; mensagem: string };
};

const CHAMADAS: Chamada[] = [
  { n: 1, min: 6, purpose: "agent_turn", model: SONNET, origem: "agente_publicado", entrada: 6_420, saida: 310, ms: 2_380 },
  { n: 2, min: 6, purpose: "stage_classifier", model: HAIKU, origem: "economico_do_provedor", entrada: 1_840, saida: 36, ms: 640 },
  {
    n: 3, min: 21, purpose: "agent_turn", model: SONNET, origem: "agente_publicado", ms: 1_910,
    erro: { codigo: "provedor_indisponivel", http: 529, mensagem: "overloaded_error: Overloaded" },
  },
  {
    n: 4, min: 23, purpose: "agent_turn", model: SONNET, origem: "agente_publicado", ms: 30_000,
    erro: { codigo: "provedor_indisponivel", http: 504, mensagem: "upstream request timeout" },
  },
  { n: 5, min: 44, purpose: "agent_turn", model: SONNET, origem: "agente_publicado", entrada: 5_980, saida: 274, ms: 2_120 },
  { n: 6, min: 90, purpose: "agent_turn", model: SONNET, origem: "agente_publicado", entrada: 7_105, saida: 402, ms: 2_760 },
  {
    n: 7, min: 3 * 60, purpose: "agent_turn", model: SONNET, origem: "agente_publicado", ms: 180,
    erro: { codigo: "credencial_recusada", http: 401, mensagem: "authentication_error: invalid x-api-key" },
  },
  { n: 8, min: 3 * 60 + 2, purpose: "stage_classifier", model: HAIKU, origem: "economico_do_provedor", entrada: 1_620, saida: 31, ms: 590 },
];

/** Limpeza chamada antes de QUALQUER aula: a tela de Uso e orçamento soma estas linhas. */
export async function limpar(c: Contexto) {
  semErro(
    await c.db.from("llm_calls").delete().eq("organization_id", c.org).in("id", CHAMADAS.map((x) => execucaoId(x.n))),
    "limpar execuções da Bia",
  );
}

export async function semear(c: Contexto) {
  await limpar(c);
  semErro(await c.db.from("llm_calls").insert(CHAMADAS.map((x) => {
    const entrada = x.entrada ?? 0, saida = x.saida ?? 0;
    // preço por milhão de tokens (US$): Sonnet 3 lidos / 15 escritos; Haiku 1 / 5. Falha não cobra.
    const [pLido, pEscrito] = x.model === HAIKU ? ([0.0001, 0.0005] as const) : ([0.0003, 0.0015] as const);
    return {
      id: execucaoId(x.n), organization_id: c.org, agent_id: c.agenteId,
      purpose: x.purpose, provider: "anthropic", model: x.model, origem_da_escolha: x.origem,
      input_tokens: entrada, output_tokens: saida,
      cost_cents: x.erro ? null : Number((entrada * pLido + saida * pEscrito).toFixed(4)),
      latency_ms: x.ms ?? null,
      status: x.erro ? "erro" : "ok",
      error_code: x.erro?.codigo ?? null, error_message: x.erro?.mensagem ?? null, http_status: x.erro?.http ?? null,
      created_at: ha(x.min),
    };
  })), "execuções da Bia");
}
