/**
 * Quem é avisado de mensagem recebida — a regra proposta e a
 * precedência atendente > dono de negócio aberto > todos.
 *
 * Roda com: npx vitest run lib/notifications/destinatarios-da-mensagem.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  carregarDestinatariosDaMensagem,
  destinatariosDaMensagem,
  usuarioRecebeAviso,
  type LeitorDeAtribuicao,
} from "./destinatarios-da-mensagem";

const ADMIN = "u-admin";

describe("destinatariosDaMensagem (regra pura)", () => {
  it("sem atendente e sem negócio aberto com dono → todos", () => {
    expect(destinatariosDaMensagem({ atribuidoA: null, donosDeNegocioAberto: [], admins: [ADMIN] })).toEqual({
      tipo: "todos",
    });
  });

  it("negócio aberto SEM dono não é atribuição → todos", () => {
    expect(
      destinatariosDaMensagem({ atribuidoA: null, donosDeNegocioAberto: [null, ""], admins: [ADMIN] }),
    ).toEqual({ tipo: "todos" });
  });

  it("conversa atribuída → só o atendente e os admins", () => {
    expect(
      destinatariosDaMensagem({ atribuidoA: "u-ana", donosDeNegocioAberto: [], admins: [ADMIN, "u-admin2"] }),
    ).toEqual({ tipo: "restrito", userIds: ["u-ana", ADMIN, "u-admin2"] });
  });

  it("atendente da conversa VENCE o dono do negócio", () => {
    const d = destinatariosDaMensagem({ atribuidoA: "u-ana", donosDeNegocioAberto: ["u-bia"], admins: [ADMIN] });
    expect(d).toEqual({ tipo: "restrito", userIds: ["u-ana", ADMIN] });
  });

  it("sem atendente: donos dos negócios abertos (todos eles, sem repetição) + admins", () => {
    const d = destinatariosDaMensagem({
      atribuidoA: null,
      donosDeNegocioAberto: ["u-bia", null, "u-caio", "u-bia"],
      admins: [ADMIN],
    });
    expect(d).toEqual({ tipo: "restrito", userIds: ["u-bia", "u-caio", ADMIN] });
  });

  it("atendente que também é admin não aparece duas vezes", () => {
    const d = destinatariosDaMensagem({ atribuidoA: ADMIN, donosDeNegocioAberto: [], admins: [ADMIN] });
    expect(d).toEqual({ tipo: "restrito", userIds: [ADMIN] });
  });

  it("usuarioRecebeAviso: todos avisa qualquer um; restrito só a lista", () => {
    expect(usuarioRecebeAviso({ tipo: "todos" }, "u-qualquer")).toBe(true);
    const r = { tipo: "restrito" as const, userIds: ["u-ana", ADMIN] };
    expect(usuarioRecebeAviso(r, "u-ana")).toBe(true);
    expect(usuarioRecebeAviso(r, ADMIN)).toBe(true);
    expect(usuarioRecebeAviso(r, "u-outro-agente")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Leitura no banco — stub PostgREST que registra os filtros de cada consulta
// ---------------------------------------------------------------------------

type Filtro = [string, string, unknown];
type Resposta = { data: unknown; error?: { message: string } | null };

/**
 * `messages` responde de forma DIFERENTE para o corpo (inbound) e para a
 * âncora do "já engajado" (outbound) — por isso a tabela pode ser uma função
 * dos filtros, e não só um objeto fixo.
 */
function stub(tabelas: Record<string, Resposta | ((filtros: Filtro[]) => Resposta)>) {
  const consultas: Array<{ tabela: string; filtros: Filtro[] }> = [];
  const db: LeitorDeAtribuicao = {
    from(tabela: string) {
      const registro = { tabela, filtros: [] as Filtro[] };
      consultas.push(registro);
      const responder = (): Resposta => {
        const t = tabelas[tabela];
        const r = typeof t === "function" ? t(registro.filtros) : t;
        return { data: r?.data ?? null, error: r?.error ?? null };
      };
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (registro.filtros.push(["eq", c, v]), q),
        is: (c: string, v: unknown) => (registro.filtros.push(["is", c, v]), q),
        in: (c: string, v: unknown) => (registro.filtros.push(["in", c, v]), q),
        neq: (c: string, v: unknown) => (registro.filtros.push(["neq", c, v]), q),
        gte: (c: string, v: unknown) => (registro.filtros.push(["gte", c, v]), q),
        order: (c: string, o: unknown) => (registro.filtros.push(["order", c, o]), q),
        limit: (n: number) => (registro.filtros.push(["limit", "", n]), q),
        maybeSingle: async () => responder(),
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(responder()).then(ok, ko),
      };
      return q;
    },
  };
  return { db, consultas };
}

describe("carregarDestinatariosDaMensagem", () => {
  it("conversa atribuída: não consulta negócio, lê admins ativos da org", async () => {
    const { db, consultas } = stub({
      conversations: { data: { assigned_to_user_id: "u-ana", contact_id: "ct-1", is_group: false } },
      user_organizations: { data: [{ user_id: ADMIN }] },
    });
    const d = await carregarDestinatariosDaMensagem(db, "org-1", "conv-1");
    expect(d).toEqual({ tipo: "restrito", userIds: ["u-ana", ADMIN] });
    expect(consultas.map((c) => c.tabela)).toEqual(["conversations", "user_organizations"]);
    const admins = consultas[1]!.filtros;
    expect(admins).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(admins).toContainEqual(["eq", "role", "admin"]);
    expect(admins).toContainEqual(["is", "revoked_at", null]);
  });

  it("sem atendente: busca negócios ABERTOS do contato, filtrando a org", async () => {
    const { db, consultas } = stub({
      conversations: { data: { assigned_to_user_id: null, contact_id: "ct-1", is_group: false } },
      crm_leads: { data: [{ owner_user_id: "u-bia" }] },
      user_organizations: { data: [{ user_id: ADMIN }] },
    });
    const d = await carregarDestinatariosDaMensagem(db, "org-1", "conv-1");
    expect(d).toEqual({ tipo: "restrito", userIds: ["u-bia", ADMIN] });
    const leads = consultas.find((c) => c.tabela === "crm_leads")!.filtros;
    expect(leads).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(leads).toContainEqual(["eq", "contact_id", "ct-1"]);
    expect(leads).toContainEqual(["eq", "status", "open"]);
  });

  it("contact_id do evento tem precedência sobre o da conversa", async () => {
    const { db, consultas } = stub({
      conversations: { data: { assigned_to_user_id: null, contact_id: "ct-conv", is_group: false } },
      crm_leads: { data: [] },
    });
    await carregarDestinatariosDaMensagem(db, "org-1", "conv-1", "ct-evento");
    expect(consultas.find((c) => c.tabela === "crm_leads")!.filtros).toContainEqual(["eq", "contact_id", "ct-evento"]);
  });

  it("sem atendente e sem negócio com dono → todos, e nem lê os admins", async () => {
    const { db, consultas } = stub({
      conversations: { data: { assigned_to_user_id: null, contact_id: "ct-1", is_group: false } },
      crm_leads: { data: [{ owner_user_id: null }] },
    });
    expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "todos" });
    expect(consultas.map((c) => c.tabela)).not.toContain("user_organizations");
  });

  it("grupo é sempre todos, mesmo com atendente", async () => {
    const { db } = stub({
      conversations: { data: { assigned_to_user_id: "u-ana", contact_id: "ct-g", is_group: true } },
    });
    expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-g")).toEqual({ tipo: "todos" });
  });

  it("conversa fora da org → null; erro de leitura → lança", async () => {
    expect(await carregarDestinatariosDaMensagem(stub({}).db, "org-1", "conv-x")).toBeNull();
    const { db } = stub({ conversations: { data: null, error: { message: "boom" } } });
    await expect(carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).rejects.toThrow("boom");
  });
});

describe("destinatariosDaMensagem — a IA e o plantão (regra pura)", () => {
  it("'ninguem' não avisa pessoa nenhuma", () => {
    expect(usuarioRecebeAviso({ tipo: "ninguem" }, ADMIN)).toBe(false);
  });

  it("responsável vence a IA e o plantão", () => {
    expect(
      destinatariosDaMensagem({
        atribuidoA: "u-ana",
        donosDeNegocioAberto: [],
        admins: [ADMIN],
        iaConduz: true,
        filaDistribuida: { dePlantao: [], gestores: ["u-gerente"] },
      }),
    ).toEqual({ tipo: "restrito", userIds: ["u-ana", ADMIN] });
  });

  it("sem responsável e a IA conduzindo → ninguém", () => {
    expect(
      destinatariosDaMensagem({ atribuidoA: null, donosDeNegocioAberto: [], admins: [], iaConduz: true }),
    ).toEqual({ tipo: "ninguem" });
  });

  it("fila distribuída: quem está de plantão; ninguém de plantão → gestores; nem gestores → todos", () => {
    const base = { atribuidoA: null, donosDeNegocioAberto: [], admins: [] };
    expect(destinatariosDaMensagem({ ...base, filaDistribuida: { dePlantao: ["u-ana"], gestores: [ADMIN] } })).toEqual({
      tipo: "restrito",
      userIds: ["u-ana"],
    });
    expect(destinatariosDaMensagem({ ...base, filaDistribuida: { dePlantao: [], gestores: [ADMIN] } })).toEqual({
      tipo: "restrito",
      userIds: [ADMIN],
    });
    expect(destinatariosDaMensagem({ ...base, filaDistribuida: { dePlantao: [], gestores: [] } })).toEqual({
      tipo: "todos",
    });
  });
});

// Domingo 03:00 em São Paulo (06:00Z) — fora de uma jornada de seg a sex 09-18.
const DOMINGO_MADRUGADA = new Date("2026-10-18T06:00:00Z");
const JORNADA_COMERCIAL = {
  timezone: "America/Sao_Paulo",
  windows: [1, 2, 3, 4, 5].map((dow) => ({ dow, start: "09:00", end: "18:00" })),
};

const SEM_DONO = {
  assigned_to_user_id: null,
  contact_id: "ct-1",
  is_group: false,
  status: "open",
  bot_silenced_until: null,
  channel_session_id: "ch-1",
};
const AGENTE_NO_AR = {
  id: "ag-1",
  kind: "mcp_agent",
  is_active: true,
  paused_at: null,
  published_version_id: "v1",
  archived_at: null,
  operation_mode: "automatic",
};
/** A IA só conduz onde o dreno roda o turno: versão publicada NO número da conversa. */
const VERSAO_NO_NUMERO = { id: "v1", channel_session_id: "ch-1" };
/** O que a leitura de elegibilidade embute na conversa (org operante, canal aberto). */
const ELEGIVEL = { organizations: { status: "active" }, contacts: { force_human: false, ai_opt_out: false }, channel_sessions: { metadata: {} } };
const MEMBROS = [
  { user_id: "u-ana", role: "agent" },
  { user_id: "u-bia", role: "agent" },
  { user_id: "u-gerente", role: "manager" },
  { user_id: ADMIN, role: "admin" },
];

const tabelasLidas = (consultas: Array<{ tabela: string }>) => consultas.map((c) => c.tabela);

describe("carregarDestinatariosDaMensagem — fila, plantão e IA", () => {
  it("(i) modo manual, ninguém disponível → todos, sem ler disponibilidade", async () => {
    const { db, consultas } = stub({
      conversations: { data: SEM_DONO },
      crm_leads: { data: [] },
      contacts: { data: { force_human: false, is_blocked: false } },
      ai_agents: { data: [] },
      organizations: { data: { settings: {} } },
      channel_routing_policies: { data: null },
      attendant_availability: { data: [{ user_id: "u-ana", schedule: {} }] },
    });
    expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "todos" });
    expect(tabelasLidas(consultas)).not.toContain("attendant_availability");
  });

  it("(ii-a) rodízio: só quem está de plantão (is_available + sem jornada)", async () => {
    const { db, consultas } = stub({
      conversations: { data: SEM_DONO },
      crm_leads: { data: [] },
      ai_agents: { data: [] },
      organizations: { data: { settings: { routing: { mode: "round_robin" } } } },
      channel_routing_policies: { data: null },
      attendant_availability: { data: [{ user_id: "u-ana", schedule: {} }] },
      user_organizations: { data: MEMBROS },
    });
    expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "restrito", userIds: ["u-ana"] });
    const disp = consultas.find((c) => c.tabela === "attendant_availability")!.filtros;
    expect(disp).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(disp).toContainEqual(["eq", "is_available", true]);
    const membros = consultas.find((c) => c.tabela === "user_organizations")!.filtros;
    expect(membros).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(membros).toContainEqual(["is", "revoked_at", null]);
  });

  it("(ii-b) rodízio, disponível mas fora da jornada → gestores; viewer de plantão não entra", async () => {
    const { db } = stub({
      conversations: { data: SEM_DONO },
      crm_leads: { data: [] },
      ai_agents: { data: [] },
      organizations: { data: { settings: { routing: { mode: "round_robin" } } } },
      channel_routing_policies: { data: null },
      attendant_availability: {
        data: [
          { user_id: "u-ana", schedule: JORNADA_COMERCIAL },
          { user_id: "u-viewer", schedule: {} },
        ],
      },
      user_organizations: { data: MEMBROS },
    });
    expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1", null, DOMINGO_MADRUGADA)).toEqual({
      tipo: "restrito",
      userIds: ["u-gerente", ADMIN],
    });
  });

  it("(ii-c) a regra do NÚMERO vence a da organização, nos dois sentidos", async () => {
    const comCanal = (orgMode: string, canal: string) =>
      stub({
        conversations: { data: SEM_DONO },
        crm_leads: { data: [] },
        ai_agents: { data: [] },
        organizations: { data: { settings: { routing: { mode: orgMode } } } },
        channel_routing_policies: { data: { id: "pol-1", distribution_mode: canal, default_assignee_user_id: null } },
        channel_routing_responsibles: { data: [{ user_id: "u-ana" }] },
        attendant_availability: { data: [{ user_id: "u-ana", schedule: {} }] },
        user_organizations: { data: MEMBROS },
      }).db;
    expect(await carregarDestinatariosDaMensagem(comCanal("manual", "load"), "org-1", "conv-1")).toEqual({
      tipo: "restrito",
      userIds: ["u-ana"],
    });
    expect(await carregarDestinatariosDaMensagem(comCanal("round_robin", "manual"), "org-1", "conv-1")).toEqual({
      tipo: "todos",
    });
  });

  it("(ii-d) canal com responsáveis: de plantão fora da lista do canal não conta", async () => {
    const { db, consultas } = stub({
      conversations: { data: SEM_DONO },
      crm_leads: { data: [] },
      ai_agents: { data: [] },
      organizations: { data: { settings: { routing: { mode: "round_robin" } } } },
      channel_routing_policies: { data: { id: "pol-1", distribution_mode: null, default_assignee_user_id: null } },
      channel_routing_responsibles: { data: [{ user_id: "u-bia" }] },
      attendant_availability: { data: [{ user_id: "u-ana", schedule: {} }] },
      user_organizations: { data: MEMBROS },
    });
    expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({
      tipo: "restrito",
      userIds: ["u-gerente", ADMIN],
    });
    // `filter`/`every`: a regra do número também lê `channel_routing_policies`.
    for (const t of ["channel_routing_policies", "channel_routing_responsibles"]) {
      const lidas = consultas.filter((c) => c.tabela === t);
      expect(lidas.length).toBeGreaterThan(0);
      expect(lidas.every((c) => c.filtros.some((f) => f[1] === "organization_id" && f[2] === "org-1"))).toBe(true);
    }
  });

  it("(iii-a) sem responsável, IA no ar e conversa sem trava → ninguém", async () => {
    const { db, consultas } = stub({
      conversations: { data: { ...SEM_DONO, ...ELEGIVEL, status: "ai_handling" } },
      crm_leads: { data: [] },
      contacts: { data: { force_human: false, is_blocked: false } },
      ai_agents: { data: [AGENTE_NO_AR] },
      ai_agent_versions: { data: [VERSAO_NO_NUMERO] },
    });
    expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "ninguem" });
    const contato = consultas.find((c) => c.tabela === "contacts")!.filtros;
    expect(contato).toContainEqual(["eq", "id", "ct-1"]);
    expect(contato).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(tabelasLidas(consultas)).not.toContain("attendant_availability");
  });

  it.each([
    ["agente pausado", { ai_agents: { data: [{ ...AGENTE_NO_AR, paused_at: "2026-10-01T00:00:00Z" }] } }],
    ["depois da passagem (silêncio durável)", { conversations: { data: { ...SEM_DONO, bot_silenced_until: "infinity" } } }],
    ["leitura dos agentes falhou", { ai_agents: { data: null, error: { message: "fora" } } }],
    ["contato travado em humano", { contacts: { data: { force_human: true, is_blocked: false } } }],
  ])("(iii) %s → regra da fila (todos no manual)", async (_caso, troca) => {
    const { db } = stub({
      conversations: { data: SEM_DONO },
      crm_leads: { data: [] },
      contacts: { data: { force_human: false, is_blocked: false } },
      ai_agents: { data: [AGENTE_NO_AR] },
      organizations: { data: { settings: {} } },
      ...troca,
    });
    expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "todos" });
  });

  // O dreno só roda o turno onde o NÚMERO da conversa tem quem atenda
  // (`haQuemAtendaASessao`) e a conversa passa na elegibilidade. Fora disso a IA
  // não responde, e calar o aviso deixaria o cliente sem ninguém.
  const IA_NO_AR = {
    conversations: { data: { ...SEM_DONO, ...ELEGIVEL } },
    crm_leads: { data: [] },
    contacts: { data: { force_human: false, is_blocked: false } },
    ai_agents: { data: [AGENTE_NO_AR] },
    ai_agent_versions: { data: [VERSAO_NO_NUMERO] },
    organizations: { data: { settings: {} } },
  };

  it("(iii-b) controle: o mesmo cenário com a versão no número da conversa → ninguém", async () => {
    expect(await carregarDestinatariosDaMensagem(stub(IA_NO_AR).db, "org-1", "conv-1")).toEqual({ tipo: "ninguem" });
  });

  it("(iii-c) roteador ativo no número com membro publicado → ninguém; filtros da org nas leituras", async () => {
    const { db, consultas } = stub({
      ...IA_NO_AR,
      ai_agent_versions: { data: [{ id: "v1", channel_session_id: "ch-outro" }] },
      ai_routers: { data: [{ id: "r-1", fallback_agent_id: null }] },
      ai_router_members: { data: [{ agent_id: "ag-1" }] },
    });
    expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "ninguem" });
    for (const t of ["ai_agents", "ai_agent_versions", "ai_routers", "ai_router_members"]) {
      expect(consultas.filter((c) => c.tabela === t).every((c) => c.filtros.some((f) => f[1] === "organization_id" && f[2] === "org-1"))).toBe(true);
    }
    expect(consultas.find((c) => c.tabela === "ai_routers")!.filtros).toContainEqual(["eq", "channel_session_id", "ch-1"]);
  });

  it.each([
    ["agente publicado em OUTRO número, sem roteador no desta", { ai_agent_versions: { data: [{ id: "v1", channel_session_id: "ch-outro" }] }, ai_routers: { data: [] } }],
    ["roteador do número sem membro que execute", { ai_agent_versions: { data: [{ id: "v1", channel_session_id: "ch-outro" }] }, ai_routers: { data: [{ id: "r-1", fallback_agent_id: "ag-pausado" }] }, ai_router_members: { data: [] } }],
    ["versão apontada não está publicada", { ai_agent_versions: { data: [] } }],
    ["agente no modo assistido (o rascunho espera uma pessoa)", { ai_agents: { data: [{ ...AGENTE_NO_AR, operation_mode: "assisted" }] } }],
    ["conversa sem número", { conversations: { data: { ...SEM_DONO, ...ELEGIVEL, channel_session_id: null } } }],
    ["contato marcado para sempre atendimento humano", { conversations: { data: { ...SEM_DONO, ...ELEGIVEL, contacts: { force_human: false, ai_opt_out: true } } } }],
    ["canal com acesso restrito e contato não autorizado", { conversations: { data: { ...SEM_DONO, ...ELEGIVEL, channel_sessions: { metadata: { ai_gate: "allowlist" } } } } }],
  ])("(iii-d) %s → regra da fila, nunca ninguém", async (_caso, troca) => {
    expect(await carregarDestinatariosDaMensagem(stub({ ...IA_NO_AR, ...troca }).db, "org-1", "conv-1")).toEqual({
      tipo: "todos",
    });
  });

  it("(iv-a) conversa atribuída: responsável + admins, sem ler agentes nem plantão", async () => {
    const { db, consultas } = stub({
      conversations: { data: { ...SEM_DONO, assigned_to_user_id: "u-ana" } },
      ai_agents: { data: [AGENTE_NO_AR] },
      user_organizations: { data: [{ user_id: ADMIN }] },
    });
    expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({
      tipo: "restrito",
      userIds: ["u-ana", ADMIN],
    });
    expect(tabelasLidas(consultas)).toEqual(["conversations", "user_organizations"]);
  });

  it("(iv-b) dono de negócio aberto, com IA no ar → dono + admins (a precedência não muda)", async () => {
    const { db, consultas } = stub({
      conversations: { data: SEM_DONO },
      crm_leads: { data: [{ owner_user_id: "u-bia" }] },
      ai_agents: { data: [AGENTE_NO_AR] },
      user_organizations: { data: [{ user_id: ADMIN }] },
    });
    expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({
      tipo: "restrito",
      userIds: ["u-bia", ADMIN],
    });
    expect(tabelasLidas(consultas)).not.toContain("ai_agents");
  });

  // O filtro "Só responder quando a mensagem falar de algo específico"
  // (`trigger_config.filters.keyword_regex`, #2679) vale em TODA mensagem do
  // turno automático até a ENTRADA do agente (#3240): a que não casa encerra
  // o turno sem resposta (`inbound-turn.ts`). Se a IA não vai responder a
  // esta mensagem, calar o aviso deixa o cliente sem ninguém (#3353).
  describe("o filtro de palavras da versão que executa (#3353)", () => {
    const COM_FILTRO = {
      ...IA_NO_AR,
      ai_agent_versions: {
        data: [{ ...VERSAO_NO_NUMERO, trigger_config: { filters: { keyword_regex: "orçamento|preço" } } }],
      },
    };
    /** O corpo lê a última INBOUND; a âncora lê a outbound do agente. */
    const ultimaInbound = (corpo: string | null) => (filtros: Filtro[]) =>
      filtros.some((f) => f[1] === "direction" && f[2] === "inbound")
        ? { data: { body: corpo } }
        : { data: null };
    const ancorada = (corpo: string | null, respostaAncora: Resposta) => (filtros: Filtro[]) =>
      filtros.some((f) => f[1] === "direction" && f[2] === "inbound")
        ? { data: { body: corpo } }
        : respostaAncora;

    it.each([
      ["'sim' no meio da conversa", "sim"],
      ["'oi, bom dia' na entrada", "oi, bom dia"],
    ])("(cenario A) mensagem SEM a palavra (%s): o turno pula, então a equipe é avisada", async (_caso, corpo) => {
      const { db, consultas } = stub({ ...COM_FILTRO, messages: ultimaInbound(corpo) });
      expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "todos" });
      const mensagem = consultas.find((c) => c.tabela === "messages")!.filtros;
      expect(mensagem).toContainEqual(["eq", "organization_id", "org-1"]);
      expect(mensagem).toContainEqual(["eq", "conversation_id", "conv-1"]);
      expect(mensagem).toContainEqual(["eq", "direction", "inbound"]);
      expect(mensagem).toContainEqual(["order", "sent_at", { ascending: false }]);
      expect(mensagem).toContainEqual(["limit", "", 1]);
    });

    it("(cenario B) controle — mensagem COM a palavra → ninguém (a IA atende)", async () => {
      const { db } = stub({ ...COM_FILTRO, messages: ultimaInbound("quero um orçamento") });
      expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "ninguem" });
    });

    it("(controle) sem filtro preenchido a mensagem nem é lida", async () => {
      const { db, consultas } = stub({ ...IA_NO_AR, messages: ultimaInbound("sim") });
      expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "ninguem" });
      expect(tabelasLidas(consultas)).not.toContain("messages");
    });

    it("(cenario A) leitura da mensagem falhou → regra da fila, nunca ninguém", async () => {
      const { db } = stub({ ...COM_FILTRO, messages: { data: null, error: { message: "fora" } } });
      expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "todos" });
    });

    // O dreno ADIA o turno enquanto a mídia vira texto (`drain.ts`), e o
    // filtro julga a transcrição. O aviso decide antes, no INSERT, com
    // `body` nulo: ainda não há o que julgar.
    it("(cenario A) áudio ainda sem transcrição (corpo nulo): o turno vai julgar a transcrição, então avisa", async () => {
      const { db } = stub({ ...COM_FILTRO, messages: ultimaInbound(null) });
      expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "todos" });
    });

    // A âncora do #3240: o filtro decide só a ENTRADA. Quem já falou neste
    // atendimento segue respondendo (o turno não pula mais), então o aviso
    // tem de continuar calado — sem isto o conserto avisaria o meio da
    // conversa que a IA conduz, o barulho que o #3113 tirou.
    it("(cenario C) agente já respondeu no atendimento → ninguém: o aviso não dispara junto com a resposta da IA", async () => {
      const { db, consultas } = stub({
        ...COM_FILTRO,
        messages: ancorada("sim", { data: { id: "m-out-1" } }),
      });
      expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "ninguem" });
      const ancora = consultas.filter((c) => c.tabela === "messages").at(-1)!.filtros;
      expect(ancora).toContainEqual(["eq", "direction", "outbound"]);
      expect(ancora).toContainEqual(["eq", "sent_via", "ai"]);
      expect(ancora).toContainEqual(["eq", "metadata->>ai_actor_id", "ag-1"]);
      expect(ancora).toContainEqual(["neq", "status", "failed"]);
    });

    it("(cenario C) a âncora respeita a fronteira do atendimento (#3240)", async () => {
      const { db, consultas } = stub({
        ...COM_FILTRO,
        conversations: { data: { ...SEM_DONO, ...ELEGIVEL, service_started_at: "2026-10-25T00:00:00Z" } },
        messages: ultimaInbound("sim"),
      });
      expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "todos" });
      const ancora = consultas.filter((c) => c.tabela === "messages").at(-1)!.filtros;
      expect(ancora).toContainEqual(["gte", "sent_at", "2026-10-25T00:00:00Z"]);
    });

    it("(cenario A) leitura da âncora falhou → não inventa engajamento, a equipe é avisada", async () => {
      const { db } = stub({
        ...COM_FILTRO,
        messages: ancorada("sim", { data: null, error: { message: "fora" } }),
      });
      expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "todos" });
    });

    // O do pedido: a MESMA mensagem não vira dois avisos. O conserto muda só
    // a DECISÃO — uma função pura, sem escrita e sem emissor novo. O push
    // continua saindo do handler (dedup por evento, `consumed_by`) e o toast
    // do app continua um por INSERT; se o conserto criasse um segundo
    // caminho (ex.: o turno pulado avisando), a mesma mensagem avisaria
    // duas vezes.
    it("(cenario C) decisão determinística e sem efeito colateral: mesma mensagem, mesmo destino", async () => {
      const { db, consultas } = stub({ ...COM_FILTRO, messages: ultimaInbound("sim") });
      const primeira = await carregarDestinatariosDaMensagem(db, "org-1", "conv-1");
      const segunda = await carregarDestinatariosDaMensagem(db, "org-1", "conv-1");
      expect(primeira).toEqual({ tipo: "todos" });
      expect(segunda).toEqual(primeira);
      // A regra só LÊ: nenhuma tabela de escrita de rastro é tocada.
      expect(consultas.every((c) => !["event_log", "agent_inbox_items"].includes(c.tabela))).toBe(true);
    });

    it("(controle) conversa COM responsável: o filtro preenchido não muda a regra 1, e nem a mensagem é lida", async () => {
      const { db, consultas } = stub({
        ...COM_FILTRO,
        conversations: { data: { ...SEM_DONO, assigned_to_user_id: "u-ana" } },
        user_organizations: { data: [{ user_id: ADMIN }] },
      });
      expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({
        tipo: "restrito",
        userIds: ["u-ana", ADMIN],
      });
      expect(tabelasLidas(consultas)).not.toContain("messages");
    });
  });
});
