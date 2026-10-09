import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS OUTRAS LEITURAS DO ATENDIMENTO TAMBÉM FICAM ESCOPADAS AO CONTATO DO TURNO (#2178).
 *
 * O #2175 escopou as duas leituras de CONTATO do pacote `atender`
 * (`crm_search_contacts` e `crm_get_contact`). As demais leituras que o turno
 * usa — `crm_list_conversations`, `crm_get_conversation`,
 * `crm_get_conversation_history` (atender/escalar) e `crm_list_contact_orders`
 * (vender/atender) — seguem filtrando só
 * `organization_id`: não há vazamento entre ORGANIZAÇÕES, mas um turno com o
 * cliente A alcança as conversas, as mensagens e os PEDIDOS do cliente B da
 * mesma empresa.
 *
 * A regra é a mesma que o #2175 provou e a issue #2178 reforça: o pacote não é
 * distinguível no ponto da trava (`tool_ids` é snapshot achatado por versão),
 * então o escopo amarra em `ctx.contatoDoTurno` — presente, a leitura devolve
 * só o que pertence a ele (ou recusa com motivo, no mesmo formato que
 * `negocioDaEscritaDoTurno` devolve); ausente, comportamento idêntico ao de
 * hoje. Os controles no fim provam a segunda metade. O Operador também recebe o
 * contato do turno (`operator-turn.ts` passa `contactId`), então o escopo vale
 * para ele.
 *
 * A asserção é sobre a CADEIA: monta a ferramenta como o turno monta
 * (`pickToolsFromMcp`) com `contatoDoTurno` presente e lê o que o handler
 * devolveu — ou a recusa que voltou ao modelo.
 */

vi.mock("@/lib/audit", () => ({
  audit: vi.fn().mockResolvedValue(undefined),
  isServiceRoleConfigured: () => false,
}));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/app/api/v1/conversations/_handler", async (original) => ({
  ...(await original<typeof import("@/app/api/v1/conversations/_handler")>()),
  listConversationsHandler: vi.fn(),
  getConversationHandler: vi.fn(),
}));
vi.mock("@/app/api/v1/messages/_handler", async (original) => ({
  ...(await original<typeof import("@/app/api/v1/messages/_handler")>()),
  listMessagesHandler: vi.fn(),
}));

const { listConversationsHandler, getConversationHandler } = await import(
  "@/app/api/v1/conversations/_handler"
);
const { listMessagesHandler } = await import("@/app/api/v1/messages/_handler");
const { auditMcpToolCall } = await import("@/lib/mcp/audit");
const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");
const { ApiError } = await import("@/lib/api/types");

const ORG = "11111111-1111-4111-8111-111111111111";
/** Quem está do outro lado DO LADO DE CÁ — o contato que este turno atende. */
const DA_CONVERSA = "22222222-2222-4222-8222-222222222222";
/** Quem está do outro lado DO LADO DE LÁ — o cliente B, da mesma organização. */
const DE_OUTRO_CLIENTE = "66666666-6666-4666-8666-666666666666";
const CONVERSA_DA_CONVERSA = "aaaaaaaa-1111-4111-8111-111111111111";
const CONVERSA_DE_B = "aaaaaaaa-2222-4222-8222-222222222222";
const FUNIL = "44444444-4444-4444-8444-444444444444";

const TELEFONE_DE_B = "(11) 98888-7777";
const EMAIL_DE_B = "maria.souza@exemplo.com";
/** Prévia da conversa de B — o dado que a listagem/devolução não pode conter. */
const PREVIA_DE_B = `pedido confirmado para ${TELEFONE_DE_B}, comprovante em ${EMAIL_DE_B}`;
const MENSAGEM_DE_B = `obrigada, mandei o pix para ${EMAIL_DE_B}`;
const RASTREIO_DE_B = "BR9988776655";

function conversa(id: string, contactId: string, preview: string) {
  return {
    id,
    contact_id: contactId,
    channel_session_id: "sessão",
    channel: "whatsapp",
    status: "open",
    assigned_to_user_id: null,
    assignee_kind: null,
    tags: [],
    comando_da_conversa: null,
    assigned_at: null,
    last_inbound_at: "2026-09-24T02:38:00.000Z",
    last_outbound_at: null,
    last_message_at: "2026-09-24T02:38:00.000Z",
    last_message_preview: preview,
    unread_count_for_assignee: 1,
    is_group: false,
    group_chat_id: null,
    created_at: "2026-09-24T02:00:00.000Z",
  };
}

function paginaDeConversas() {
  return {
    conversations: [
      conversa(CONVERSA_DA_CONVERSA, DA_CONVERSA, "bom dia, preciso de ajuda"),
      conversa(CONVERSA_DE_B, DE_OUTRO_CLIENTE, PREVIA_DE_B),
    ],
    cursor: "cur-2",
    has_more: true,
  };
}

function paginaDeMensagens() {
  return {
    messages: [
      {
        id: "m1",
        direction: "inbound",
        type: "text",
        body: MENSAGEM_DE_B,
        media_url: null,
        sent_via: "whatsapp",
        sent_at: "2026-09-24T02:38:00.000Z",
        status: "delivered",
      },
    ],
    cursor: null,
    has_more: false,
  };
}

/** Pedidos de B — vem do banco, então o duplo do supabase é quem os devolve. */
const PEDIDO_DE_B = {
  id: "pp-1",
  external_id: "ext-1",
  external_provider: "shopify",
  status: "paid",
  total_cents: 12_500,
  currency: "BRL",
  payment_method: "pix",
  fulfillment_status: "shipped",
  tracking_code: RASTREIO_DE_B,
  ordered_at: "2026-09-20T10:00:00.000Z",
  is_anonymized: false,
};

/** Cadeia supabase do `crm_list_contact_orders`: grava o que foi consultado. */
function supabaseFalso() {
  const consultas: Array<{ tabela: string; filtros: Record<string, unknown> }> = [];
  const from = (tabela: string) => {
    const registro = { tabela, filtros: {} as Record<string, unknown> };
    consultas.push(registro);
    const q: Record<string, unknown> = {};
    const cadeia = q as {
      select: () => typeof q;
      eq: (coluna: string, valor: unknown) => typeof q;
      order: () => typeof q;
      limit: () => typeof q;
      then: (ok: (r: unknown) => unknown) => Promise<unknown>;
    };
    cadeia.select = () => cadeia as never;
    cadeia.eq = (coluna, valor) => {
      registro.filtros[coluna] = valor;
      return cadeia as never;
    };
    cadeia.order = () => cadeia as never;
    cadeia.limit = () => cadeia as never;
    cadeia.then = (ok) =>
      Promise.resolve({ data: tabela === "orders" ? [PEDIDO_DE_B] : [], error: null }).then(ok);
    return cadeia;
  };
  return {
    from,
    consultas,
    auth: { admin: { getUserById: () => Promise.resolve({ data: { user: null }, error: null }) } },
  };
}

let supabase = supabaseFalso();

function montar(toolIds: string[], contatoDoTurno?: string) {
  const ator = { type: "ai_agent", id: "ag-1", role: "ai_operator" };
  return pickToolsFromMcp({
    toolIds,
    auth: { organizationId: ORG, role: "ai_operator", scopes: ["mcp:read", "mcp:write"], actor: ator, apiTokenId: "tok-1" },
    ctx: { organizationId: ORG, role: "ai_operator", actor: ator, apiTokenId: "tok-1", requestId: "req-1", supabase },
    supabase,
    pipelineIds: [FUNIL],
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    ...(contatoDoTurno ? { contatoDoTurno } : {}),
  } as never);
}

async function executar(toolIds: string[], args: Record<string, unknown>, contatoDoTurno?: string) {
  const [nome] = toolIds;
  const ferramenta = montar(toolIds, contatoDoTurno)[nome!]!;
  return ferramenta.execute!(args, { toolCallId: "c1", messages: [] } as never);
}

const idsDe = (r: unknown) =>
  ((r as { conversations?: Array<{ id: string }> }).conversations ?? []).map((c) => c.id);

beforeEach(() => {
  supabase = supabaseFalso();
  // O duplo REPETE o contrato do handler (#2184): o `contact_id` que a
  // ferramenta passa já sai como predicado da consulta, então a página que
  // volta é do contato. O predicado em si — o `eq("contact_id", …)` no `WHERE`,
  // antes do `.limit` — é medido em
  // `tests/unit/contato-do-turno-filtra-no-banco.test.ts`.
  vi.mocked(listConversationsHandler)
    .mockReset()
    .mockImplementation(async (_s, _c, q) => {
      const pagina = paginaDeConversas();
      const filtro = (q as { contact_id?: string }).contact_id;
      return (
        filtro
          ? {
              ...pagina,
              conversations: pagina.conversations.filter((c) => c.contact_id === filtro),
            }
          : pagina
      ) as never;
    });
  vi.mocked(getConversationHandler)
    .mockReset()
    .mockResolvedValue(conversa(CONVERSA_DE_B, DE_OUTRO_CLIENTE, PREVIA_DE_B) as never);
  vi.mocked(listMessagesHandler).mockReset().mockResolvedValue(paginaDeMensagens() as never);
  vi.mocked(auditMcpToolCall).mockReset().mockResolvedValue(undefined);
});

describe("com contato do turno, a leitura de conversa só alcança o contato dele", () => {
  // O caso da issue: conversa com A, a listagem devolve a conversa de B com a
  // prévia da última mensagem de B dentro.
  it("crm_list_conversations não devolve a conversa de OUTRO cliente da mesma organização", async () => {
    const r = await executar(["crm_list_conversations"], {}, DA_CONVERSA);
    expect(idsDe(r)).not.toContain(CONVERSA_DE_B);
    expect(idsDe(r)).toContain(CONVERSA_DA_CONVERSA);
    expect(JSON.stringify(r)).not.toContain(PREVIA_DE_B);
    expect(JSON.stringify(r)).not.toContain(EMAIL_DE_B);
    // E o contato saiu NA CONSULTA do handler — é o predicado, e não um
    // recorte da página, que garante a lista acima (#2184).
    expect(vi.mocked(listConversationsHandler).mock.calls[0]![2]).toMatchObject({
      contact_id: DA_CONVERSA,
    });
  });

  // O escopo mora no `WHERE` (#2184), então a página É do contato: a próxima
  // página continua sendo dele, e cursor/`has_more` voltam a valer. Era o
  // contrário enquanto o filtro era de página — com 10 conversas por página, a
  // conversa mais antiga do mesmo cliente ficava invisível e o
  // `has_more: false` dizia que não havia mais nada.
  it("crm_list_conversations mantém cursor e has_more porque a página já é do contato", async () => {
    const r = await executar(["crm_list_conversations"], {}, DA_CONVERSA);
    expect(r).toMatchObject({ cursor: "cur-2", has_more: true });
  });

  // Mesma coisa com o filtro explícito: pedir o contato de OUTRO cliente não
  // devolve a conversa dele — e nem a do contato do turno, porque o pedido é
  // de quem não é desta conversa.
  it("crm_list_conversations com contact_id de OUTRO cliente volta vazia", async () => {
    const r = await executar(["crm_list_conversations"], { contact_id: DE_OUTRO_CLIENTE }, DA_CONVERSA);
    expect(idsDe(r)).toEqual([]);
  });

  it("crm_get_conversation de OUTRO cliente é recusada com motivo em texto", async () => {
    const r = await executar(["crm_get_conversation"], { conversation_id: CONVERSA_DE_B }, DA_CONVERSA);
    expect(r).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    const motivo = (r as { motivo?: unknown }).motivo;
    const mensagem = (r as { mensagem?: unknown }).mensagem;
    expect(typeof motivo).toBe("string");
    expect(typeof mensagem).toBe("string");
    expect((mensagem as string).length).toBeGreaterThan(20);
    expect(JSON.stringify(r)).not.toContain(PREVIA_DE_B);
  });

  // A recusa entra no audit como recusa, igual à de escrita — `success: true`
  // contaria como acerto uma conversa que o agente NÃO pôde abrir.
  it("crm_get_conversation recusada é auditada como recusa, com o motivo", async () => {
    await executar(["crm_get_conversation"], { conversation_id: CONVERSA_DE_B }, DA_CONVERSA);
    expect(auditMcpToolCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(auditMcpToolCall).mock.calls[0]![0]).toMatchObject({
      toolName: "crm_get_conversation",
      success: false,
      errorMessage: "contato_da_conversa:fora_da_conversa",
    });
  });

  it("crm_get_conversation DA conversa do turno continua abrindo", async () => {
    vi.mocked(getConversationHandler).mockResolvedValue(
      conversa(CONVERSA_DA_CONVERSA, DA_CONVERSA, "bom dia, preciso de ajuda") as never,
    );
    const r = await executar(["crm_get_conversation"], { conversation_id: CONVERSA_DA_CONVERSA }, DA_CONVERSA);
    expect(getConversationHandler).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ id: CONVERSA_DA_CONVERSA, contact_id: DA_CONVERSA });
  });

  // O histórico é a leitura que mais sai do prédio: texto de ponta a ponta.
  // A conferência de QUEM é a conversa vem ANTES de ler as mensagens — recusar
  // depois de carregar seria deixar o dado do outro cliente entrar na memória
  // para jogá-lo fora em seguida.
  it("crm_get_conversation_history de OUTRO cliente é recusado e as mensagens não são lidas", async () => {
    const r = await executar(
      ["crm_get_conversation_history"],
      { conversation_id: CONVERSA_DE_B },
      DA_CONVERSA,
    );
    expect(listMessagesHandler).not.toHaveBeenCalled();
    expect(r).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(JSON.stringify(r)).not.toContain(MENSAGEM_DE_B);
    expect(JSON.stringify(r)).not.toContain(EMAIL_DE_B);
  });

  it("crm_get_conversation_history recusado é auditado como recusa, com o motivo", async () => {
    await executar(["crm_get_conversation_history"], { conversation_id: CONVERSA_DE_B }, DA_CONVERSA);
    expect(vi.mocked(auditMcpToolCall).mock.calls[0]![0]).toMatchObject({
      toolName: "crm_get_conversation_history",
      success: false,
      errorMessage: "contato_da_conversa:fora_da_conversa",
    });
  });

  it("crm_get_conversation_history DA conversa do turno continua vindo", async () => {
    vi.mocked(getConversationHandler).mockResolvedValue(
      conversa(CONVERSA_DA_CONVERSA, DA_CONVERSA, "bom dia") as never,
    );
    const r = await executar(
      ["crm_get_conversation_history"],
      { conversation_id: CONVERSA_DA_CONVERSA },
      DA_CONVERSA,
    );
    expect(listMessagesHandler).toHaveBeenCalledTimes(1);
    expect((r as { messages?: unknown[] }).messages).toHaveLength(1);
  });

  // Pedidos: a chamada é por `contact_id`, o mesmo formato de `crm_get_contact`
  // — a ficha/pedido de quem não é desta conversa não é do turno para abrir.
  it("crm_list_contact_orders de OUTRO cliente é recusada e a consulta não roda", async () => {
    const r = await executar(["crm_list_contact_orders"], { contact_id: DE_OUTRO_CLIENTE }, DA_CONVERSA);
    expect(supabase.consultas.some((c) => c.tabela === "orders")).toBe(false);
    expect(r).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(JSON.stringify(r)).not.toContain(RASTREIO_DE_B);
  });

  it("crm_list_contact_orders recusada é auditada como recusa, com o motivo", async () => {
    await executar(["crm_list_contact_orders"], { contact_id: DE_OUTRO_CLIENTE }, DA_CONVERSA);
    expect(vi.mocked(auditMcpToolCall).mock.calls[0]![0]).toMatchObject({
      toolName: "crm_list_contact_orders",
      success: false,
      errorMessage: "contato_da_conversa:fora_da_conversa",
    });
  });

  it("crm_list_contact_orders DO contato do turno continua listando", async () => {
    const r = await executar(["crm_list_contact_orders"], { contact_id: DA_CONVERSA }, DA_CONVERSA);
    expect(supabase.consultas.some((c) => c.tabela === "orders")).toBe(true);
    expect(r).toMatchObject({ pedidos: [{ id: "pp-1" }] });
  });
});

// Controle: sem contato do turno — rota HTTP, MCP externo, agente sem conversa
// — o comportamento é o de HOJE, byte a byte. É a metade da regra que garante
// que o escopo não é uma quebra de API para quem nunca esteve num turno.
describe("sem contato do turno, nada muda", () => {
  it("a listagem segue alcançando as conversas da organização, com paginação", async () => {
    const r = await executar(["crm_list_conversations"], {});
    expect(idsDe(r)).toContain(CONVERSA_DE_B);
    expect(JSON.stringify(r)).toContain(PREVIA_DE_B);
    expect(r).toMatchObject({ cursor: "cur-2", has_more: true });
  });

  it("a conversa de qualquer contato continua abrindo", async () => {
    const r = await executar(["crm_get_conversation"], { conversation_id: CONVERSA_DE_B });
    expect(getConversationHandler).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ id: CONVERSA_DE_B, contact_id: DE_OUTRO_CLIENTE });
  });

  it("o histórico de qualquer conversa continua vindo", async () => {
    const r = await executar(["crm_get_conversation_history"], { conversation_id: CONVERSA_DE_B });
    expect(listMessagesHandler).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r)).toContain(MENSAGEM_DE_B);
  });

  it("os pedidos de qualquer contato continuam vindo", async () => {
    const r = await executar(["crm_list_contact_orders"], { contact_id: DE_OUTRO_CLIENTE });
    expect(r).toMatchObject({ pedidos: [{ id: "pp-1", tracking_code: RASTREIO_DE_B }] });
  });
});

// `crm_get_conversation` com turno: uuid inexistente (o handler responde 404,
// o mesmo de "é de outra organização") recebe a MESMA recusa da conversa de
// outro cliente. Sem turno, o 404 segue como antes.
describe("crm_get_conversation: o 404 não abre um estado distinto no turno", () => {
  const NAO_EXISTE = () => new ApiError(404, "not_found", undefined, "req-1", "Conversa não encontrada.");

  it("⭐ uuid inexistente recebe a mesma recusa da conversa de outro cliente", async () => {
    const deOutro = await executar(["crm_get_conversation"], { conversation_id: CONVERSA_DE_B }, DA_CONVERSA);
    vi.mocked(getConversationHandler).mockRejectedValue(NAO_EXISTE());
    const inexistente = await executar(
      ["crm_get_conversation"],
      { conversation_id: "aaaaaaaa-9999-4999-8999-999999999999" },
      DA_CONVERSA,
    );
    expect(deOutro).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(inexistente).toEqual(deOutro);
  });

  it("erro que não é 404 continua subindo no turno", async () => {
    vi.mocked(getConversationHandler).mockRejectedValue(
      new ApiError(500, "internal_error", undefined, "req-1", "banco caiu"),
    );
    const r = await executar(["crm_get_conversation"], { conversation_id: CONVERSA_DE_B }, DA_CONVERSA);
    expect(r).not.toMatchObject({ motivo: "fora_da_conversa" });
    expect(r).toHaveProperty("error");
  });

  it("CONTROLE: sem contato do turno, o 404 continua sendo 404", async () => {
    vi.mocked(getConversationHandler).mockRejectedValue(NAO_EXISTE());
    const r = await executar(["crm_get_conversation"], { conversation_id: CONVERSA_DE_B });
    expect(r).not.toMatchObject({ motivo: "fora_da_conversa" });
    expect(r).toHaveProperty("error");
  });
});
