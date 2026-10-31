/**
 * Semente do módulo "Execuções" (Agente de IA › Ver tudo em IA › Execuções).
 *
 * A tela lê `llm_calls`, e na bancada a IA nunca é chamada: sem esta semente
 * ela só mostraria "Nenhuma execução ainda". Aqui ficam gravadas, do jeito que
 * o motor grava (`lib/agent-engine/edge/llm/run-model-call.ts`), as execuções
 * de um dia comum da Clínica Bem Viver:
 *
 *  - sucessos da Bia (agente publicado, Anthropic `claude-sonnet-4-6`) e dos
 *    classificadores que usam o modelo econômico do provedor;
 *  - duas falhas por chave recusada (401) — o caso que a tela nasceu para
 *    explicar — seguidas de respostas que voltaram a dar certo;
 *  - uma queda do provedor (529, "Overloaded") ao resumir uma conversa longa;
 *  - um veto de propósito: o orçamento do mês esgotado (`orcamento_esgotado`).
 *
 * Como o motor grava a falha: tokens zerados e custo `null` ("não sei", nunca
 * "de graça"); `error_message` é o texto do provedor, redigido. `agent_id`,
 * `contact_id` e `job_id` ficam nulos de propósito: a tela não os mostra, e
 * com eles estas linhas apareceriam também no rastro do agente (tela Agentes).
 *
 * O gatilho `trg_llm_calls_budget` soma cada linha nova em `ai_budgets` e, se a
 * organização não tem linha lá, CRIA uma com o limite padrão. A semente desfaz
 * esse efeito no fim, para não mexer no "Uso e orçamento" de ninguém.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos d1220000-…) e recria,
 * com horários relativos à hora em que roda — elas ficam no alto da lista.
 */
import { type Contexto, exigir, ha, ontemAs, semErro } from "../semear-demonstracao";

const execucaoId = (n: number) => `d1220000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Preço por milhão de tokens, em US$ (lib/agent-engine/edge/llm/pricing.ts), virado em centavos. */
const PRECO = {
  "claude-sonnet-4-6": { entrada: 3, saida: 15 },
  "claude-haiku-5-5": { entrada: 0.1, saida: 0.5 },
} as const;
const custo = (modelo: keyof typeof PRECO, entrada: number, saida: number) =>
  Number(((entrada * PRECO[modelo].entrada + saida * PRECO[modelo].saida) / 10_000).toFixed(6));

/**
 * A mensagem que o próprio motor grava no veto do orçamento
 * (`LlmBudgetExceededError`, já sem nada a redigir). É texto do PRODUTO, não da
 * clínica: numa instalação em espanhol ele também sai assim, por isso não passa
 * por `demo()`.
 */
const MENSAGEM_DO_VETO =
  "orçamento mensal de IA da organização atingido — chamada recusada antes de sair byte para o provedor; ajuste o teto em Uso de IA › Orçamento, desligue a proteção, ou aguarde a virada do mês (agent_inbox_items kind=budget_exceeded)";

type Linha = {
  n: number;
  em: string;
  purpose: string;
  model: keyof typeof PRECO;
  origem: string;
  ok?: { entrada: number; saida: number; ms: number };
  erro?: { codigo: string; mensagem: string; http: number | null; ms: number };
};

const LINHAS: Linha[] = [
  // ---- agora há pouco: a Bia voltou a responder ----
  { n: 1, em: ha(4), purpose: "agent_turn", model: "claude-sonnet-4-6", origem: "agente_publicado", ok: { entrada: 7_412, saida: 286, ms: 3_120 } },
  { n: 2, em: ha(4.5), purpose: "stage_classifier", model: "claude-haiku-5-5", origem: "economico_do_provedor", ok: { entrada: 2_180, saida: 18, ms: 640 } },
  { n: 3, em: ha(5), purpose: "jailbreak_detect", model: "claude-haiku-5-5", origem: "economico_do_provedor", ok: { entrada: 1_240, saida: 9, ms: 520 } },
  { n: 4, em: ha(17), purpose: "agent_turn", model: "claude-sonnet-4-6", origem: "agente_publicado", ok: { entrada: 6_905, saida: 241, ms: 2_870 } },
  // ---- antes disso, a chave tinha sido recusada: o cliente ficou sem resposta ----
  { n: 5, em: ha(26), purpose: "agent_turn", model: "claude-sonnet-4-6", origem: "agente_publicado", erro: { codigo: "credencial_recusada", mensagem: "invalid x-api-key", http: 401, ms: 412 } },
  { n: 6, em: ha(41), purpose: "agent_turn", model: "claude-sonnet-4-6", origem: "agente_publicado", erro: { codigo: "credencial_recusada", mensagem: "invalid x-api-key", http: 401, ms: 388 } },
  // ---- de manhã: o provedor engasgou ao resumir uma conversa longa ----
  { n: 7, em: ha(128), purpose: "compaction", model: "claude-sonnet-4-6", origem: "herdado_de_quem_chamou", erro: { codigo: "provedor_indisponivel", mensagem: "Overloaded", http: 529, ms: 30_004 } },
  { n: 8, em: ha(131), purpose: "agent_turn", model: "claude-sonnet-4-6", origem: "agente_publicado", ok: { entrada: 8_230, saida: 312, ms: 3_410 } },
  { n: 9, em: ha(131.5), purpose: "operator_turn", model: "claude-sonnet-4-6", origem: "agente_publicado", ok: { entrada: 5_870, saida: 164, ms: 2_260 } },
  // ---- ontem à noite: o veto de propósito, porque o gasto do mês bateu no limite ----
  { n: 10, em: ontemAs(18, 40), purpose: "agent_turn", model: "claude-sonnet-4-6", origem: "agente_publicado", erro: { codigo: "orcamento_esgotado", mensagem: MENSAGEM_DO_VETO, http: null, ms: 9 } },
];

export async function semear(c: Contexto) {
  const { db, org } = c;
  const ids = LINHAS.map((l) => execucaoId(l.n));

  semErro(await db.from("llm_calls").delete().eq("organization_id", org).in("id", ids), "limpar execuções");

  // Para desfazer o efeito do gatilho de orçamento no fim (ver o cabeçalho).
  const antes = exigir(
    await db.from("ai_budgets").select("organization_id").eq("organization_id", org),
    "orçamento antes das execuções",
  ) as Array<{ organization_id: string }>;

  const linhas = LINHAS.map((l) => ({
    id: execucaoId(l.n),
    organization_id: org,
    purpose: l.purpose,
    provider: "anthropic",
    model: l.model,
    input_tokens: l.ok?.entrada ?? 0,
    output_tokens: l.ok?.saida ?? 0,
    cost_cents: l.ok ? custo(l.model, l.ok.entrada, l.ok.saida) : null,
    latency_ms: l.ok?.ms ?? l.erro!.ms,
    status: l.ok ? "ok" : "erro",
    error_code: l.erro?.codigo ?? null,
    error_message: l.erro?.mensagem ?? null,
    http_status: l.erro?.http ?? null,
    origem_da_escolha: l.origem,
    created_at: l.em,
  }));
  semErro(await db.from("llm_calls").insert(linhas), "execuções de IA");

  const somado = linhas.reduce((s, l) => s + (l.cost_cents ?? 0), 0);
  if (antes.length === 0) {
    // O gatilho criou a linha com o limite padrão: some com ela, como estava.
    semErro(
      await db.from("ai_budgets").delete().eq("organization_id", org).eq("enforcement_mode", "off").lte("current_month_consumed_cents", somado + 0.0001),
      "desfazer o orçamento criado pelo gatilho",
    );
  } else {
    const atual = exigir(
      await db.from("ai_budgets").select("current_month_consumed_cents").eq("organization_id", org).single(),
      "orçamento depois das execuções",
    ) as { current_month_consumed_cents: number | string };
    semErro(
      await db
        .from("ai_budgets")
        .update({ current_month_consumed_cents: Math.max(0, Number(atual.current_month_consumed_cents) - somado) })
        .eq("organization_id", org),
      "desfazer a soma do gatilho no orçamento",
    );
  }
}
