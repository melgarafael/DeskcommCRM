import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

/**
 * AS LEITURAS QUE O #2182 DEIXOU DE FORA TAMBÉM FICAM ESCOPADAS AO TURNO (#2184).
 *
 * ─── O que ficou medido na issue ────────────────────────────────────────────
 * O `git grep contatoDoTurno -- lib` no head `b2914ccab` não alcançava três
 * ferramentas do pacote Atender:
 *
 *   - `crm_list_privacy_requests` (`lib/mcp/tools/privacidade.ts`) — a lista de
 *     pedidos LGPD da organização inteira, inclusive pedido de EXCLUSÃO de outro
 *     cliente, que é justamente o dado que manda "não insista com esta pessoa";
 *   - `crm_get_honorarios_contrato` e `crm_list_honorarios_parcelas`
 *     (`lib/mcp/tools/honorarios.ts`) — valor, percentual e repasse, que são
 *     contrato de um CASO (`lead_id` → `crm_leads`), e o caso tem dono em
 *     `crm_leads.contact_id`.
 *
 * E o item 3: com contato do turno, `crm_get_conversation_history` de um uuid
 * inexistente passou a responder `404` — dois estados distintos para o mesmo
 * "não é seu para ler".
 *
 * ─── A regra que os quatro casos cobrem ─────────────────────────────────────
 * LEITURA DE OBJETO (contrato, parcelas, histórico): só acontece quando o
 * objeto é provavelmente DO contato do turno. Não provado — não existe, é de
 * outra organização, é de outro contato, ou o caso nem tem contato ligado — a
 * resposta é a MESMA recusa `fora_da_conversa`, byte a byte. Um uuid não vira
 * oráculo de existência.
 *
 * LEITURA DE LISTA (pedidos de privacidade): escopo é FILTRO, na mesma regra
 * das conversas do #2182 — sem `contact_id` pedido, a consulta pergunta só
 * pelo contato do turno; o pedido EXPLÍCITO de outro cliente é que é recusado.
 *
 * Sem contato do turno — rota HTTP, MCP externo, agente sem conversa — nada
 * muda, e os controles no fim provam.
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
  getConversationHandler: vi.fn(),
}));
vi.mock("@/app/api/v1/messages/_handler", async (original) => ({
  ...(await original<typeof import("@/app/api/v1/messages/_handler")>()),
  listMessagesHandler: vi.fn(),
}));

const { getConversationHandler } = await import("@/app/api/v1/conversations/_handler");
const { listMessagesHandler } = await import("@/app/api/v1/messages/_handler");
const { auditMcpToolCall } = await import("@/lib/mcp/audit");
const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");

const ORG = "11111111-1111-4111-8111-111111111111";
/** Quem está do outro lado DO LADO DE CÁ — o contato que este turno atende. */
const DA_CONVERSA = "22222222-2222-4222-8222-222222222222";
/** Quem está do outro lado DO LADO DE LÁ — o cliente B, da mesma organização. */
const DE_OUTRO_CLIENTE = "66666666-6666-4666-8666-666666666666";
/** Um uuid que não é conversa de ninguém. */
const INEXISTENTE = "99999999-9999-4999-8999-999999999999";
const CASO_DO_TURNO = "33333333-3333-4333-8333-333333333333";
const CASO_DE_B = "44444444-4444-4444-8444-444444444444";
const CONTRATO = "55555555-5555-4555-8555-555555555555";
const FUNIL = "77777777-7777-4777-8777-777777777777";
const CONVERSA_DA_CONVERSA = "aaaaaaaa-1111-4111-8111-111111111111";
const CONVERSA_DE_B = "aaaaaaaa-2222-4222-8222-222222222222";

interface Consulta {
  tabela: string;
  filtros: Record<string, unknown>;
}

/**
 * Dublê do supabase que grava o que foi consultado e devolve por tabela —
 * o mesmo padrão de `leitura-do-turno-escopo-conversas.test.ts`.
 */
function supabaseFalso(respostas: Record<string, unknown>) {
  const consultas: Consulta[] = [];
  const from = (tabela: string) => {
    const registro: Consulta = { tabela, filtros: {} };
    consultas.push(registro);
    const cadeia: Record<string, unknown> = {};
    cadeia.select = () => cadeia;
    cadeia.eq = (coluna: string, valor: unknown) => {
      registro.filtros[coluna] = valor;
      return cadeia;
    };
    cadeia.order = () => cadeia;
    cadeia.limit = () => cadeia;
    cadeia.maybeSingle = () => Promise.resolve({ data: respostas[tabela] ?? null, error: null });
    cadeia.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: respostas[tabela] ?? [], error: null }).then(ok);
    return cadeia;
  };
  return {
    from,
    consultas,
    auth: { admin: { getUserById: () => Promise.resolve({ data: { user: null }, error: null }) } },
  };
}

let supabase = supabaseFalso({});

function montar(toolIds: string[], contatoDoTurno?: string) {
  const ator = { type: "ai_agent", id: "ag-1", role: "ai_operator" };
  return pickToolsFromMcp({
    toolIds,
    auth: {
      organizationId: ORG,
      role: "ai_operator",
      scopes: ["mcp:read", "mcp:write"],
      actor: ator,
      apiTokenId: "tok-1",
    },
    ctx: {
      organizationId: ORG,
      role: "ai_operator",
      actor: ator,
      apiTokenId: "tok-1",
      requestId: "req-1",
      supabase,
    },
    supabase,
    pipelineIds: [FUNIL],
    // As duas ferramentas de honorários declaram `modulo: "honorarios"` no
    // catálogo: com o módulo desligado elas nem chegam ao modelo. Ligar aqui é
    // montar o turno numa instalação que tem o módulo — que é o caso que a
    // issue descreve.
    modulosLigados: ["honorarios"],
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

const recusa = (r: unknown) => ({
  permitido: (r as { permitido?: unknown }).permitido,
  motivo: (r as { motivo?: unknown }).motivo,
  mensagem: (r as { mensagem?: unknown }).mensagem,
});

beforeEach(() => {
  vi.mocked(getConversationHandler).mockReset();
  vi.mocked(listMessagesHandler).mockReset().mockResolvedValue({
    messages: [{ id: "m1", body: "bom dia" }],
    cursor: null,
    has_more: false,
  } as never);
  vi.mocked(auditMcpToolCall).mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// item 1 — as três ferramentas que não liam `contatoDoTurno`
// ---------------------------------------------------------------------------

describe("crm_list_privacy_requests: os pedidos LGPD seguem o contato do turno", () => {
  const PEDIDO_DE_B = { id: "lgpd-1", contact_id: DE_OUTRO_CLIENTE, request_type: "redact" };

  it("⭐ sem `contact_id` pedido, a consulta pergunta só pelo contato do turno", async () => {
    supabase = supabaseFalso({ lgpd_requests: [PEDIDO_DE_B] });
    await executar(["crm_list_privacy_requests"], { limite: 10 }, DA_CONVERSA);
    const consulta = supabase.consultas.find((c) => c.tabela === "lgpd_requests");
    expect(consulta?.filtros["contact_id"]).toBe(DA_CONVERSA);
    // E continua filtrando a organização: o escopo compõe, não substitui.
    expect(consulta?.filtros["organization_id"]).toBe(ORG);
  });

  it("o pedido EXPLÍCITO de outro cliente é recusado, e a consulta não roda", async () => {
    supabase = supabaseFalso({ lgpd_requests: [PEDIDO_DE_B] });
    const r = await executar(
      ["crm_list_privacy_requests"],
      { limite: 10, contact_id: DE_OUTRO_CLIENTE },
      DA_CONVERSA,
    );
    expect(recusa(r)).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(supabase.consultas.some((c) => c.tabela === "lgpd_requests")).toBe(false);
  });

  it("o pedido EXPLÍCITO do próprio contato do turno segue", async () => {
    supabase = supabaseFalso({ lgpd_requests: [] });
    const r = await executar(
      ["crm_list_privacy_requests"],
      { limite: 10, contact_id: DA_CONVERSA },
      DA_CONVERSA,
    );
    expect(r).not.toHaveProperty("permitido", false);
    expect(supabase.consultas.find((c) => c.tabela === "lgpd_requests")?.filtros["contact_id"]).toBe(
      DA_CONVERSA,
    );
  });
});

describe("crm_get_honorarios_contrato: o contrato é do caso, e o caso tem dono", () => {
  const CONTRATO_DE_B = { id: CONTRATO, modelo: "exito", percentual_exito: 20 };

  it("⭐ com turno, o caso de OUTRO cliente é recusado ANTES do contrato ser lido", async () => {
    supabase = supabaseFalso({ crm_leads: { id: CASO_DE_B, contact_id: DE_OUTRO_CLIENTE } });
    const r = await executar(["crm_get_honorarios_contrato"], { lead_id: CASO_DE_B }, DA_CONVERSA);
    expect(recusa(r)).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    // O contrato não foi lido — recusa ANTES da consulta, como no #2178.
    expect(supabase.consultas.some((c) => c.tabela === "honorarios_contratos")).toBe(false);
  });

  it("⭐ caso INEXISTENTE recebe a MESMA recusa — o uuid não vira oráculo", async () => {
    supabase = supabaseFalso({ crm_leads: null });
    const r = await executar(["crm_get_honorarios_contrato"], { lead_id: INEXISTENTE }, DA_CONVERSA);
    expect(recusa(r)).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(supabase.consultas.some((c) => c.tabela === "honorarios_contratos")).toBe(false);
  });

  it("as duas respostas são idênticas byte a byte (não existe × é de outro cliente)", async () => {
    supabase = supabaseFalso({ crm_leads: { id: CASO_DE_B, contact_id: DE_OUTRO_CLIENTE } });
    const deOutro = await executar(
      ["crm_get_honorarios_contrato"],
      { lead_id: CASO_DE_B },
      DA_CONVERSA,
    );
    supabase = supabaseFalso({ crm_leads: null });
    const inexistente = await executar(
      ["crm_get_honorarios_contrato"],
      { lead_id: INEXISTENTE },
      DA_CONVERSA,
    );
    expect(JSON.stringify(inexistente)).toBe(JSON.stringify(deOutro));
  });

  it("o caso DO contato do turno continua vindo com o contrato", async () => {
    supabase = supabaseFalso({
      crm_leads: { id: CASO_DO_TURNO, contact_id: DA_CONVERSA },
      honorarios_contratos: CONTRATO_DE_B,
    });
    const r = await executar(["crm_get_honorarios_contrato"], { lead_id: CASO_DO_TURNO }, DA_CONVERSA);
    expect(r).toMatchObject({ contrato: CONTRATO_DE_B });
  });

  it("CONTROLE: sem contato do turno, o caso não é conferido e nada muda", async () => {
    supabase = supabaseFalso({
      crm_leads: { id: CASO_DE_B, contact_id: DE_OUTRO_CLIENTE },
      honorarios_contratos: CONTRATO_DE_B,
    });
    const r = await executar(["crm_get_honorarios_contrato"], { lead_id: CASO_DE_B });
    expect(supabase.consultas.some((c) => c.tabela === "crm_leads")).toBe(false);
    expect(r).toMatchObject({ contrato: CONTRATO_DE_B });
  });
});

describe("crm_list_honorarios_parcelas: a parcela é do contrato, o contrato é do caso", () => {
  const PARCELAS = [{ id: "par-1", numero: 1, status: "pendente" }];

  it("⭐ com turno, contrato cujo caso é de OUTRO cliente é recusado e as parcelas não saem", async () => {
    supabase = supabaseFalso({
      honorarios_contratos: { id: CONTRATO, lead_id: CASO_DE_B },
      crm_leads: { id: CASO_DE_B, contact_id: DE_OUTRO_CLIENTE },
      honorarios_parcelas: PARCELAS,
    });
    const r = await executar(["crm_list_honorarios_parcelas"], { contrato_id: CONTRATO }, DA_CONVERSA);
    expect(recusa(r)).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(supabase.consultas.some((c) => c.tabela === "honorarios_parcelas")).toBe(false);
  });

  it("⭐ contrato INEXISTENTE recebe a MESMA recusa", async () => {
    supabase = supabaseFalso({ honorarios_contratos: null, honorarios_parcelas: PARCELAS });
    const r = await executar(["crm_list_honorarios_parcelas"], { contrato_id: INEXISTENTE }, DA_CONVERSA);
    expect(recusa(r)).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(supabase.consultas.some((c) => c.tabela === "honorarios_parcelas")).toBe(false);
  });

  it("as duas respostas são idênticas byte a byte (não existe × é de outro cliente)", async () => {
    supabase = supabaseFalso({
      honorarios_contratos: { id: CONTRATO, lead_id: CASO_DE_B },
      crm_leads: { id: CASO_DE_B, contact_id: DE_OUTRO_CLIENTE },
    });
    const deOutro = await executar(["crm_list_honorarios_parcelas"], { contrato_id: CONTRATO }, DA_CONVERSA);
    supabase = supabaseFalso({ honorarios_contratos: null });
    const inexistente = await executar(
      ["crm_list_honorarios_parcelas"],
      { contrato_id: INEXISTENTE },
      DA_CONVERSA,
    );
    expect(JSON.stringify(inexistente)).toBe(JSON.stringify(deOutro));
  });

  it("o contrato DO contato do turno continua listando as parcelas", async () => {
    supabase = supabaseFalso({
      honorarios_contratos: { id: CONTRATO, lead_id: CASO_DO_TURNO },
      crm_leads: { id: CASO_DO_TURNO, contact_id: DA_CONVERSA },
      honorarios_parcelas: PARCELAS,
    });
    const r = await executar(["crm_list_honorarios_parcelas"], { contrato_id: CONTRATO }, DA_CONVERSA);
    expect(r).toMatchObject({ parcelas: PARCELAS });
  });

  it("CONTROLE: sem contato do turno, contrato e caso não são conferidos", async () => {
    supabase = supabaseFalso({ honorarios_parcelas: PARCELAS });
    const r = await executar(["crm_list_honorarios_parcelas"], { contrato_id: CONTRATO });
    expect(supabase.consultas.some((c) => c.tabela === "honorarios_contratos")).toBe(false);
    expect(supabase.consultas.some((c) => c.tabela === "crm_leads")).toBe(false);
    expect(r).toMatchObject({ parcelas: PARCELAS });
  });
});

// ---------------------------------------------------------------------------
// item 3 — o `404` do histórico não pode virar oráculo de existência
// ---------------------------------------------------------------------------

describe("crm_get_conversation_history: o 404 não abre dois estados distintos", () => {
  const NAOMEXISTE = new ApiError(404, "not_found", undefined, "req-1", "Conversa não encontrada.");

  it("⭐ uuid INEXISTENTE é recusado como recusa, e não como 404", async () => {
    supabase = supabaseFalso({});
    vi.mocked(getConversationHandler).mockRejectedValue(NAOMEXISTE);
    const r = await executar(
      ["crm_get_conversation_history"],
      { conversation_id: INEXISTENTE },
      DA_CONVERSA,
    );
    expect(recusa(r)).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(listMessagesHandler).not.toHaveBeenCalled();
  });

  it("as respostas de uuid inexistente e de conversa de OUTRO cliente são idênticas", async () => {
    supabase = supabaseFalso({});
    vi.mocked(getConversationHandler).mockRejectedValue(NAOMEXISTE);
    const inexistente = await executar(
      ["crm_get_conversation_history"],
      { conversation_id: INEXISTENTE },
      DA_CONVERSA,
    );

    vi.mocked(getConversationHandler).mockResolvedValue({
      id: CONVERSA_DE_B,
      contact_id: DE_OUTRO_CLIENTE,
    } as never);
    const deOutro = await executar(
      ["crm_get_conversation_history"],
      { conversation_id: CONVERSA_DE_B },
      DA_CONVERSA,
    );

    expect(JSON.stringify(inexistente)).toBe(JSON.stringify(deOutro));
  });

  it("a conversa DO contato do turno continua vindo", async () => {
    supabase = supabaseFalso({});
    vi.mocked(getConversationHandler).mockResolvedValue({
      id: CONVERSA_DA_CONVERSA,
      contact_id: DA_CONVERSA,
    } as never);
    const r = await executar(
      ["crm_get_conversation_history"],
      { conversation_id: CONVERSA_DA_CONVERSA },
      DA_CONVERSA,
    );
    expect(listMessagesHandler).toHaveBeenCalledTimes(1);
    expect((r as { messages?: unknown[] }).messages).toHaveLength(1);
  });

  it("CONTROLE: sem contato do turno, o uuid inexistente continua respondendo lista vazia", async () => {
    // O contrato do handler não muda: quem não tem contato do turno (rota HTTP,
    // MCP externo) não passa pela conferência, e `listMessagesHandler` devolve
    // a página vazia de sempre.
    supabase = supabaseFalso({});
    const r = await executar(["crm_get_conversation_history"], { conversation_id: INEXISTENTE });
    expect(getConversationHandler).not.toHaveBeenCalled();
    expect(recusa(r)).not.toMatchObject({ motivo: "fora_da_conversa" });
    expect(listMessagesHandler).toHaveBeenCalledTimes(1);
  });
});
