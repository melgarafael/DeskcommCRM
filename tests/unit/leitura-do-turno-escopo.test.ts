import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A LEITURA DE CONTATO NA CONVERSA TAMBÉM FICA ESCOPADA AO CONTATO DO TURNO (#2158).
 *
 * O executor sabe quem é o contato da conversa (`contatoDoTurno`) e já usa isso
 * para impedir que a ESCRITA de um agente caia na ficha de outro cliente. A
 * LEITURA ficou fora — e no pacote `atender` são as leituras que devolvem
 * telefone e e-mail: `crm_search_contacts` é texto livre sobre a base INTEIRA da
 * organização, e `crm_get_contact` abre a ficha de qualquer uuid da empresa.
 *
 * O dano da leitura é diferente do da escrita: a escrita suja um cadastro que dá
 * para corrigir; a leitura SAI DO PRÁDIO — vai para o WhatsApp de quem está do
 * outro lado, encaminhável, sem volta. Pela LGPD os dois são incidente, mas só
 * um deles dá para desfazer.
 *
 * A asserção é sobre a CADEIA: monta a ferramenta como o turno monta
 * (`pickToolsFromMcp`) com `contatoDoTurno` presente e lê o que o handler
 * devolveu — ou a recusa que voltou ao modelo.
 *
 * O GATILHO É `contatoDoTurno`, e não o pacote: o ponto da trava recebe
 * `toolIds` achatados por versão (`ai_agent_versions.tool_ids` é snapshot — nada
 * o re-deriva), e `crm_search_contacts` serve OS DOIS pacotes (`atender` e
 * `vender`), então "qual pacote está em uso" não é distinguível ali. Quem não
 * tem contato do turno — rota HTTP, MCP externo, agente sem conversa — segue
 * exatamente como antes, e os controles no fim provam isso. O Operador NÃO está
 * nesse grupo: o turno dele também recebe `contactId` (`operator-turn.ts`).
 */

vi.mock("@/app/api/v1/contacts/_handler", async (original) => ({
  ...(await original<typeof import("@/app/api/v1/contacts/_handler")>()),
  listContactsHandler: vi.fn(),
  getContactHandler: vi.fn(),
}));
vi.mock("@/app/api/v1/leads/_handler", async (original) => ({
  ...(await original<typeof import("@/app/api/v1/leads/_handler")>()),
  updateLeadHandler: vi.fn(),
}));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));

const { listContactsHandler, getContactHandler } = await import("@/app/api/v1/contacts/_handler");
const { auditMcpToolCall } = await import("@/lib/mcp/audit");
const { updateLeadHandler } = await import("@/app/api/v1/leads/_handler");
const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");

const ORG = "11111111-1111-4111-8111-111111111111";
/** Quem está do outro lado DO LADO DE CÁ — o contato que este turno atende. */
const DA_CONVERSA = "22222222-2222-4222-8222-222222222222";
/** Quem está do outro lado DO LADO DE LÁ — o cliente B, que a busca acha. */
const DE_OUTRO_CLIENTE = "66666666-6666-4666-8666-666666666666";
const NEGOCIO_DE_OUTRO = "55555555-5555-4555-8555-555555555555";
const NEGOCIO_DA_CONVERSA = "33333333-3333-4333-8333-333333333333";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const TELEFONE_DE_B = "(11) 98888-7777";
const EMAIL_DE_B = "maria.souza@exemplo.com";

function contato(id: string, nome: string, telefone: string | null, email: string | null) {
  return {
    id,
    name: nome,
    display_name: null,
    email,
    phone_number: telefone,
    tags: [],
    is_blocked: false,
    is_anonymized: false,
    created_at: "2026-09-24T02:18:00.000Z",
    last_activity_at: "2026-09-24T02:38:00.000Z",
  };
}

function montar(toolIds: string[], contatoDoTurno?: string) {
  const ator = { type: "ai_agent", id: "ag-1", role: "ai_operator" };
  const supabase = { from: () => ({}) };
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

/** Varredura da ORGANIZAÇÃO: a busca devolve os dois — é o defeito em forma de retorno. */
function buscaOrg() {
  return {
    contacts: [
      contato(DE_OUTRO_CLIENTE, "Maria Souza", TELEFONE_DE_B, EMAIL_DE_B),
      contato(DA_CONVERSA, "João Pereira", "(11) 97777-6666", "joao@exemplo.com"),
    ],
    cursor: "cur-2",
    has_more: true,
  };
}

const idsDe = (r: unknown) =>
  ((r as { contacts?: Array<{ id: string }> }).contacts ?? []).map((c) => c.id);

beforeEach(() => {
  vi.mocked(listContactsHandler).mockReset().mockResolvedValue(buscaOrg() as never);
  vi.mocked(getContactHandler)
    .mockReset()
    .mockResolvedValue({
      id: DE_OUTRO_CLIENTE,
      name: "Maria Souza",
      display_name: null,
      email: EMAIL_DE_B,
      phone_number: TELEFONE_DE_B,
      tags: [],
      source: "manual",
      consent: {},
      is_blocked: false,
      is_anonymized: false,
      cpf_available: false,
      created_at: "2026-09-24T02:18:00.000Z",
      last_activity_at: "2026-09-24T02:38:00.000Z",
    } as never);
  vi.mocked(updateLeadHandler).mockReset().mockResolvedValue({ id: NEGOCIO_DA_CONVERSA } as never);
});

describe("na conversa, a leitura de contato só alcança o contato do turno", () => {
  // O caso da issue: conversa com A, busca por texto de B, telefone de B na
  // resposta. Antes da mudança a resposta traz o telefone inteiro.
  it("busca por texto de OUTRO cliente não devolve o telefone do cliente B", async () => {
    const r = await executar(["crm_search_contacts"], { query: "Maria" }, DA_CONVERSA);
    expect(idsDe(r)).not.toContain(DE_OUTRO_CLIENTE);
    expect(JSON.stringify(r)).not.toContain(TELEFONE_DE_B);
    expect(JSON.stringify(r)).not.toContain(EMAIL_DE_B);
  });

  it("o contato DA conversa continua na resposta — a ferramenta segue servindo ao propósito dela", async () => {
    const r = await executar(["crm_search_contacts"], { query: "João Pereira" }, DA_CONVERSA);
    expect(idsDe(r)).toEqual([DA_CONVERSA]);
  });

  // Escopo, não tradução: a paginação é da varredura da ORGANIZAÇÃO, e a
  // próxima página voltaria a ser varredura.
  it("busca que só acha outro cliente volta vazia, sem cursor para a varredura da organização", async () => {
    vi.mocked(listContactsHandler).mockResolvedValue({
      contacts: [contato(DE_OUTRO_CLIENTE, "Maria Souza", TELEFONE_DE_B, EMAIL_DE_B)],
      cursor: "cur-9",
      has_more: true,
    } as never);
    const r = await executar(["crm_search_contacts"], { query: "Maria" }, DA_CONVERSA);
    expect(r).toMatchObject({ contacts: [], cursor: null, has_more: false });
  });

  it("ficha de OUTRO cliente é recusada com motivo em texto, e o handler não é chamado", async () => {
    const r = await executar(["crm_get_contact"], { contact_id: DE_OUTRO_CLIENTE }, DA_CONVERSA);
    expect(getContactHandler).not.toHaveBeenCalled();
    expect(r).toMatchObject({ permitido: false });
    const motivo = (r as { motivo?: unknown }).motivo;
    const mensagem = (r as { mensagem?: unknown }).mensagem;
    expect(typeof motivo).toBe("string");
    expect(typeof mensagem).toBe("string");
    expect((mensagem as string).length).toBeGreaterThan(20);
    expect(JSON.stringify(r)).not.toContain(TELEFONE_DE_B);
  });

  // A recusa entra no audit como recusa, igual à de escrita — `success: true`
  // contaria como acerto uma ficha que o agente NÃO pôde abrir.
  it("ficha recusada é auditada como recusa, com o motivo", async () => {
    vi.mocked(auditMcpToolCall).mockClear();
    await executar(["crm_get_contact"], { contact_id: DE_OUTRO_CLIENTE }, DA_CONVERSA);
    expect(auditMcpToolCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(auditMcpToolCall).mock.calls[0]![0]).toMatchObject({
      toolName: "crm_get_contact",
      success: false,
      errorMessage: "contato_da_conversa:fora_da_conversa",
    });
  });

  it("ficha do contato DA conversa abre — não é a ferramenta que quebra, é o escopo", async () => {
    vi.mocked(getContactHandler).mockResolvedValue({
      id: DA_CONVERSA,
      name: "João Pereira",
      display_name: null,
      email: "joao@exemplo.com",
      phone_number: "(11) 97777-6666",
      tags: [],
      source: "manual",
      consent: {},
      is_blocked: false,
      is_anonymized: false,
      cpf_available: false,
      created_at: "2026-09-24T02:18:00.000Z",
      last_activity_at: "2026-09-24T02:38:00.000Z",
    } as never);
    const r = await executar(["crm_get_contact"], { contact_id: DA_CONVERSA }, DA_CONVERSA);
    expect(getContactHandler).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ id: DA_CONVERSA });
  });
});

// Controle 1: sem contato do turno — rota HTTP, MCP externo, agente sem
// conversa — o comportamento é o de HOJE, byte a byte.
describe("sem contato do turno, nada muda", () => {
  it("a busca segue alcançando a base da organização, com paginação", async () => {
    const r = await executar(["crm_search_contacts"], { query: "Maria" });
    expect(idsDe(r)).toContain(DE_OUTRO_CLIENTE);
    expect(JSON.stringify(r)).toContain(TELEFONE_DE_B);
    expect(r).toMatchObject({ cursor: "cur-2", has_more: true });
  });

  it("a ficha de qualquer contato continua abrindo", async () => {
    const r = await executar(["crm_get_contact"], { contact_id: DE_OUTRO_CLIENTE });
    expect(getContactHandler).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ id: DE_OUTRO_CLIENTE, phone: TELEFONE_DE_B });
  });
});

// Controle 2: a proteção de ESCRITA (#1758) continua funcionando — esta mudança
// não toca em `negocioDaEscritaDoTurno`.
describe("a escrita continua mirando só o negócio do contato da conversa", () => {
  type Negocio = { id: string; status: string };

  /** `crm_leads` responde por CONTATO (a conferência) e por ID (o escopo). */
  function banco(doContato: Negocio[]) {
    return {
      from() {
        const filtros: Record<string, unknown> = {};
        const q = {
          select: () => q,
          eq: (coluna: string, valor: unknown) => {
            filtros[coluna] = valor;
            return q;
          },
          maybeSingle: async () => ({ data: { pipeline_id: FUNIL }, error: null }),
          then: (ok: (r: unknown) => unknown) =>
            ok({ data: filtros.contact_id === DA_CONVERSA ? doContato : [], error: null }),
        };
        return q;
      },
    };
  }

  async function escrever(supabase: unknown, leadId: string) {
    const ator = { type: "ai_agent", id: "ag-1", role: "ai_operator" };
    const tools = pickToolsFromMcp({
      toolIds: ["crm_update_lead"],
      auth: { organizationId: ORG, role: "ai_operator", scopes: ["mcp:read", "mcp:write"], actor: ator, apiTokenId: "tok-1" },
      ctx: { organizationId: ORG, role: "ai_operator", actor: ator, apiTokenId: "tok-1", requestId: "req-1", supabase },
      supabase,
      pipelineIds: [FUNIL],
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
      contatoDoTurno: DA_CONVERSA,
    } as never);
    return tools.crm_update_lead!.execute!(
      { lead_id: leadId, value_cents: 12_500_000 },
      { toolCallId: "c1", messages: [] } as never,
    );
  }

  it("escrita com lead que não é deste contato e este contato sem negócio: recusa, sem chegar ao handler", async () => {
    const r = await escrever(banco([]), NEGOCIO_DE_OUTRO);
    expect(updateLeadHandler).not.toHaveBeenCalled();
    expect(r).toMatchObject({ permitido: false, motivo: "sem_negocio" });
  });

  it("lead de OUTRO cliente num contato com um negócio aberto: trocado pelo negócio DESTE contato", async () => {
    const r = await escrever(banco([{ id: NEGOCIO_DA_CONVERSA, status: "open" }]), NEGOCIO_DE_OUTRO);
    expect(vi.mocked(updateLeadHandler).mock.calls[0]![2]).toBe(NEGOCIO_DA_CONVERSA);
    expect(r).toMatchObject({ lead: { id: NEGOCIO_DA_CONVERSA } });
  });

  it("lead_id que é o contato do turno ainda vira o negócio aberto dele", async () => {
    const r = await escrever(banco([{ id: NEGOCIO_DA_CONVERSA, status: "open" }]), DA_CONVERSA);
    expect(vi.mocked(updateLeadHandler).mock.calls[0]![2]).toBe(NEGOCIO_DA_CONVERSA);
    expect(r).toMatchObject({ lead: { id: NEGOCIO_DA_CONVERSA } });
  });
});
