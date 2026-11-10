/**
 * #3274 — A RESTRIÇÃO COMERCIAL NA MENSAGEM ESCRITA PELA IA.
 *
 * ═══ O defeito que este arquivo tranca ═══
 *
 * `send_ai_message` gera o texto por IA e o entrega por `sendMessageHandler` SEM
 * atravessar a cadeia `before_send`. Nas outras portas que falam com o cliente, o
 * gate `commercial_restriction` (#2877, levado adiante pelo #3270) barra o corpo
 * com preço e passa a conversa para a equipe. Nesta ação não havia régua nenhuma:
 * numa organização com a camada `restricao_comercial` ligada ("valores e
 * negociação só com a equipe"), uma automação mandava preço escrito pela IA.
 *
 * ═══ O que se prova aqui, e por que assim ═══
 *
 * O dublê é o CLIENTE do banco, não a função de decisão: o detector
 * (`contemAssuntoComercialNaSaida`), a composição (`restricaoComercialBarra`) e a
 * leitura da camada (`comercialExigeHumanoViaSupabase`) rodam de verdade, sobre a
 * resposta que o dublê dá para `org_guardrail_layers` — a mesma forma do vizinho
 * `lib/followup/enviar-texto-fixo.test.ts`, o outro caminho que ganhou esta régua.
 * Dublar a decisão provaria só que a ação chama uma função — o que um `void`
 * satisfaz.
 *
 * O orquestrador do CRM (`triggerHandoff`) É dublê: o que se prova aqui é que a
 * ação o aciona, com que vocabulário (motivo `low_confidence`, origem
 * `runtime_nativo`, o mesmo texto da cadeia) e ANTES de qualquer envio — não que
 * ele grava a passagem, o que é dele e já tem teste próprio.
 *
 * ═══ O que este arquivo NÃO prova ═══
 *
 *   - que a camada `restricao_comercial` aparece numa tela (o painel de guardrails
 *     tem testes de rota próprios);
 *   - que a ação `send_whatsapp_message` (template) está coberta: a issue #3274
 *     delimita o pedido à mensagem escrita pela IA, e o template não passa por
 *     esta régua aqui;
 *   - o envio real ao canal: `sendMessageHandler` é dublê, como no vizinho
 *     `send-ai-message.test.ts`.
 *
 * ═══ Sabotagem medida ═══
 *
 *   apagar a régua inteira de `send-ai-message.ts`
 *     → previsto 3 vermelhos, observado 4.
 *
 *       Os três previstos: o caso 1 (camada ligada + texto comercial), o 4
 *       (falha fechada) e o 5 (passagem recusada). O quarto é o caso 3, e a
 *       lição fica escrita porque a previsão errou: ele prova que a camada
 *       DESLIGADA mantém o comportamento de hoje, e para isso mede a LEITURA da
 *       camada (`idas`). Sem a régua não há leitura nenhuma — o caso fica
 *       vermelho por uma razão que não é a do defeito. Quem apagar a régua vê
 *       quatro, não três.
 *
 *       O único verde nas duas direções é o caso 2 (camada ligada + texto
 *       neutro), que existe justamente para impedir que uma ação que nunca envia
 *       nada satisfaça este arquivo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

const gerarAbordagemDeFormulario = vi.fn();
const sendMessageHandler = vi.fn();
const espacarEnvio = vi.fn();
const triggerHandoff = vi.fn();

vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: (...args: unknown[]) => gerarAbordagemDeFormulario(...args),
}));
// `SUPABASE_DB_URL` não existe na suíte unitária: sem isto a ação sai por
// `ia_indisponivel` antes de chegar a qualquer coisa que importe.
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/automation/start-conversation", () => ({ ensureConversation: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: (...args: unknown[]) => sendMessageHandler(...args),
}));
vi.mock("@/lib/automation/throttle", () => ({
  espacarEnvio: (...args: unknown[]) => espacarEnvio(...args),
  checkDailyLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/ai/handoff/orchestrator", () => ({
  triggerHandoff: (...args: unknown[]) => triggerHandoff(...args),
}));

import { getAction } from "@/lib/automation/actions";
// Importa a ação pela porta do efeito colateral, igual `register-all.ts`.
import "@/lib/automation/actions/send-ai-message";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const NUMERO_DE_TESTE = "+5511988887777";
const EVENTO = "33333333-3333-4333-8333-333333333333";
const FRONTEIRA = {
  organization_id: ORG,
  contact_id: "contato-1",
  conversation_id: "conversa-1",
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
  status: "open",
  demanda_fechada_em: null,
};

/** Texto que a IA pode escrever e que a camada barra — preço explícito. */
const TEXTO_COMERCIAL = "Claro! A consulta fica R$ 300,00, e dá para fazer em 3x no cartão.";
/** Texto que a IA escreve e que não tem nada de preço. */
const TEXTO_NEUTRO = "Oi! Em que bairro você procura o atendimento?";

interface LeituraNoBanco {
  tabela: string;
  operacao: "select" | "update";
}

/**
 * Dublê do cliente admin. A resposta de `org_guardrail_layers` é o ESTADO que o
 * teste escolhe: `true` (camada ligada), `false` (desligada) ou `"falha"` (a
 * leitura estoura — o caso da falha fechada). Toda ida ao banco entra em `idas`,
 * para o teste afirmar o que NÃO foi lido nem escrito.
 */
function bancoFalso(camadaComercial: boolean | "falha") {
  const idas: LeituraNoBanco[] = [];
  const from = (tabela: string) => {
    let operacao: "select" | "update" = "select";
    const encadeavel: Record<string, unknown> = {};
    for (const metodo of ["select", "eq", "is", "in", "order", "limit"]) {
      encadeavel[metodo] = () => encadeavel;
    }
    encadeavel.update = () => {
      operacao = "update";
      return encadeavel;
    };
    encadeavel.maybeSingle = async () => {
      idas.push({ tabela, operacao });
      if (tabela === "org_guardrail_layers") {
        return camadaComercial === "falha"
          ? { data: null, error: { message: "offline" } }
          : { data: { enabled: camadaComercial }, error: null };
      }
      if (tabela === "conversations") return { data: { channel_session_id: CANAL }, error: null };
      if (tabela === "organizations") return { data: { settings: {} }, error: null };
      if (tabela !== "channel_sessions") return { data: { id: "contato-1" }, error: null };
      // Canal em modo de teste com ESTE número na lista: é o estado em que a
      // ação passa da guarda de pré-go-live e chega ao envio.
      return {
        data: { metadata: { ai_gate: "allowlist", ai_gate_mode: "pre_go_live", ai_test_phone_numbers: [NUMERO_DE_TESTE] } },
        error: null,
      };
    };
    encadeavel.single = encadeavel.maybeSingle;
    encadeavel.then = (resolve: (value: unknown) => unknown) => {
      if (tabela !== "calendar_appointments") throw new Error(`Leitura em lista não prevista: ${tabela}`);
      idas.push({ tabela, operacao });
      return Promise.resolve({ data: [], error: null }).then(resolve);
    };
    return encadeavel;
  };
  // A origem e suas guardas rodam de verdade; o dublê fornece o recibo do evento.
  const rpc = vi.fn(async (name: string) => {
    if (name === "fn_service_event_origin") return { data: FRONTEIRA, error: null };
    if (name === "fn_service_boundary") return { data: { ...FRONTEIRA }, error: null };
    throw new Error(`RPC não prevista: ${name}`);
  });
  return { cliente: { from, rpc } as unknown as ActionCtx["admin"], idas, rpc };
}

function executar(admin: ActionCtx["admin"]): Promise<ActionResultDetail> {
  const acao = getAction("send_ai_message");
  if (!acao) throw new Error("send_ai_message não está registrada");
  const ctx: ActionCtx = {
    admin,
    organizationId: ORG,
    ruleId: "regra-1",
    ruleName: "Primeiro contato — formulário do site",
    event: { id: EVENTO } as ActionCtx["event"],
    requestId: "req-1",
    // Sem `lead`: o evento de teste não traz um, e a ação tem de seguir sem ele
    // (é o `leadId` que vai à passagem como `null`).
    context: { contact: { id: "contato-1", phone_number: NUMERO_DE_TESTE } },
  };
  return acao.execute(ctx, {
    channel_session_id: CANAL,
    agent_id: "agente-1",
    instruction: "Cumprimente e pergunte em que bairro a pessoa procura.",
  });
}

/** O corpo que a ação mandou ao handler — é ele que não pode sair. */
function corpoEnviado(): string | undefined {
  const chamada = sendMessageHandler.mock.calls[0];
  return (chamada?.[2] as { body?: string } | undefined)?.body;
}

/** O que a ação entregou ao orquestrador da passagem. */
function pedidoDaPassagem(): Record<string, unknown> {
  const chamada = triggerHandoff.mock.calls[0];
  if (!chamada) throw new Error("triggerHandoff não foi chamado");
  return chamada[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  gerarAbordagemDeFormulario.mockResolvedValue({ ok: true, texto: TEXTO_NEUTRO });
  sendMessageHandler.mockResolvedValue({ id: "mensagem-1", status: "sent" });
  espacarEnvio.mockResolvedValue(undefined);
  triggerHandoff.mockResolvedValue({ triggered: true, reason: "low_confidence", aviso: { avisado: true } });
});

describe("send_ai_message × camada comercial LIGADA", () => {
  it("texto com preço NÃO sai e vira passagem para a equipe, com o vocabulário da cadeia", async () => {
    gerarAbordagemDeFormulario.mockResolvedValue({ ok: true, texto: TEXTO_COMERCIAL });
    const { cliente } = bancoFalso(true);

    const r = await executar(cliente);

    // 1. Não saiu — e parou ANTES do espaçamento anti-banimento, que é o último
    //    passo antes do handler.
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(espacarEnvio).not.toHaveBeenCalled();
    // 2. O desfecho é o do veto da cadeia, não um código novo.
    expect(r).toEqual({
      type: "send_ai_message",
      status: "skipped",
      detail: {
        reason: "commercial_requires_human",
        conversation_id: "conversa-1",
        passagem_para_a_equipe: true,
      },
    });
    // 3. A equipe foi acionada: MESMO motivo e MESMO texto que o turno do agente
    //    usa quando a cadeia veta (`inbound-turn.ts`, `passarComercialParaEquipe`).
    expect(triggerHandoff).toHaveBeenCalledTimes(1);
    expect(pedidoDaPassagem()).toMatchObject({
      conversationId: "conversa-1",
      organizationId: ORG,
      reason: "low_confidence",
      origem: "runtime_nativo",
      motivoTexto: "Resposta comercial barrada; valores e negociação são exclusivos da equipe.",
      leadId: null,
      metadata: { source: "automation_rule", acao: "send_ai_message", rule_id: "regra-1" },
    });
    expect(pedidoDaPassagem().serviceBoundary).toMatchObject({
      organization_id: ORG,
      conversation_id: "conversa-1",
    });
  });

  it("texto NEUTRO sai normalmente — e a camada nem é lida (o detector vem primeiro)", async () => {
    const { cliente, idas } = bancoFalso(true);

    const r = await executar(cliente);

    expect(r.status).toBe("success");
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(corpoEnviado()).toBe(TEXTO_NEUTRO);
    expect(triggerHandoff).not.toHaveBeenCalled();
    // O custo de duas idas ao banco por mensagem neutra não se paga: a leitura da
    // camada só acontece quando o corpo tem cara de preço.
    expect(idas.filter((i) => i.tabela === "org_guardrail_layers")).toEqual([]);
  });
});

describe("send_ai_message × camada comercial DESLIGADA", () => {
  it("texto com preço continua saindo igual a hoje — byte a byte", async () => {
    gerarAbordagemDeFormulario.mockResolvedValue({ ok: true, texto: TEXTO_COMERCIAL });
    const { cliente, idas } = bancoFalso(false);

    const r = await executar(cliente);

    // A camada FOI lida (o corpo tem cara de preço) e disse não: o envio segue
    // com o MESMO corpo e o MESMO desfecho de antes desta entrega.
    expect(idas.filter((i) => i.tabela === "org_guardrail_layers")).toHaveLength(1);
    expect(r.status).toBe("success");
    expect(r.detail?.texto_gerado).toBe(TEXTO_COMERCIAL);
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(corpoEnviado()).toBe(TEXTO_COMERCIAL);
    expect(triggerHandoff).not.toHaveBeenCalled();
  });
});

describe("send_ai_message × leitura da camada que FALHA", () => {
  it("falha FECHADA: não envia e passa para a equipe", async () => {
    gerarAbordagemDeFormulario.mockResolvedValue({ ok: true, texto: TEXTO_COMERCIAL });
    const { cliente } = bancoFalso("falha");

    const r = await executar(cliente);

    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(r.status).toBe("skipped");
    expect(r.detail?.reason).toBe("commercial_requires_human");
    expect(triggerHandoff).toHaveBeenCalledTimes(1);
  });

  it("passagem recusada pelo orquestrador NÃO vira envio: o silêncio é preferível ao preço", async () => {
    // A conversa pode não ser elegível (gate `allowlist`, já em handoff…). O
    // desfecho registra a recusa, mas o que não pode acontecer é a mensagem sair
    // porque a passagem não deu certo.
    gerarAbordagemDeFormulario.mockResolvedValue({ ok: true, texto: TEXTO_COMERCIAL });
    triggerHandoff.mockResolvedValue({ triggered: false, reason: "nao_elegivel:sem_autorizacao" });
    const { cliente } = bancoFalso(true);

    const r = await executar(cliente);

    expect(sendMessageHandler).not.toHaveBeenCalled();
    // E o motivo NÃO é o da passagem feita: a frase de `commercial_requires_human`
    // na aba Atividade diz que a conversa passou para a equipe, o que aqui é falso.
    expect(r.detail).toMatchObject({
      reason: "commercial_requires_human_sem_passagem",
      passagem_para_a_equipe: false,
    });
  });
});
