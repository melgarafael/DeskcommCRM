import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AS ESCRITAS DO TURNO SÓ ALCANÇAM REGISTROS DO CONTATO DA CONVERSA.
 *
 * Mesma regra das leituras (`leitura-do-turno-escopo*.test.ts`), agora na
 * ponte, para toda escrita que recebe o alvo por identificador: id de outro
 * cliente e id inexistente recebem a MESMA recusa, com o mesmo número de
 * consultas, e o handler não roda. Sem contato do turno, nada muda.
 *
 * A asserção é sobre a CADEIA: monta a ferramenta como o turno monta
 * (`pickToolsFromMcp`). O handler é substituído por um espião: o que se mede
 * aqui é se a ponte deixa a chamada chegar até ele.
 */

vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));

const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");
const { allTools, getToolByName } = await import("@/lib/mcp/tools");
const { catalogEntry } = await import("@/lib/mcp/tools/catalog");
const { ESCOPO_DAS_ESCRITAS, escritaCabeNoTurno } = await import("@/lib/ai/runtime/escopo-das-escritas");
const { MODULOS_OPCIONAIS } = await import("@/lib/instalacao/modulos");
const { CAPACIDADES_DA_ORGANIZACAO } = await import("@/lib/organizacao/capacidades");

const ORG = "11111111-1111-4111-8111-111111111111";
const DO_TURNO = "22222222-2222-4222-8222-222222222222";
const DE_B = "66666666-6666-4666-8666-666666666666";
const INEXISTENTE = "99999999-9999-4999-8999-999999999999";
const FUNIL = "77777777-7777-4777-8777-777777777777";
const NEGOCIO_DO_TURNO = "33333333-3333-4333-8333-333333333333";
const NEGOCIO_DE_B = "44444444-4444-4444-8444-444444444444";
const CONVERSA_DO_TURNO = "aaaaaaaa-1111-4111-8111-111111111111";
const CONVERSA_DE_B = "aaaaaaaa-2222-4222-8222-222222222222";
const COMPROMISSO_DO_TURNO = "cccccccc-1111-4111-8111-111111111111";
const COMPROMISSO_DE_B = "cccccccc-2222-4222-8222-222222222222";
const RETORNO_DO_TURNO = "dddddddd-1111-4111-8111-111111111111";
const RETORNO_DE_B = "dddddddd-2222-4222-8222-222222222222";
const CASO_DO_TURNO = "bbbbbbbb-1111-4111-8111-111111111111";
const CASO_DE_B = "bbbbbbbb-2222-4222-8222-222222222222";

type Linha = Record<string, unknown>;

const TABELAS: Record<string, Linha[]> = {
  conversations: [
    { id: CONVERSA_DE_B, organization_id: ORG, contact_id: DE_B },
    { id: CONVERSA_DO_TURNO, organization_id: ORG, contact_id: DO_TURNO },
  ],
  calendar_appointments: [
    { id: COMPROMISSO_DE_B, organization_id: ORG, contact_id: DE_B },
    { id: COMPROMISSO_DO_TURNO, organization_id: ORG, contact_id: DO_TURNO },
  ],
  cron_jobs: [
    { id: RETORNO_DE_B, organization_id: ORG, contact_id: DE_B, kind: "at", job_kind: "followup_turn" },
    { id: RETORNO_DO_TURNO, organization_id: ORG, contact_id: DO_TURNO, kind: "at", job_kind: "followup_turn" },
  ],
  agent_cases: [
    { id: CASO_DE_B, organization_id: ORG, conversation_id: CONVERSA_DE_B },
    { id: CASO_DO_TURNO, organization_id: ORG, conversation_id: CONVERSA_DO_TURNO },
  ],
  crm_leads: [
    { id: NEGOCIO_DE_B, organization_id: ORG, contact_id: DE_B, pipeline_id: FUNIL, status: "open", last_activity_at: "2020-01-01T00:00:00Z", created_at: "2020-01-01T00:00:00Z" },
    { id: NEGOCIO_DO_TURNO, organization_id: ORG, contact_id: DO_TURNO, pipeline_id: FUNIL, status: "open", last_activity_at: "2020-01-01T00:00:00Z", created_at: "2020-01-01T00:00:00Z" },
  ],
};

/** Dublê que APLICA `eq`/`in` e conta as consultas. */
function bancoFalso() {
  let consultas = 0;
  const from = (tabela: string) => {
    consultas++;
    let linhas = [...(TABELAS[tabela] ?? [])];
    const alvo: Record<string, unknown> = {
      eq: (coluna: string, valor: unknown) => {
        linhas = linhas.filter((l) => l[coluna] === valor);
        return cadeia;
      },
      in: (coluna: string, valores: unknown[]) => {
        linhas = linhas.filter((l) => valores.includes(l[coluna]));
        return cadeia;
      },
      maybeSingle: () => Promise.resolve({ data: linhas[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve({ data: linhas, error: null }).then(ok, falha),
    };
    const cadeia: unknown = new Proxy(alvo, { get: (t, p: string) => (p in t ? t[p] : () => cadeia) });
    return cadeia;
  };
  return { from, contagem: () => consultas };
}

async function executar(nome: string, args: Linha, contatoDoTurno?: string) {
  const def = getToolByName(nome)!;
  const handler = vi.spyOn(def, "handler").mockResolvedValue({ chegou_ao_handler: true } as never);
  const supabase = bancoFalso();
  const ator = { type: "ai_agent", id: "ag-1", role: "ai_operator" };
  const ferramentas = pickToolsFromMcp({
    toolIds: [nome],
    auth: { organizationId: ORG, role: "ai_operator", scopes: ["mcp:read", "mcp:write"], actor: ator, apiTokenId: "tok-1" },
    ctx: { organizationId: ORG, role: "ai_operator", actor: ator, apiTokenId: "tok-1", requestId: "req-1", supabase },
    supabase,
    pipelineIds: [FUNIL],
    modulosLigados: MODULOS_OPCIONAIS,
    capacidadesLigadas: CAPACIDADES_DA_ORGANIZACAO,
    handoffToolEnabled: true,
    proposalAiDraftEnabled: true,
    handoffSignal: { triggered: false },
    ...(contatoDoTurno ? { contatoDoTurno } : {}),
  } as never);
  const r = await ferramentas[nome]!.execute!(args, { toolCallId: "c1", messages: [] } as never);
  const chamou = handler.mock.calls.length > 0;
  handler.mockRestore();
  return { r: r as Linha, chamou, consultas: supabase.contagem() };
}

afterEach(() => vi.restoreAllMocks());

/** Ferramenta → como montar os args com um alvo, e os alvos do turno e de B. */
const CASOS: Array<{ nome: string; args: (alvo: string) => Linha; doTurno: string; deB: string }> = [
  ...["crm_book_appointment", "crm_find_and_book_appointment", "crm_propose_contact_field", "crm_schedule_followup"].map(
    (nome) => ({ nome, args: (a: string) => ({ contact_id: a }), doTurno: DO_TURNO, deB: DE_B }),
  ),
  { nome: "crm_enroll_followup_flow", args: (a) => ({ contact_id: a, flow_id: FUNIL }), doTurno: DO_TURNO, deB: DE_B },
  { nome: "crm_create_lead", args: (a) => ({ contact_id: a, pipeline_id: FUNIL }), doTurno: DO_TURNO, deB: DE_B },
  { nome: "crm_update_lead", args: (a) => ({ lead_id: NEGOCIO_DO_TURNO, contact_id: a }), doTurno: DO_TURNO, deB: DE_B },
  ...["crm_reschedule_appointment", "crm_cancel_appointment", "crm_confirm_appointment", "crm_set_appointment_outcome"].map(
    (nome) => ({ nome, args: (a: string) => ({ appointment_id: a }), doTurno: COMPROMISSO_DO_TURNO, deB: COMPROMISSO_DE_B }),
  ),
  ...[
    "crm_create_conversation_draft",
    "crm_assign_conversation",
    "crm_send_whatsapp_message",
    "crm_request_human_handoff",
    "crm_resume_ai_attendance",
  ].map((nome) => ({ nome, args: (a: string) => ({ conversation_id: a }), doTurno: CONVERSA_DO_TURNO, deB: CONVERSA_DE_B })),
  { nome: "crm_draft_proposal", args: (a) => ({ lead_id: NEGOCIO_DO_TURNO, conversation_id: a }), doTurno: CONVERSA_DO_TURNO, deB: CONVERSA_DE_B },
  { nome: "crm_cancel_followup", args: (a) => ({ followup_id: a }), doTurno: RETORNO_DO_TURNO, deB: RETORNO_DE_B },
  ...["crm_add_case_note", "crm_close_human_case"].map((nome) => ({
    nome,
    args: (a: string) => ({ case_id: a }),
    doTurno: CASO_DO_TURNO,
    deB: CASO_DE_B,
  })),
  { nome: "crm_manage_tags", args: (a) => ({ target_kind: "contact", target_id: a }), doTurno: DO_TURNO, deB: DE_B },
  { nome: "crm_manage_tags", args: (a) => ({ target_kind: "conversation", target_id: a }), doTurno: CONVERSA_DO_TURNO, deB: CONVERSA_DE_B },
  { nome: "crm_manage_tags", args: (a) => ({ target_kind: "lead", target_id: a }), doTurno: NEGOCIO_DO_TURNO, deB: NEGOCIO_DE_B },
];

describe.each(CASOS)("$nome $args", ({ nome, args, doTurno, deB }) => {
  it("com turno: de outro cliente e inexistente recebem a MESMA recusa, e o handler não roda", async () => {
    const alheio = await executar(nome, args(deB), DO_TURNO);
    const inexistente = await executar(nome, args(INEXISTENTE), DO_TURNO);
    expect(alheio.r).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(inexistente.r).toEqual(alheio.r);
    expect(inexistente.consultas).toBe(alheio.consultas);
    expect(alheio.chamou).toBe(false);
    expect(inexistente.chamou).toBe(false);
  });

  it("com turno: o registro do próprio contato chega ao handler", async () => {
    const proprio = await executar(nome, args(doTurno), DO_TURNO);
    expect(proprio.r).toEqual({ chegou_ao_handler: true });
  });

  it("controle sem turno: o registro de outro cliente chega ao handler, como antes", async () => {
    const semTurno = await executar(nome, args(deB));
    expect(semTurno.r).toEqual({ chegou_ao_handler: true });
  });
});

describe("toda escrita montável no turno tem o dono de cada identificador declarado", () => {
  const escritas = allTools.filter((t) => t.category !== "read" && !catalogEntry(t.name)?.apenasHumano);

  it.each(escritas.map((t) => [t.name, t] as const))("%s", (nome, def) => {
    const campos = ESCOPO_DAS_ESCRITAS[nome];
    expect(campos, `${nome} sem entrada em ESCOPO_DAS_ESCRITAS`).toBeDefined();
    // `_ids` também: uma lista de ids sem dono passaria pela ponte sem conferência.
    const ids = Object.keys(def.inputSchema).filter((c) => /_ids?$/.test(c));
    for (const c of ids) expect(campos![c], `${nome}.${c} sem dono declarado`).toBeDefined();
    for (const c of Object.keys(campos!)) expect(def.inputSchema, `${nome}.${c} não existe`).toHaveProperty(c);
  });

  it("escrita sem entrada é recusada no turno (fecha na dúvida)", async () => {
    const original = ESCOPO_DAS_ESCRITAS.crm_save_org_memory;
    delete (ESCOPO_DAS_ESCRITAS as Record<string, unknown>).crm_save_org_memory;
    try {
      const r = await executar("crm_save_org_memory", { titulo: "x", corpo: "y" }, DO_TURNO);
      expect(r.r).toMatchObject({ permitido: false, motivo: "escrita_sem_escopo_do_turno" });
      expect(r.chamou).toBe(false);
    } finally {
      (ESCOPO_DAS_ESCRITAS as Record<string, unknown>).crm_save_org_memory = original;
    }
  });
});

describe("forma do valor num campo declarado", () => {
  it("lista no lugar do id é recusada, não pulada", async () => {
    const lista = await executar("crm_book_appointment", { contact_id: [DE_B] }, DO_TURNO);
    expect(lista.r).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(lista.chamou).toBe(false);
  });

  it("campo ausente ou nulo não é conferido", async () => {
    const sem = { from: () => { throw new Error("nada a conferir"); } };
    for (const args of [{ contact_id: null }, {}]) {
      expect(await escritaCabeNoTurno(sem as never, ORG, DO_TURNO, "crm_book_appointment", args)).toEqual({
        permitido: true,
      });
    }
  });

  it("o id do próprio contato em maiúsculas passa, como passaria no Postgres", async () => {
    const contato = "abcdef12-3456-4789-8abc-def123456789";
    const sem = { from: () => { throw new Error("o dono contato não consulta"); } };
    const r = await escritaCabeNoTurno(sem as never, ORG, contato, "crm_propose_contact_field", {
      contact_id: contato.toUpperCase(),
    });
    expect(r).toEqual({ permitido: true });
    const tag = await escritaCabeNoTurno(sem as never, ORG, contato, "crm_manage_tags", {
      target_kind: "contact",
      target_id: contato.toUpperCase(),
    });
    expect(tag).toEqual({ permitido: true });
  });
});
