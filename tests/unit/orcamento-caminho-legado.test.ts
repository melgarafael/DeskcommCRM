/**
 * O CAMINHO LEGADO TAMBÉM PARA DE GASTAR SEM TETO.
 *
 * ## O defeito medido
 *
 * `workers/ai-response-worker.ts` é o pipeline pré-engine: ele responde a
 * organização que tem agente ativo mas NÃO publicou versão nenhuma — isto é, a
 * instalação nova, a da primeira impressão. Ele é vivo, ao contrário do que o
 * desenho da onda 7 concluiu: a cadeia `docker/scheduler/entrypoint.sh` →
 * `app/api/v1/cron/event-log-drain` → `lib/event-log/register-handlers.ts` →
 * `workers/ai-response-worker.handler.ts` é contínua.
 *
 * O guard de orçamento dele lia `ai_budgets.is_throttled` / `is_disabled` —
 * flags cujo ÚNICO escritor era um cron que nunca teve agendador e que esta
 * onda apagou. Guard decorativo: este caminho gastava sem teto nenhum enquanto a
 * tela do cliente prometia um.
 *
 * ## O que este arquivo prova, e por que assim
 *
 * Contra o worker REAL (admin client, gateway e SDK dublês), pelo call site — a
 * decisão não é reimplementada aqui, ela vem de `decidirOrcamento`, a mesma
 * função pura que o engine executa. O que se mede é a LIGAÇÃO: que o guard lê o
 * estado certo, executa o veredito em vez de reinventá-lo, deixa rastro na
 * Central e — o que mais importa num produto self-host — que erra para o lado
 * que NÃO estrangula.
 *
 * O caso que carrega o arquivo é o da CONDIÇÃO 6: com o gasto acima do teto e
 * nenhum aviso no mês, a resposta ainda SAI e o aviso é aberto. Sem ele, o
 * primeiro sintoma que o cliente veria da proteção que acabou de ligar seria o
 * WhatsApp mudo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/ai/gateway", () => ({
  DEFAULT_BOT_MODEL: "anthropic/claude-sonnet-4-6",
  gatewayConfig: () => ({ apiKey: "dublê" }),
  gatewayHeaders: () => ({}),
  isAiGatewayConfigured: () => true,
  isEmbeddingProviderConfigured: () => false,
  // Resolvido via `resolverModeloDoPonto`; qualquer valor não-nulo serve, porque
  // quem consome é o `generateText` dublê logo abaixo.
  resolveLanguageModel: () => "modelo-dublê",
}));
vi.mock("@/lib/ai/budget/check", () => ({ getBudgetStatus: vi.fn() }));
// O SDK nunca é alcançado de verdade: se o guard deixar passar, esta sentinela é
// que prova a passagem — e nenhum byte sai para provedor nenhum.
vi.mock("ai", () => ({
  generateText: vi.fn(async () => {
    throw new Error("SENTINELA: o pipeline passou do guard de orçamento");
  }),
}));

import { processMessageReceived } from "@/workers/ai-response-worker";
import { getBudgetStatus, type BudgetStatus } from "@/lib/ai/budget/check";
import { createAdminClient } from "@/lib/supabase/admin";
import { LIMIAR_PADRAO_PCT } from "@/lib/agent-engine/edge/llm/orcamento";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const MSG_ID = "55555555-5555-4555-8555-555555555555";
const CONTACT_ID = "66666666-6666-4666-8666-666666666666";
const SERVICE = { organization_id: ORG_ID, contact_id: CONTACT_ID, conversation_id: CONV_ID,
  service_revision: 1, demanda_id: null, demanda_revision: null, status: "open", demanda_fechada_em: null };
const AGENT_ID = "88888888-8888-4888-8888-888888888888";

const ONTEM = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const AMANHA = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

/** Corpo neutro: qualquer gatilho de handoff desviaria antes do guard. */
const INBOUND_BODY = "bom dia, qual o prazo de entrega?";

/** Casa `G1_REGEX` (`lib/ai/handoff/regex.ts`): pedido explícito de humano. */
const INBOUND_PEDINDO_HUMANO = "quero falar com um atendente";

/** O estado que satisfaz TODAS as condições do bloqueio — o controle positivo. */
const ARMADO_E_ESTOURADO: BudgetStatus = {
  organization_id: ORG_ID,
  monthly_limit_cents: 1000,
  current_month_consumed_cents: 1500,
  pct: 150,
  alarm_threshold_pct: LIMIAR_PADRAO_PCT,
  enforcement_mode: "bloquear",
  enforcement_effective_at: ONTEM,
  enforcement_env: "on",
  blocked_now: false,
  gasto_incompleto: false,
  current_period_start: "2026-08-01",
  last_alarm_sent_at: null,
  updated_at: new Date().toISOString(),
};

interface Operacao {
  table: string;
  tipo: "insert" | "update";
  row: Record<string, unknown>;
}

/**
 * Stub do admin client suficiente para o pipeline CHEGAR ao guard de orçamento —
 * conversa livre, mensagem inbound, agente ativo com KB, e nenhuma versão
 * publicada (senão o worker cede ao engine e o guard nunca roda).
 *
 * `avisosNoMes` / `itensAbertos` são as duas contagens que o guard faz em
 * `agent_inbox_items`; elas se distinguem pelo filtro, não pela ordem.
 */
function makeAdminStub(
  contagens: { avisosNoMes: number; itensAbertos: number },
  corpoInbound: string = INBOUND_BODY,
) {
  const operacoes: Operacao[] = [];
  const tabelasConsultadas: string[] = [];

  const from = (table: string) => {
    tabelasConsultadas.push(table);
    const single: Record<string, unknown> | null =
      table === "conversations"
        ? {
            id: CONV_ID,
            organization_id: ORG_ID,
            contact_id: CONTACT_ID,
            channel_session_id: "77777777-7777-4777-8777-777777777777",
            last_inbound_at: new Date().toISOString(),
            bot_silenced_until: null,
            last_handoff_at: null,
            assignee_kind: "ai",
            contacts: {
              id: CONTACT_ID,
              display_name: null, // sem PII em teste (LGPD)
              locale: "pt-BR",
              is_blocked: false,
              force_human: false,
            },
          }
        : table === "messages"
          ? { ...SERVICE, id: MSG_ID, body: corpoInbound, direction: "inbound", organization_id: ORG_ID }
          : table === "ai_agents"
            ? {
                id: AGENT_ID,
                organization_id: ORG_ID,
                model: "anthropic/claude-sonnet-4-6",
                system_prompt: "Você é um atendente.",
                config: { confidence_threshold: 0 },
                guardrails: {},
                active_kb_version_id: "99999999-9999-4999-8999-999999999999",
                is_active: true,
                is_default: true,
                // O banco tem `kind` NOT NULL DEFAULT 'rag_bot' e os dois ponteiros:
                // sem eles o dublê descreveria uma linha que não existe, e a régua
                // de `lib/ai/agents/no-ar.ts` — que falha FECHADA quando o select
                // não trouxe `kind` — recusaria o agente pelo motivo errado.
                kind: "rag_bot",
                published_version_id: null,
                archived_at: null,
              }
            : null;

    let consultaDePublicado = false;
    let filtraJanelaDoMes = false;
    let filtraAberto = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const terminais: any = {
      maybeSingle: () =>
        Promise.resolve({ data: consultaDePublicado ? null : single, error: null }),
      single: () => Promise.resolve({ data: single, error: null }),
      insert: (row: Record<string, unknown>) => {
        operacoes.push({ table, tipo: "insert", row });
        return {
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, error: null }),
          }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        };
      },
      update: (row: Record<string, unknown>) => {
        operacoes.push({ table, tipo: "update", row });
        return chain;
      },
      then: (resolve: (v: unknown) => unknown) => {
        const count =
          table !== "agent_inbox_items"
            ? undefined
            : filtraAberto
              ? contagens.itensAbertos
              : filtraJanelaDoMes
                ? contagens.avisosNoMes
                : 0;
        return Promise.resolve({
          data:
            table === "messages"
              ? [
                  {
                    ...SERVICE,
              id: MSG_ID,
                    body: corpoInbound,
                    direction: "inbound",
                    created_at: new Date().toISOString(),
                  },
                ]
              // A seleção de agente do worker legado é uma LISTA (ele filtra os
              // candidatos pela régua de `lib/ai/agents/no-ar.ts` em vez de cortar
              // com `.limit(1)` antes de saber quem serve). O dublê acompanha.
              : table === "ai_agents"
                ? (single ? [single] : [])
                : [],
          count,
          error: null,
        }).then(resolve);
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = new Proxy(terminais, {
      get: (alvo, prop) =>
        prop in alvo
          ? alvo[prop as keyof typeof alvo]
          : (...args: unknown[]) => {
              if (prop === "not" && args[0] === "published_version_id") consultaDePublicado = true;
              if (prop === "gte" && args[0] === "created_at") filtraJanelaDoMes = true;
              if (prop === "eq" && args[0] === "status" && args[1] === "open") filtraAberto = true;
              return chain;
            },
    });
    return chain;
  };

  const rpc = (name: string) => Promise.resolve({ data: name === "fn_service_boundary" ? SERVICE : [], error: null });
  return { stub: { from, rpc }, operacoes, tabelasConsultadas };
}

const eventRow = {
  organization_id: ORG_ID,
  entity_id: MSG_ID,
  payload: { message_id: MSG_ID, conversation_id: CONV_ID },
} as unknown as EventRow;

function montar(
  orcamento: Partial<BudgetStatus> | "erro",
  contagens: { avisosNoMes: number; itensAbertos: number } = { avisosNoMes: 0, itensAbertos: 0 },
  corpoInbound: string = INBOUND_BODY,
) {
  const { stub, operacoes, tabelasConsultadas } = makeAdminStub(contagens, corpoInbound);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createAdminClient).mockReturnValue(stub as any);
  if (orcamento === "erro") {
    vi.mocked(getBudgetStatus).mockRejectedValue(new Error("PostgREST fora do ar"));
  } else {
    vi.mocked(getBudgetStatus).mockResolvedValue({ ...ARMADO_E_ESTOURADO, ...orcamento });
  }
  return { operacoes, tabelasConsultadas };
}

/**
 * Os itens da Central que são DESTE assunto.
 *
 * ⚠️ A versão anterior filtrava só por TABELA, e o nome mentia: qualquer item de
 * qualquer assunto entrava na conta. O defeito ficou visível quando
 * `triggerHandoff` passou a abrir o seu próprio item (`kind='handoff'`) — três
 * casos deste arquivo vermelharam sem que nada de orçamento tivesse mudado.
 * Régua que mede o vizinho reprova por motivo alheio.
 *
 * O `kind` só existe no INSERT (o UPDATE do retrato carrega `{status}` e a
 * identidade está no filtro, não na linha), então o corte é: item da Central que
 * NÃO declara um kind de outro assunto.
 */
const KINDS_DE_OUTROS_ASSUNTOS = new Set(["handoff", "qr_rescan", "job_dead", "event_dead"]);
const itensDeOrcamento = (operacoes: Operacao[]) =>
  operacoes.filter(
    (o) => o.table === "agent_inbox_items" && !KINDS_DE_OUTROS_ASSUNTOS.has(String(o.row.kind)),
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recuperação substitui a resposta legada em qualquer estado de orçamento",()=>{
 it.each([
  ["bloqueio armado",{}],
  ["desligado",{enforcement_mode:"off"}],
  ["carência",{enforcement_effective_at:AMANHA}],
  ["aviso",{enforcement_mode:"avisar",current_month_consumed_cents:99999}],
  ["sem limite",{monthly_limit_cents:0,current_month_consumed_cents:0}],
  ["chave de emergência",{enforcement_env:"avisar"}],
  ["gasto normal",{current_month_consumed_cents:0}],
  ["leitura indisponível","erro"],
 ])("%s não consulta budget nem cria resposta órfã",async(_name,config)=>{
  const {operacoes}=montar(config as Parameters<typeof montar>[0],{avisosNoMes:1,itensAbertos:1});
  const result=await processMessageReceived(eventRow);
  expect(result).toMatchObject({status:'skipped',reason:'agent_inactive_or_missing'});
  expect(getBudgetStatus).not.toHaveBeenCalled();
  expect(itensDeOrcamento(operacoes)).toEqual([]);
  expect(operacoes.filter(o=>o.table==='messages'&&o.tipo==='insert'&&o.row.direction==='outbound')).toEqual([]);
 });
});

describe("a ORDEM do veto — o teto de gasto não cala a triagem determinística", () => {
  it("um lead que PEDE um humano é atendido mesmo com o teto estourado", async () => {
    // O veto morava dentro de `buildContext`, e `processMessageReceived` faz
    // `return` no primeiro skip: com o teto armado, G1 ("quero falar com um
    // atendente"), G4 legal e G4 stage nunca rodavam. Um pedido explícito de
    // humano virava SILÊNCIO. Pedido de humano e menção legal são
    // determinísticos e custam ZERO token — um teto de GASTO não tem o que
    // dizer sobre eles.
    const { operacoes } = montar(
      {},
      { avisosNoMes: 1, itensAbertos: 0 },
      INBOUND_PEDINDO_HUMANO,
    );

    const result = await processMessageReceived(eventRow);

    expect(
      result,
      "o teto de gasto engoliu um pedido explícito de atendimento humano",
    ).toEqual({ status: "skipped", reason: "handoff_g1_requested_human" });
    // E o teto nem chegou a ser consultado: o desvio veio antes.
    expect(vi.mocked(getBudgetStatus)).not.toHaveBeenCalled();
    expect(itensDeOrcamento(operacoes)).toEqual([]);
  });

  it("saudação sem publicação não finge handoff por orçamento",async()=>{
    const {operacoes}=montar({}, {avisosNoMes:1,itensAbertos:0});
    const result=await processMessageReceived(eventRow);
    expect(result).toMatchObject({status:'skipped',reason:'agent_inactive_or_missing'});
    expect(getBudgetStatus).not.toHaveBeenCalled();
    expect(operacoes.filter(o=>o.table==='conversations'&&o.tipo==='update'&&o.row.last_handoff_reason==='orcamento_de_ia')).toEqual([]);
  });
});
