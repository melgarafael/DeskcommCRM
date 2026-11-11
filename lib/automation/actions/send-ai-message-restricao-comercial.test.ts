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
 * Spec 34: a automação dispara por regra, então o cliente NÃO perguntou nada. Barrado,
 * o texto é reescrito UMA vez (a segunda geração recebe o trecho que a trava
 * apontou) e a conversa NÃO passa para a equipe. O orquestrador do CRM
 * (`triggerHandoff`) segue dublê só para provar que NUNCA é chamado.
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
 * ═══ Sabotagem medida (Spec 34) ═══
 *
 *   devolver o `triggerHandoff` ao ramo barrado → previsto 2 vermelhos (os dois
 *   casos em que o texto é barrado); tirar a segunda geração → previsto 1
 *   vermelho (o caso "primeira barrada, segunda limpa"). O caso do texto neutro
 *   é o que impede que uma ação que nunca envia nada satisfaça este arquivo.
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

beforeEach(() => {
  vi.clearAllMocks();
  gerarAbordagemDeFormulario.mockResolvedValue({ ok: true, texto: TEXTO_NEUTRO });
  sendMessageHandler.mockResolvedValue({ id: "mensagem-1", status: "sent" });
  espacarEnvio.mockResolvedValue(undefined);
  triggerHandoff.mockResolvedValue({ triggered: true, reason: "low_confidence", aviso: { avisado: true } });
});

/** Texto limpo que a IA escreve na segunda tentativa. */
const TEXTO_REESCRITO = "Claro! Posso te explicar como funciona. Em que bairro você procura o atendimento?";

describe("send_ai_message × camada comercial LIGADA", () => {
  it("a primeira versão barrada é reescrita uma vez e a segunda sai — sem passar à equipe", async () => {
    gerarAbordagemDeFormulario
      .mockResolvedValueOnce({ ok: true, texto: TEXTO_COMERCIAL })
      .mockResolvedValueOnce({ ok: true, texto: TEXTO_REESCRITO });
    const { cliente } = bancoFalso(true);

    const r = await executar(cliente);

    expect(r.status).toBe("success");
    expect(gerarAbordagemDeFormulario).toHaveBeenCalledTimes(2);
    // A segunda geração sabe o que foi barrado e por quê.
    const segunda = gerarAbordagemDeFormulario.mock.calls[1]?.[2] as {
      tentativaBarrada?: { texto: string; trecho: string | null };
    };
    expect(segunda.tentativaBarrada?.texto).toBe(TEXTO_COMERCIAL);
    expect(typeof segunda.tentativaBarrada?.trecho).toBe("string");
    expect(corpoEnviado()).toBe(TEXTO_REESCRITO);
    expect(triggerHandoff).not.toHaveBeenCalled();
    expect(r.detail?.texto_gerado).toBe(TEXTO_REESCRITO);
    expect(r.detail?.veto_anterior).toMatchObject({ texto_barrado: TEXTO_COMERCIAL });
  });

  it("as duas versões barradas: nada sai, a conversa NÃO passa à equipe e o detalhe guarda os dois textos e o trecho", async () => {
    gerarAbordagemDeFormulario.mockResolvedValue({ ok: true, texto: TEXTO_COMERCIAL });
    const { cliente } = bancoFalso(true);

    const r = await executar(cliente);

    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(espacarEnvio).not.toHaveBeenCalled();
    expect(triggerHandoff).not.toHaveBeenCalled();
    expect(gerarAbordagemDeFormulario).toHaveBeenCalledTimes(2);
    expect(r.status).toBe("skipped");
    expect(r.detail).toMatchObject({
      reason: "commercial_requires_human",
      conversation_id: "conversa-1",
      textos_barrados: [TEXTO_COMERCIAL, TEXTO_COMERCIAL],
    });
    expect(typeof r.detail?.trecho).toBe("string");
  });

  it("texto NEUTRO sai normalmente — e a camada nem é lida (o detector vem primeiro)", async () => {
    const { cliente, idas } = bancoFalso(true);

    const r = await executar(cliente);

    expect(r.status).toBe("success");
    expect(gerarAbordagemDeFormulario).toHaveBeenCalledTimes(1);
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(corpoEnviado()).toBe(TEXTO_NEUTRO);
    expect(triggerHandoff).not.toHaveBeenCalled();
    // O custo de duas idas ao banco por mensagem neutra não se paga: a leitura da
    // camada só acontece quando o corpo tem cara de preço.
    expect(idas.filter((i) => i.tabela === "org_guardrail_layers")).toEqual([]);
  });
});

describe("send_ai_message × camada comercial DESLIGADA", () => {
  it("texto com preço continua saindo igual a hoje — byte a byte, sem segunda geração", async () => {
    gerarAbordagemDeFormulario.mockResolvedValue({ ok: true, texto: TEXTO_COMERCIAL });
    const { cliente, idas } = bancoFalso(false);

    const r = await executar(cliente);

    expect(idas.filter((i) => i.tabela === "org_guardrail_layers")).toHaveLength(1);
    expect(r.status).toBe("success");
    expect(r.detail?.texto_gerado).toBe(TEXTO_COMERCIAL);
    expect(r.detail?.veto_anterior).toBeUndefined();
    expect(gerarAbordagemDeFormulario).toHaveBeenCalledTimes(1);
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(corpoEnviado()).toBe(TEXTO_COMERCIAL);
    expect(triggerHandoff).not.toHaveBeenCalled();
  });
});

describe("send_ai_message × leitura da camada que FALHA", () => {
  it("falha FECHADA: não envia, escreve de novo, e sem passar à equipe", async () => {
    gerarAbordagemDeFormulario.mockResolvedValue({ ok: true, texto: TEXTO_COMERCIAL });
    const { cliente } = bancoFalso("falha");

    const r = await executar(cliente);

    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(r.status).toBe("skipped");
    expect(r.detail?.reason).toBe("commercial_requires_human");
    expect(triggerHandoff).not.toHaveBeenCalled();
  });
});

describe("a aba Atividade ainda sabe traduzir as execuções antigas", () => {
  it("a chave commercial_requires_human_sem_passagem continua no dicionário, e a frase atual não diz que a conversa passou à equipe", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync("app/app/webhooks/_components/ActivityTab.tsx", "utf8");
    expect(fonte).toContain("commercial_requires_human_sem_passagem:");
    const m = /commercial_requires_human:\s*"([^"]+)"/.exec(fonte);
    expect(m?.[1]).toBeDefined();
    expect(m![1]).not.toMatch(/passou para o atendimento humano/);
  });
});
