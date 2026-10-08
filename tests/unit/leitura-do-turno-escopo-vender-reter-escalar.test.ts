import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS LEITURAS DOS PACOTES VENDER, RETER E ESCALAR SEGUEM O CONTATO DO TURNO.
 *
 * Mesma regra de `leitura-do-turno-escopo-restante.test.ts` (#2184), agora nas
 * leituras de negócio, agenda, retorno, radar e casos humanos:
 *
 * - LISTA: o contato do turno vai NA CONSULTA, antes do limite — filtrar a
 *   página depois esconderia o próprio cliente; o pedido explícito de outro
 *   cliente é recusado com `fora_da_conversa`.
 * - LEITURA POR ID: a MESMA recusa, byte a byte, para "não existe" e para "é
 *   de outro cliente" — um uuid não vira oráculo de existência.
 *
 * Sem contato do turno — rota HTTP, MCP externo, pessoa — nada muda, e cada
 * bloco termina com esse controle.
 *
 * A asserção é sobre a CADEIA: monta a ferramenta como o turno monta
 * (`pickToolsFromMcp`) e lê o que voltou ao modelo. O dublê do banco APLICA os
 * filtros de igualdade e o limite, então "filtrou antes do limite" é medido
 * pelo resultado, e não pela presença de uma cláusula.
 */

vi.mock("@/lib/audit", () => ({
  audit: vi.fn().mockResolvedValue(undefined),
  isServiceRoleConfigured: () => false,
}));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/agenda/consulta", async (original) => ({
  ...(await original<typeof import("@/lib/agenda/consulta")>()),
  listaAgendamentos: vi.fn(),
}));
vi.mock("@/lib/followup/retorno-crm", async (original) => ({
  ...(await original<typeof import("@/lib/followup/retorno-crm")>()),
  listaRetornosNoCrm: vi.fn(),
}));
vi.mock("@/lib/escalacao/continuidade", () => ({
  lerContinuidadeHumana: vi.fn().mockResolvedValue({
    houveAtendimentoHumano: false,
    resumo: null,
    pendenciaComOCliente: null,
    decisoes: [],
  }),
}));

const { listaAgendamentos } = await import("@/lib/agenda/consulta");
const { listaRetornosNoCrm } = await import("@/lib/followup/retorno-crm");
const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");

const ORG = "11111111-1111-4111-8111-111111111111";
const DA_CONVERSA = "22222222-2222-4222-8222-222222222222";
const DE_OUTRO_CLIENTE = "66666666-6666-4666-8666-666666666666";
const INEXISTENTE = "99999999-9999-4999-8999-999999999999";
const NEGOCIO_DO_TURNO = "33333333-3333-4333-8333-333333333333";
const NEGOCIO_DE_B = "44444444-4444-4444-8444-444444444444";
const NEGOCIO_DE_B_2 = "45444444-4444-4444-8444-444444444444";
const FUNIL = "77777777-7777-4777-8777-777777777777";
const CONVERSA_DO_TURNO = "aaaaaaaa-1111-4111-8111-111111111111";
const CONVERSA_DE_B = "aaaaaaaa-2222-4222-8222-222222222222";
const CASO_DO_TURNO = "bbbbbbbb-1111-4111-8111-111111111111";
const CASO_DE_B = "bbbbbbbb-2222-4222-8222-222222222222";

type Linha = Record<string, unknown>;
interface Consulta {
  tabela: string;
  filtros: Record<string, unknown>;
}

/**
 * Dublê do supabase que APLICA `eq`/`in`/`is` e `limit` sobre as linhas da
 * tabela, na ordem em que foram dadas; o resto da cadeia (`order`, `or`,
 * `not`, `gt`…) só passa adiante.
 */
function bancoFalso(tabelas: Record<string, Linha[]>) {
  const consultas: Consulta[] = [];
  const from = (tabela: string) => {
    const registro: Consulta = { tabela, filtros: {} };
    consultas.push(registro);
    let linhas = [...(tabelas[tabela] ?? [])];
    let limite: number | undefined;
    let soContagem = false;
    const resposta = () => ({
      data: soContagem ? null : linhas.slice(0, limite),
      count: linhas.length,
      error: null,
    });
    const alvo: Record<string, unknown> = {
      select: (_c?: string, o?: { head?: boolean }) => {
        if (o?.head) soContagem = true;
        return cadeia;
      },
      eq: (coluna: string, valor: unknown) => {
        registro.filtros[coluna] = valor;
        linhas = linhas.filter((l) => l[coluna] === valor);
        return cadeia;
      },
      in: (coluna: string, valores: unknown[]) => {
        linhas = linhas.filter((l) => valores.includes(l[coluna]));
        return cadeia;
      },
      is: (coluna: string, valor: unknown) => {
        linhas = linhas.filter((l) => (l[coluna] ?? null) === valor);
        return cadeia;
      },
      limit: (n: number) => {
        limite = n;
        return cadeia;
      },
      maybeSingle: () => Promise.resolve({ data: linhas[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: linhas[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve(resposta()).then(ok, falha),
    };
    const cadeia: unknown = new Proxy(alvo, {
      get: (t, p: string) => (p in t ? t[p] : () => cadeia),
    });
    return cadeia;
  };
  return {
    from,
    consultas,
    auth: { admin: { getUserById: () => Promise.resolve({ data: { user: null }, error: null }) } },
  };
}

let supabase = bancoFalso({});

async function executar(nome: string, args: Record<string, unknown>, contatoDoTurno?: string) {
  const ator = { type: "ai_agent", id: "ag-1", role: "ai_operator" };
  const ferramentas = pickToolsFromMcp({
    toolIds: [nome],
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
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    ...(contatoDoTurno ? { contatoDoTurno } : {}),
  } as never);
  return (await ferramentas[nome]!.execute!(args, { toolCallId: "c1", messages: [] } as never)) as Record<
    string,
    unknown
  >;
}

const recusa = (r: unknown) => ({
  permitido: (r as { permitido?: unknown }).permitido,
  motivo: (r as { motivo?: unknown }).motivo,
});

const negocio = (id: string, contato: string | null, over: Linha = {}): Linha => ({
  id,
  organization_id: ORG,
  contact_id: contato,
  title: `negócio ${id.slice(0, 4)}`,
  status: "open",
  pipeline_id: FUNIL,
  stage_id: null,
  owner_user_id: null,
  owner_agent_id: null,
  last_activity_at: "2020-01-01T00:00:00Z",
  created_at: "2020-01-01T00:00:00Z",
  ...over,
});

beforeEach(() => {
  vi.mocked(listaAgendamentos)
    .mockReset()
    .mockResolvedValue({ ok: true, agendamentos: [], proximo: null } as never);
  vi.mocked(listaRetornosNoCrm)
    .mockReset()
    .mockResolvedValue({ ok: true, alvo: { contactId: DA_CONVERSA, leadId: null }, retornos: [] } as never);
});

// ---------------------------------------------------------------------------
// vender
// ---------------------------------------------------------------------------

describe("crm_list_leads: só os negócios do contato do turno, filtrados antes do limite", () => {
  // Os negócios de B vêm PRIMEIRO: um filtro depois do limite devolveria a
  // página de B e esconderia o do turno.
  const tabelas = () => ({
    crm_leads: [negocio(NEGOCIO_DE_B, DE_OUTRO_CLIENTE), negocio(NEGOCIO_DE_B_2, DE_OUTRO_CLIENTE), negocio(NEGOCIO_DO_TURNO, DA_CONVERSA)],
  });

  it("⭐ com turno, nenhum negócio de outro cliente sai, e o do turno sai mesmo com limite 1", async () => {
    supabase = bancoFalso(tabelas());
    const r = await executar("crm_list_leads", { limit: 1 }, DA_CONVERSA);
    const leads = r.leads as Linha[];
    expect(leads.map((l) => l.id)).toEqual([NEGOCIO_DO_TURNO]);
  });

  it("CONTROLE: sem turno, a listagem da organização segue como antes", async () => {
    supabase = bancoFalso(tabelas());
    const r = await executar("crm_list_leads", { limit: 5 });
    expect((r.leads as Linha[]).map((l) => l.id)).toContain(NEGOCIO_DE_B);
  });
});

describe("crm_get_lead: uma recusa só para outro cliente e para inexistente", () => {
  const tabelas = () => ({
    crm_leads: [negocio(NEGOCIO_DE_B, DE_OUTRO_CLIENTE), negocio(NEGOCIO_DO_TURNO, DA_CONVERSA)],
  });

  it("⭐ negócio de outro cliente é recusado, e nada dele sai", async () => {
    supabase = bancoFalso(tabelas());
    const r = await executar("crm_get_lead", { lead_id: NEGOCIO_DE_B }, DA_CONVERSA);
    expect(recusa(r)).toEqual({ permitido: false, motivo: "fora_da_conversa" });
    expect(JSON.stringify(r)).not.toContain(DE_OUTRO_CLIENTE);
  });

  it("⭐ inexistente e de outro cliente dão a MESMA resposta, byte a byte", async () => {
    supabase = bancoFalso(tabelas());
    const deOutro = await executar("crm_get_lead", { lead_id: NEGOCIO_DE_B }, DA_CONVERSA);
    const inexistente = await executar("crm_get_lead", { lead_id: INEXISTENTE }, DA_CONVERSA);
    expect(JSON.stringify(inexistente)).toBe(JSON.stringify(deOutro));
  });

  it("o negócio do contato do turno abre", async () => {
    supabase = bancoFalso(tabelas());
    const r = await executar("crm_get_lead", { lead_id: NEGOCIO_DO_TURNO }, DA_CONVERSA);
    expect((r.lead as Linha).id).toBe(NEGOCIO_DO_TURNO);
  });

  it("CONTROLE: sem turno, qualquer negócio da organização abre", async () => {
    supabase = bancoFalso(tabelas());
    const r = await executar("crm_get_lead", { lead_id: NEGOCIO_DE_B });
    expect((r.lead as Linha).id).toBe(NEGOCIO_DE_B);
  });
});

describe("crm_list_appointments: a agenda, no turno, é a do contato da conversa", () => {
  const tabelas = () => ({
    crm_leads: [negocio(NEGOCIO_DE_B, DE_OUTRO_CLIENTE), negocio(NEGOCIO_DO_TURNO, DA_CONVERSA)],
  });
  const PERIODO = { de: "2026-10-01T00:00:00-03:00", ate: "2026-10-08T00:00:00-03:00" };

  it("⭐ o período da organização inteira vira o período do contato do turno", async () => {
    supabase = bancoFalso(tabelas());
    await executar("crm_list_appointments", PERIODO, DA_CONVERSA);
    expect(vi.mocked(listaAgendamentos).mock.calls[0]![2]).toMatchObject({ contactId: DA_CONVERSA });
  });

  it("⭐ contact_id de outro cliente é recusado e a agenda não é lida", async () => {
    supabase = bancoFalso(tabelas());
    const r = await executar("crm_list_appointments", { contact_id: DE_OUTRO_CLIENTE }, DA_CONVERSA);
    expect(recusa(r)).toEqual({ permitido: false, motivo: "fora_da_conversa" });
    expect(listaAgendamentos).not.toHaveBeenCalled();
  });

  it("⭐ lead_id de outro cliente e lead_id inexistente: a MESMA recusa", async () => {
    supabase = bancoFalso(tabelas());
    const deOutro = await executar("crm_list_appointments", { lead_id: NEGOCIO_DE_B }, DA_CONVERSA);
    const inexistente = await executar("crm_list_appointments", { lead_id: INEXISTENTE }, DA_CONVERSA);
    expect(recusa(deOutro)).toEqual({ permitido: false, motivo: "fora_da_conversa" });
    expect(JSON.stringify(inexistente)).toBe(JSON.stringify(deOutro));
    expect(listaAgendamentos).not.toHaveBeenCalled();
  });

  it("o negócio do contato do turno lista, dentro do contato", async () => {
    supabase = bancoFalso(tabelas());
    await executar("crm_list_appointments", { lead_id: NEGOCIO_DO_TURNO }, DA_CONVERSA);
    expect(vi.mocked(listaAgendamentos).mock.calls[0]![2]).toMatchObject({
      contactId: DA_CONVERSA,
      leadId: NEGOCIO_DO_TURNO,
    });
  });

  it("CONTROLE: sem turno, o período cobre a organização", async () => {
    supabase = bancoFalso(tabelas());
    await executar("crm_list_appointments", PERIODO);
    expect(vi.mocked(listaAgendamentos).mock.calls[0]![2]).toMatchObject({ contactId: null });
  });
});

describe("crm_search_contacts: o contato do turno é filtrado ANTES da página", () => {
  const contato = (id: string, nome: string): Linha => ({
    id,
    organization_id: ORG,
    kind: "person",
    is_merged_into: null,
    is_personal: false,
    name: nome,
    phone_number: null,
    email: null,
    tags: [],
  });
  // Outro cliente que casa com o termo vem primeiro: com a página cortada
  // antes do filtro, a resposta voltava vazia.
  const tabelas = () => ({
    contacts: [contato(DE_OUTRO_CLIENTE, "Maria B"), contato(DA_CONVERSA, "Maria A")],
  });

  it("⭐ com limite 1, o contato do turno vem mesmo quando outro casa antes", async () => {
    supabase = bancoFalso(tabelas());
    const r = await executar("crm_search_contacts", { query: "Maria", limit: 1 }, DA_CONVERSA);
    expect((r.contacts as Linha[]).map((c) => c.id)).toEqual([DA_CONVERSA]);
  });

  it("CONTROLE: sem turno, a busca alcança a organização", async () => {
    supabase = bancoFalso(tabelas());
    const r = await executar("crm_search_contacts", { query: "Maria", limit: 5 });
    expect((r.contacts as Linha[]).map((c) => c.id)).toEqual([DE_OUTRO_CLIENTE, DA_CONVERSA]);
  });
});

// ---------------------------------------------------------------------------
// reter
// ---------------------------------------------------------------------------

describe("crm_list_followups: os retornos, no turno, são os do contato da conversa", () => {
  const tabelas = () => ({
    crm_leads: [negocio(NEGOCIO_DE_B, DE_OUTRO_CLIENTE), negocio(NEGOCIO_DO_TURNO, DA_CONVERSA)],
  });

  it("⭐ sem alvo, usa o contato do turno", async () => {
    supabase = bancoFalso(tabelas());
    await executar("crm_list_followups", {}, DA_CONVERSA);
    expect(vi.mocked(listaRetornosNoCrm).mock.calls[0]![1]).toEqual({
      leadId: null,
      contactId: DA_CONVERSA,
    });
  });

  it("⭐ contact_id de outro cliente é recusado e nada é lido", async () => {
    supabase = bancoFalso(tabelas());
    const r = await executar("crm_list_followups", { contact_id: DE_OUTRO_CLIENTE }, DA_CONVERSA);
    expect(recusa(r)).toEqual({ permitido: false, motivo: "fora_da_conversa" });
    expect(listaRetornosNoCrm).not.toHaveBeenCalled();
  });

  it("⭐ lead_id de outro cliente e lead_id inexistente: a MESMA recusa", async () => {
    supabase = bancoFalso(tabelas());
    const deOutro = await executar("crm_list_followups", { lead_id: NEGOCIO_DE_B }, DA_CONVERSA);
    const inexistente = await executar("crm_list_followups", { lead_id: INEXISTENTE }, DA_CONVERSA);
    expect(recusa(deOutro)).toEqual({ permitido: false, motivo: "fora_da_conversa" });
    expect(JSON.stringify(inexistente)).toBe(JSON.stringify(deOutro));
    expect(listaRetornosNoCrm).not.toHaveBeenCalled();
  });

  it("CONTROLE: sem turno, o alvo pedido segue como veio", async () => {
    supabase = bancoFalso(tabelas());
    await executar("crm_list_followups", { contact_id: DE_OUTRO_CLIENTE });
    expect(vi.mocked(listaRetornosNoCrm).mock.calls[0]![1]).toEqual({
      leadId: null,
      contactId: DE_OUTRO_CLIENTE,
    });
  });
});

describe("crm_list_at_risk_leads: o radar, no turno, cobre só o contato da conversa", () => {
  const PROPOSTA_DE_B = "dddddddd-2222-4222-8222-222222222222";
  const tabelas = () => ({
    crm_leads: [negocio(NEGOCIO_DE_B, DE_OUTRO_CLIENTE), negocio(NEGOCIO_DO_TURNO, DA_CONVERSA)],
    organizations: [{ id: ORG, settings: {} }],
    contacts: [
      { id: DE_OUTRO_CLIENTE, organization_id: ORG, name: "Bruno" },
      { id: DA_CONVERSA, organization_id: ORG, name: "Ana" },
    ],
    demandas: [
      {
        id: "dem-b",
        organization_id: ORG,
        lead_id: null,
        contact_id: DE_OUTRO_CLIENTE,
        aberta_em: "2020-01-01T00:00:00Z",
        origem: "whatsapp",
        fechada_em: null,
        proximo_passo: null,
        contacts: { name: "Bruno" },
      },
    ],
    crm_proposals: [
      {
        id: PROPOSTA_DE_B,
        organization_id: ORG,
        lead_id: NEGOCIO_DE_B,
        contact_id: DE_OUTRO_CLIENTE,
        titulo: "Proposta do Bruno",
        status: "rascunho",
        created_at: "2020-01-01T00:00:00Z",
      },
    ],
    agent_inbox_items: [
      { organization_id: ORG, kind: "proposta_pronta_para_revisao", status: "open", ref_id: PROPOSTA_DE_B },
    ],
  });

  it("⭐ com turno, nada de outro cliente sai — negócio, demanda ou proposta", async () => {
    supabase = bancoFalso(tabelas());
    const r = await executar("crm_list_at_risk_leads", { limit: 50 }, DA_CONVERSA);
    const texto = JSON.stringify(r);
    expect(texto).not.toContain(DE_OUTRO_CLIENTE);
    expect(texto).not.toContain("Bruno");
    expect((r.items as Linha[]).map((i) => i.lead_id ?? i.id)).toContain(NEGOCIO_DO_TURNO);
  });

  it("⭐ o contato vai NA CONSULTA das três fontes, e não depois", async () => {
    supabase = bancoFalso(tabelas());
    await executar("crm_list_at_risk_leads", { limit: 50 }, DA_CONVERSA);
    for (const tabela of ["crm_leads", "demandas", "crm_proposals"]) {
      const consulta = supabase.consultas.find(
        (c) => c.tabela === tabela && c.filtros["contact_id"] !== undefined,
      );
      expect(consulta?.filtros["contact_id"], tabela).toBe(DA_CONVERSA);
    }
  });

  it("⭐ proposta do contato do turno num negócio que passou a outro cliente não sai em revisão", async () => {
    // A proposta guarda o contato de quando foi feita; o negócio mudou de dono
    // depois. O filtro por `crm_proposals.contact_id` deixa a proposta passar,
    // e o `lead_id` dela é um negócio de outro cliente.
    const PROPOSTA_ANTIGA = "dddddddd-3333-4333-8333-333333333333";
    const t = tabelas();
    t.crm_proposals.push({
      id: PROPOSTA_ANTIGA,
      organization_id: ORG,
      lead_id: NEGOCIO_DE_B,
      contact_id: DA_CONVERSA,
      titulo: "Proposta antiga da Ana",
      status: "rascunho",
      created_at: "2020-01-02T00:00:00Z",
    });
    t.agent_inbox_items.push({
      organization_id: ORG,
      kind: "proposta_pronta_para_revisao",
      status: "open",
      ref_id: PROPOSTA_ANTIGA,
    });
    supabase = bancoFalso(t);
    const r = await executar("crm_list_at_risk_leads", { limit: 50 }, DA_CONVERSA);
    expect(r.propostas_esperando_revisao).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(NEGOCIO_DE_B);
  });

  it("CONTROLE: sem turno, o radar cobre a organização", async () => {
    supabase = bancoFalso(tabelas());
    const r = await executar("crm_list_at_risk_leads", { limit: 50 });
    expect(JSON.stringify(r)).toContain(DE_OUTRO_CLIENTE);
  });
});

// ---------------------------------------------------------------------------
// escalar
// ---------------------------------------------------------------------------

describe("crm_list_human_cases / crm_get_human_case: só os casos do contato do turno", () => {
  const caso = (id: string, conversa: string, titulo: string): Linha => ({
    id,
    organization_id: ORG,
    conversation_id: conversa,
    title: titulo,
    summary: titulo,
    blocker: "x",
    status: "awaiting_human",
    kind: "outro",
    opened_at: "2026-10-01T00:00:00Z",
  });
  const tabelas = () => ({
    conversations: [
      { id: CONVERSA_DE_B, organization_id: ORG, contact_id: DE_OUTRO_CLIENTE },
      { id: CONVERSA_DO_TURNO, organization_id: ORG, contact_id: DA_CONVERSA },
    ],
    agent_cases: [caso(CASO_DE_B, CONVERSA_DE_B, "caso do Bruno"), caso(CASO_DO_TURNO, CONVERSA_DO_TURNO, "caso da Ana")],
    agent_case_events: [],
  });

  it("⭐ a lista e o open_count são do contato do turno", async () => {
    supabase = bancoFalso(tabelas());
    const r = await executar("crm_list_human_cases", { state: "abertos", limit: 20 }, DA_CONVERSA);
    expect((r.cases as Linha[]).map((c) => c.id)).toEqual([CASO_DO_TURNO]);
    expect(r.open_count).toBe(1);
  });

  it("⭐ caso de outro cliente e caso inexistente: a MESMA recusa", async () => {
    supabase = bancoFalso(tabelas());
    const deOutro = await executar("crm_get_human_case", { case_id: CASO_DE_B }, DA_CONVERSA);
    const inexistente = await executar("crm_get_human_case", { case_id: INEXISTENTE }, DA_CONVERSA);
    expect(recusa(deOutro)).toEqual({ permitido: false, motivo: "fora_da_conversa" });
    expect(JSON.stringify(inexistente)).toBe(JSON.stringify(deOutro));
    expect(JSON.stringify(deOutro)).not.toContain("Bruno");
  });

  it("o caso do contato do turno abre", async () => {
    supabase = bancoFalso(tabelas());
    const r = await executar("crm_get_human_case", { case_id: CASO_DO_TURNO }, DA_CONVERSA);
    expect(r.id).toBe(CASO_DO_TURNO);
  });

  it("CONTROLE: sem turno, a fila inteira e qualquer caso seguem visíveis", async () => {
    supabase = bancoFalso(tabelas());
    const lista = await executar("crm_list_human_cases", { state: "abertos", limit: 20 });
    expect(lista.open_count).toBe(2);
    const umCaso = await executar("crm_get_human_case", { case_id: CASO_DE_B });
    expect(umCaso.id).toBe(CASO_DE_B);
  });
});
