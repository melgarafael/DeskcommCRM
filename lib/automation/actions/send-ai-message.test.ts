/**
 * A GUARDA DE PRÉ-GO-LIVE DO **PRIMEIRO CONTATO**.
 *
 * ═══ Por que este arquivo existe ═══
 *
 * `send_ai_message` é a única ação que fala com quem NUNCA escreveu: ela nasce
 * de um `lead.created` (formulário, campanha, importação) e abre a conversa.
 * Todos os outros caminhos da IA decidem sobre uma conversa que já existe e
 * passam pelo gate comum de elegibilidade; este não tem conversa para o gate
 * olhar, então a checagem é a das linhas 59-80 de `send-ai-message.ts` —
 * `decidirPreGoLiveDoCanalViaSupabase`, chamada ANTES da chamada paga ao modelo
 * e ANTES de `ensureConversation`.
 *
 * A guarda foi escrita certa e nasceu **sem rede**: medido em 2026-09-06, na
 * triagem do PR #599, apagar as duas dúzias de linhas inteiras deixava
 * `pnpm test:unit` em exit=0, 685 arquivos, 7439 casos verdes. O caminho que
 * mais dói se falhar aberto era o único sem teste que acendesse.
 *
 * ═══ O que se prova aqui, e por que assim ═══
 *
 * O dublê é o CLIENTE do banco, não a função de decisão: `numeroPodeTestar`,
 * `lerNumerosDeTeste` e `decidirPreGoLiveDoCanalViaSupabase` rodam de verdade,
 * sobre a `metadata` que a RPC 0218 grava. Dublar a decisão provaria só que
 * `send-ai-message.ts` chama uma função — o que um `void` satisfaz.
 *
 * `autorizarContatoParaIA` também roda de verdade, pelo mesmo motivo: o dano
 * de furar esta guarda não é só a mensagem que sai. É o `contacts` que fica
 * carimbado como elegível, e aí a IA passa a responder um número real enquanto
 * o operador acredita que o canal está fechado ao público — o cenário que o
 * cabeçalho de `lib/ai/elegibilidade/pre-go-live.ts` nomeia. Por isso o teste
 * observa a ESCRITA no banco, não a chamada da função.
 *
 * ═══ Sabotagem medida (previsão escrita ANTES de rodar, em ambos os casos) ═══
 *
 *   apagar a guarda inteira            → previsto 4 vermelhos, observado 4
 *   movê-la para DEPOIS do modelo      → previsto 3 vermelhos, observado 3
 *
 * A segunda é a que importa: uma guarda que decide certo e chega tarde já
 * gastou o token e é invisível para quem só compara o `status` devolvido. Os
 * três casos que continuam verdes nas duas sabotagens são os de anti-vacuidade
 * — sem eles, uma ação que nunca enviasse nada satisfaria o arquivo inteiro.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

const gerarAbordagemDeFormulario = vi.fn();
const ensureConversation = vi.fn();
const sendMessageHandler = vi.fn();
const espacarEnvio = vi.fn();

// A chamada PAGA ao modelo. Ela ser observável é metade do teste: a guarda
// promete parar antes do gasto, e "parou antes" só se mede vendo o gasto não
// acontecer.
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: (...args: unknown[]) => gerarAbordagemDeFormulario(...args),
}));
// `SUPABASE_DB_URL` não existe na suíte unitária, e sem isto a ação sai por
// `ia_indisponivel` antes de chegar a qualquer coisa que importe.
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/automation/start-conversation", () => ({
  ensureConversation: (...args: unknown[]) => ensureConversation(...args),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: (...args: unknown[]) => sendMessageHandler(...args),
}));
// O espaçamento anti-banimento dorme de verdade entre dois envios da mesma
// sessão. Nada a provar aqui, e 1,2s por caso é o tipo de lentidão que faz
// alguém marcar a suíte como flaky.
vi.mock("@/lib/automation/throttle", () => ({
  espacarEnvio: (...args: unknown[]) => espacarEnvio(...args),
  checkDailyLimit: vi.fn(async () => ({ allowed: true })),
}));

import { getAction } from "@/lib/automation/actions";
// Importa a ação pela porta do efeito colateral, igual `register-all.ts`.
import "@/lib/automation/actions/send-ai-message";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const NUMERO_DE_TESTE = "+5511999998888";
const EVENTO = "33333333-3333-4333-8333-333333333333";
const FRONTEIRA = {
  organization_id: ORG, contact_id: "contato-1", conversation_id: "conversa-1",
  service_revision: 1, demanda_id: null, demanda_revision: null,
  status: "open", demanda_fechada_em: null,
};

interface EscritaNoBanco {
  tabela: string;
  operacao: "select" | "update";
}

/** Como a RPC 0218 grava um canal em modo de teste. */
function canalEmTeste(numeros: string[]): Record<string, unknown> {
  return {
    transport: { keep: true },
    ai_gate: "allowlist",
    ai_gate_mode: "pre_go_live",
    ai_test_phone_numbers: numeros,
  };
}

/**
 * Dublê do cliente admin. Registra toda ida ao banco para o teste poder afirmar
 * o que NÃO foi escrito — que é o que a guarda promete.
 */
function bancoFalso(canal: { metadata?: unknown; existe?: boolean; erro?: string; origemObsoleta?: boolean }) {
  const idas: EscritaNoBanco[] = [];
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
      if (tabela === "conversations") return { data: { channel_session_id: CANAL }, error: null };
      if (tabela === "organizations") return { data: { settings: {} }, error: null };
      if (tabela !== "channel_sessions") return { data: { id: "contato-1" }, error: null };
      if (canal.erro) return { data: null, error: { message: canal.erro } };
      return { data: canal.existe === false ? null : { metadata: canal.metadata }, error: null };
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
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    expect(args.p_org).toBe(ORG);
    if (name === "fn_service_event_origin") {
      expect(args).toEqual({ p_org: ORG, p_event: EVENTO, p_contact: "contato-1", p_session: CANAL });
      return { data: FRONTEIRA, error: null };
    }
    if (name === "fn_service_boundary") {
      expect(args.p_conversation).toBe(FRONTEIRA.conversation_id);
      return { data: { ...FRONTEIRA, service_revision: canal.origemObsoleta ? 2 : 1 }, error: null };
    }
    throw new Error(`RPC não prevista: ${name}`);
  });
  return { cliente: { from, rpc } as unknown as ActionCtx["admin"], idas, rpc };
}

function executar(admin: ActionCtx["admin"], telefone: string): Promise<ActionResultDetail> {
  const acao = getAction("send_ai_message");
  if (!acao) throw new Error("send_ai_message não está registrada");
  const ctx: ActionCtx = {
    admin,
    organizationId: ORG,
    ruleId: "regra-1",
    ruleName: "Primeiro contato — formulário do site",
    event: { id: EVENTO } as ActionCtx["event"],
    requestId: "req-1",
    // Sem `lead` de propósito: com ele a ação vai ao banco buscar a captação do
    // formulário, e o que se mede aqui não depende disso.
    context: { contact: { id: "contato-1", phone_number: telefone } },
  };
  return acao.execute(ctx, {
    channel_session_id: CANAL,
    agent_id: "agente-1",
    instruction: "Cumprimente e pergunte em que bairro a pessoa procura.",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  gerarAbordagemDeFormulario.mockResolvedValue({ ok: true, texto: "Oi! Em que bairro você procura?" });
  ensureConversation.mockResolvedValue("conversa-1");
  sendMessageHandler.mockResolvedValue({ id: "mensagem-1", status: "sent" });
  espacarEnvio.mockResolvedValue(undefined);
});

describe("send_ai_message em canal no modo de teste — número FORA da lista", () => {
  it("não gasta o modelo, não abre conversa e não envia", async () => {
    const { cliente, rpc } = bancoFalso({ metadata: canalEmTeste([NUMERO_DE_TESTE]) });

    const r = await executar(cliente, "+5521988887777");

    expect(r).toEqual({
      type: "send_ai_message",
      status: "skipped",
      detail: { reason: "fora_da_lista_de_teste" },
    });
    expect(gerarAbordagemDeFormulario).not.toHaveBeenCalled();
    expect(ensureConversation).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("o contato NÃO fica elegível para a IA responder depois", async () => {
    // Sem esta metade, uma guarda que só barrasse o envio ainda deixaria o
    // rastro que faz a IA assumir o próximo inbound de um número real.
    const { cliente, idas } = bancoFalso({ metadata: canalEmTeste([NUMERO_DE_TESTE]) });

    await executar(cliente, "+5521988887777");

    expect(idas.filter((i) => i.tabela === "contacts" && i.operacao === "update")).toEqual([]);
  });
});

describe("send_ai_message — quem PODE receber continua recebendo", () => {
  it("número cadastrado passa, mesmo cadastrado com o nono dígito e gravado sem ele", async () => {
    // Anti-vacuidade: sem este caso, uma ação que nunca envia nada satisfaria o
    // bloco acima inteiro. E o nono dígito é o caso real — o operador cadastra
    // `+55 11 99999-8888` e o WhatsApp entrega o contato com 12 dígitos.
    const { cliente } = bancoFalso({ metadata: canalEmTeste([NUMERO_DE_TESTE]) });

    const r = await executar(cliente, "+551199998888");

    expect(r.status).toBe("success");
    expect(gerarAbordagemDeFormulario).toHaveBeenCalledTimes(1);
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
  });

  it("canal aberto ao público não é barrado", async () => {
    const { cliente } = bancoFalso({ metadata: { ai_gate: "open", ai_test_phone_numbers: [] } });

    const r = await executar(cliente, "+5521988887777");

    expect(r.status).toBe("success");
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
  });

  it("allowlist LEGADO — sem `ai_gate_mode` — não vira modo de teste por engano", async () => {
    // O canal que já existia antes desta entrega acorda com `{ai_gate:
    // "allowlist"}` e nada mais. Lê-lo como pré-go-live calaria a automação de
    // toda instalação que atualizasse.
    const { cliente } = bancoFalso({ metadata: { ai_gate: "allowlist" } });

    const r = await executar(cliente, "+5521988887777");

    expect(r.status).toBe("success");
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
  });
});

describe("send_ai_message — indeterminado é PARAR, nunca seguir", () => {
  it("origem do evento obsoleta barra antes do modelo e de autorizar o contato", async () => {
    const { cliente, idas } = bancoFalso({ metadata: { ai_gate: "open" }, origemObsoleta: true });
    const r = await executar(cliente, NUMERO_DE_TESTE);
    expect(r).toMatchObject({ status: "failed", error: "service_boundary_stale" });
    expect(gerarAbordagemDeFormulario).not.toHaveBeenCalled();
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(idas.filter((i) => i.tabela === "contacts" && i.operacao === "update")).toEqual([]);
  });

  it("banco fora do ar durante a leitura do canal: skipped, sem gastar e sem enviar", async () => {
    const { cliente } = bancoFalso({ erro: "connection terminated unexpectedly" });

    const r = await executar(cliente, NUMERO_DE_TESTE);

    expect(r.status).toBe("skipped");
    expect(r.detail?.reason).toBe("elegibilidade_indeterminada");
    expect(gerarAbordagemDeFormulario).not.toHaveBeenCalled();
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("canal que não existe para esta organização: skipped, sem enviar", async () => {
    // A leitura filtra por `organization_id`; canal de outro tenant volta vazio.
    // Vazio não é "sem restrição" — é não saber, e não saber não envia.
    const { cliente } = bancoFalso({ existe: false });

    const r = await executar(cliente, NUMERO_DE_TESTE);

    expect(r.status).toBe("skipped");
    expect(r.detail?.reason).toBe("elegibilidade_indeterminada");
    expect(gerarAbordagemDeFormulario).not.toHaveBeenCalled();
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });
});
