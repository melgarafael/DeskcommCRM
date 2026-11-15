import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A GUARDA DA ABORDAGEM FRIA VETA FICHA PESSOAL, "SEMPRE HUMANO" E ETIQUETA
 * INTERNA OU DA EQUIPE — E A CAMPANHA SEGUE.
 *
 * Três brechas na `main` antes deste conserto:
 *
 *   (a) `contactMayBeProspected` não conferia `is_personal`, `ai_opt_out` nem as
 *       etiquetas, e a guarda nem as pedia no `select`. Para as etiquetas
 *       interna e da equipe, isso chegava ao cliente: a mensagem saía;
 *   (b) o worker só olhava `ok` de `autorizarContatoParaIA`, que devolve
 *       `{ok:true, autorizou:false}` com `ai_opt_out` (o caso mora em
 *       `tests/unit/prospecting-worker.test.ts`);
 *   (c) a ficha pessoal só era barrada pelo 403 do handler de mensagens, que
 *       não é `ProspectingError` e PAUSARIA a campanha como "Falha inesperada".
 *
 * (b) e (c) são defesa em profundidade, não defeito que o produto alcançava:
 * quem liga o "sempre humano" grava `force_human` junto
 * (`contacts/[id]/always-human/route.ts`), e a guarda antiga já o vetava (com
 * pausa); marcar a ficha como pessoal tira os candidatos `new`/`queued` da fila
 * (`contacts/[id]/personal/route.ts`). Os estados de (b) e (c) abaixo são
 * fabricados para provar a guarda nova sozinha.
 *
 * Aqui a guarda é a REAL, e o cliente falso devolve SÓ as colunas que a guarda
 * pediu no `select` — como a REST faz. Sem isso, um `select` que esquece a
 * coluna passaria no teste e falharia no produto.
 */
const id = "10000000-0000-4000-8000-000000000001";
const CONVERSA = id;

const CONTATO_LIMPO = {
  is_blocked: false,
  force_human: false,
  is_anonymized: false,
  source: "prospecting",
  consent: { legitimate_interest: { ref: "LIA-example" } },
  is_personal: false,
  ai_opt_out: false,
  tags: [] as string[],
};

const estado = {
  contato: { ...CONTATO_LIMPO } as Record<string, unknown>,
  settings: {} as Record<string, unknown>,
  erroDaOrganizacao: false,
  conversation: {
    status: "open",
    last_inbound_at: null as string | null,
    last_outbound_at: null as string | null,
    assigned_to_user_id: null as string | null,
    bot_silenced_until: null as string | null,
  },
};

/** O que de fato saiu pelo canal. */
const envios: string[] = [];

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  audit: vi.fn(),
  boundary: vi.fn(),
  preflight: vi.fn(),
  authorize: vi.fn(),
  knobs: vi.fn(),
  open: vi.fn(),
  paradas: vi.fn(),
}));

vi.mock("@/app/api/v1/messages/_handler", async () => {
  // O handler de verdade roda a guarda REAL na entrada (`_handler.ts`) — e o
  // 403 da ficha pessoal só viria DEPOIS dela.
  const { assertProspectingDelivery } = await vi.importActual<
    typeof import("@/lib/prospecting/guard")
  >("@/lib/prospecting/guard");
  return {
    sendMessageHandler: async (
      _supabase: unknown,
      ctx: { prospectingDelivery?: unknown },
      input: { body: string },
    ) => {
      if (ctx.prospectingDelivery)
        await assertProspectingDelivery(clienteDoSupa() as never, ctx.prospectingDelivery as never);
      envios.push(input.body);
      estado.conversation.last_outbound_at = new Date().toISOString();
      return { status: "sent", id: `balao-${envios.length}` };
    },
  };
});
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: mocks.generate,
}));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({ llmEdgeConfigFromEnv: () => ({}) }));
vi.mock("@/lib/atendimento/origem", () => ({
  assertServiceBoundarySupabase: mocks.boundary,
  beginServiceAtOrigin: vi.fn(),
}));
vi.mock("@/lib/atendimento/fronteira", () => ({ parseServiceBoundary: (x: unknown) => x }));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({ autorizarContatoParaIA: mocks.authorize }));
vi.mock("@/lib/ai/elegibilidade/consulta-pre-go-live", () => ({
  decidirPreGoLiveDoCanalViaSupabase: mocks.preflight,
}));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: mocks.knobs,
  loadPacingState: vi.fn().mockResolvedValue({ sentToday: 0 }),
  recordSend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/agent-engine/pacing/engine", () => ({
  janelaDeEnvioAberta: mocks.open,
  janelaDeProspeccaoAberta: () => true,
  proximaAberturaDaProspeccao: () => new Date(Date.now() + 3600000),
  decidePacing: () => ({ allow: true, waitMs: 0 }),
  proximaAberturaDaJanela: () => new Date(Date.now() + 3600000),
  warmupCapFor: (
    _idade: number,
    degraus: Array<{ minAgeDays: number; cap: number | null }>,
  ) => {
    let cap: number | null = degraus[0]?.cap ?? null;
    for (const d of degraus) if (_idade >= d.minAgeDays) cap = d.cap;
    return cap;
  },
}));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/organizacao/operante", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizacao/operante")>()),
  idsDeOrgsParadas: mocks.paradas,
}));
vi.mock("@/lib/prospecting/store", () => ({
  withProspectingLock: vi.fn(),
  synchronizeSearch: vi.fn(),
  validateConfig: vi.fn().mockResolvedValue(undefined),
  prepararCandidatoNoEnvio: vi.fn(),
}));

import {
  assertProspectingContinuation,
  assertProspectingDelivery,
  contactMayBeProspected,
  motivoDoVetoDoContato,
} from "@/lib/prospecting/guard";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { recordSend } from "@/lib/agent-engine/pacing/store";
import { ProspectingError } from "@/lib/prospecting/provider";
import { withProspectingLock } from "@/lib/prospecting/store";
import type { Campaign } from "@/lib/prospecting/store";
import { tickProspecting } from "@/lib/prospecting/worker";

/** Projeta a linha nas colunas pedidas, como a REST: coluna não pedida não volta. */
function projetar(linha: Record<string, unknown>, colunas: string) {
  return Object.fromEntries(
    colunas
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c in linha)
      .map((c) => [c, linha[c]]),
  );
}

function clienteDoSupa() {
  const linhas: Record<string, () => Record<string, unknown>> = {
    prospecting_candidates: () => ({
      campaign_id: id,
      contact_id: id,
      status: "sending",
      conversation_id: CONVERSA,
    }),
    prospecting_campaigns: () => ({ status: "running" }),
    contacts: () => estado.contato,
    conversations: () => estado.conversation,
    organizations: () => ({ settings: estado.settings }),
  };
  return {
    from(table: string) {
      let colunas = "";
      const consulta = {
        select: (c: string) => {
          colunas = c;
          return consulta;
        },
        eq: () => consulta,
        maybeSingle: async () => {
          if (table === "organizations" && estado.erroDaOrganizacao)
            return { data: null, error: { message: "falhou" } };
          const linha = linhas[table]?.();
          return { data: linha ? projetar(linha, colunas) : null, error: null };
        },
      };
      return consulta;
    },
  };
}

const ctx = { organizationId: id, candidateId: "candidate", conversationId: CONVERSA };

const campaign = {
  id,
  organization_id: id,
  next_send_at: new Date(0),
  config: {
    agent_id: id,
    channel_session_id: id,
    pipeline_id: id,
    stage_id: id,
    qualified_stage_id: "10000000-0000-4000-8000-000000000002",
    instruction: "Oferta definida pelo operador",
    qualification: "Necessidade confirmada pela pessoa",
    daily_limit: 10,
    interval_minutes: 15,
    legal_basis_ref: "LIA-example",
  },
} as Campaign;

const candidate = {
  id: "candidate",
  contact_id: id,
  conversation_id: CONVERSA,
  message_id: "stable-message",
  phone: "+551****0000",
  service_boundary: { conversation_id: CONVERSA },
  data: { name: "Example", socials: [] },
};

function banco() {
  return {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.startsWith("select * from prospecting_campaigns where organization_id=$1 and status='running'"))
        return { rows: [campaign] };
      if (sql.startsWith("select daily_message_limit")) return { rows: [{ daily_message_limit: 50 }] };
      if (sql.includes("count(*) filter"))
        return { rows: [{ campaign: 0, total: 0, retry_at: null, last_attempt: null }] };
      if (sql.startsWith("select * from prospecting_candidates")) return { rows: [candidate] };
      if (sql.startsWith("select locale from organizations")) return { rows: [{ locale: "pt-BR" }] };
      if (/^select (a\.)?published_version_id/.test(sql))
        return { rows: [{ published_version_id: id, operation_revision: 1 }] };
      return { rows: [] };
    }),
  };
}

async function rodarOTick() {
  const db = banco();
  (withProspectingLock as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (_pool: unknown, _org: unknown, fn: (d: unknown) => Promise<unknown>) => fn(db),
  );
  const pool = { query: vi.fn(async () => ({ rows: [{ organization_id: id }] })) };
  await tickProspecting(pool as never, clienteDoSupa() as never);
  return db;
}

/** As quatro marcas novas, com o motivo que a tela mostra embaixo da empresa. */
const MARCAS: Array<{
  caso: string;
  contato: Record<string, unknown>;
  settings?: Record<string, unknown>;
  motivo: string;
}> = [
  { caso: "ficha pessoal", contato: { is_personal: true }, motivo: "Contato marcado como pessoal." },
  {
    caso: "sempre atendimento humano",
    contato: { ai_opt_out: true },
    motivo: "Contato marcado como sempre atendimento humano.",
  },
  {
    caso: "etiqueta de contato interno (a comparação normaliza os dois lados)",
    contato: { tags: [" Interno "] },
    settings: { crm: { internal_contact_tags: ["interno"] } },
    motivo: "Contato interno (marcado por etiqueta).",
  },
  {
    caso: "etiqueta de contato da equipe",
    contato: { tags: ["socio"] },
    settings: { crm: { team_contact_tags: ["Socio"] } },
    motivo: "Contato da equipe (marcado por etiqueta).",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  estado.contato = { ...CONTATO_LIMPO };
  estado.settings = {};
  estado.erroDaOrganizacao = false;
  estado.conversation = {
    status: "open",
    last_inbound_at: null,
    last_outbound_at: null,
    assigned_to_user_id: null,
    bot_silenced_until: null,
  };
  envios.length = 0;
  mocks.knobs.mockResolvedValue({ knobs: {} });
  mocks.open.mockReturnValue(true);
  mocks.preflight.mockResolvedValue({ permite: true });
  mocks.boundary.mockResolvedValue(undefined);
  mocks.authorize.mockResolvedValue({ ok: true, autorizou: true });
  mocks.paradas.mockResolvedValue([]);
  mocks.generate.mockResolvedValue({ ok: true, texto: "Olá! Queria entender como vocês atendem hoje." });
});

describe("a guarda da abordagem fria veta as três marcas, no escopo do candidato", () => {
  it.each(MARCAS)("$caso: a 1ª mensagem é recusada com o motivo, sem pausar a campanha", async (m) => {
    estado.contato = { ...CONTATO_LIMPO, ...m.contato };
    estado.settings = m.settings ?? {};
    const erro = await assertProspectingDelivery(clienteDoSupa() as never, ctx).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ProspectingError);
    expect((erro as ProspectingError).message).toBe(m.motivo);
    expect((erro as ProspectingError).status).toBe(409);
    expect((erro as ProspectingError).escopo).toBe("candidato");
  });

  it.each(MARCAS)("$caso: a bolha seguinte também para, só neste candidato", async (m) => {
    estado.contato = { ...CONTATO_LIMPO, ...m.contato };
    estado.settings = m.settings ?? {};
    const erro = await assertProspectingContinuation(clienteDoSupa() as never, ctx).catch(
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ProspectingError);
    expect((erro as ProspectingError).message).toBe(m.motivo);
    expect((erro as ProspectingError).escopo).toBe("candidato");
  });

  it("controle: contato sem marca nenhuma passa nas duas conferências", async () => {
    await expect(assertProspectingDelivery(clienteDoSupa() as never, ctx)).resolves.toBeUndefined();
    await expect(assertProspectingContinuation(clienteDoSupa() as never, ctx)).resolves.toBeUndefined();
  });

  it("bolha seguinte de quem respondeu E ficou bloqueado: o motivo é o da conversa, não o do contato", async () => {
    // Quem responde "PARAR" no meio fica bloqueado E com `last_inbound_at`. A
    // continuação confere a conversa ANTES do contato, e a tela mostra "a
    // pessoa respondeu", não "Contato bloqueado.". Os dois ramos são do candidato.
    estado.contato = { ...CONTATO_LIMPO, is_blocked: true };
    estado.conversation.last_inbound_at = new Date().toISOString();
    const erro = await assertProspectingContinuation(clienteDoSupa() as never, ctx).catch(
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ProspectingError);
    expect((erro as ProspectingError).message).toBe(
      "A pessoa respondeu ou o atendimento foi assumido; a abordagem parou aqui.",
    );
    expect((erro as ProspectingError).escopo).toBe("candidato");
  });

  it("controle: etiqueta que não está em lista nenhuma não veta", async () => {
    estado.contato = { ...CONTATO_LIMPO, tags: ["cliente-vip"] };
    estado.settings = { crm: { internal_contact_tags: ["interno"], team_contact_tags: ["socio"] } };
    await expect(assertProspectingDelivery(clienteDoSupa() as never, ctx)).resolves.toBeUndefined();
  });

  it("o veto de contato que já existia (bloqueado) também deixou de pausar a campanha", async () => {
    estado.contato = { ...CONTATO_LIMPO, is_blocked: true };
    const erro = await assertProspectingDelivery(clienteDoSupa() as never, ctx).catch((e: unknown) => e);
    expect((erro as ProspectingError).message).toBe("Contato bloqueado.");
    expect((erro as ProspectingError).escopo).toBe("candidato");
  });

  it("a conversa que deixou de ser fria continua com escopo campanha (o controle das bolhas do #2680)", async () => {
    estado.conversation.last_outbound_at = new Date().toISOString();
    const erro = await assertProspectingDelivery(clienteDoSupa() as never, ctx).catch((e: unknown) => e);
    expect((erro as ProspectingError).message).toBe(
      "Contato já atendido, assumido por humano ou sem autorização para esta abordagem.",
    );
    expect((erro as ProspectingError).escopo).toBe("campanha");
  });

  it("falhar fechado: sem ler as listas da organização, a abordagem não sai (escopo campanha)", async () => {
    estado.erroDaOrganizacao = true;
    const erro = await assertProspectingDelivery(clienteDoSupa() as never, ctx).catch((e: unknown) => e);
    expect((erro as ProspectingError).message).toBe("Campanha pausada ou dados indisponíveis.");
    expect((erro as ProspectingError).escopo).toBe("campanha");
  });

  it("todo motivo que a tela mostra embaixo da empresa tem espanhol no dicionário", () => {
    // A tela mostra `t(c.error)`: frase sem entrada cai para o português numa
    // instalação em espanhol. Os motivos saem da régua, não de uma lista
    // transcrita aqui, para uma frase reescrita na guarda reprovar este caso.
    const etiquetas = { internas: ["interno"], daEquipe: ["socio"] };
    const motivos = [
      { is_blocked: true },
      { is_anonymized: true },
      { is_personal: true },
      { ai_opt_out: true },
      { force_human: true },
      { tags: ["interno"] },
      { tags: ["socio"] },
      { consent: { legitimate_interest: { ref: "LIA-example" }, marketing: { granted: false } } },
      { consent: null, source: "manual" },
    ].map((marca) => motivoDoVetoDoContato({ ...CONTATO_LIMPO, ...marca }, etiquetas));
    expect(new Set(motivos).size, "duas marcas com o mesmo motivo, ou uma sem veto").toBe(9);
    expect(motivos).not.toContain(null);
    for (const m of [...motivos, "A IA não pode atender este contato."])
      expect(DICIONARIO[m as string]?.es, `sem espanhol: ${m}`).toBeTruthy();
    // A ficha pessoal usa a MESMA frase do 403 do handler de mensagens.
    expect(motivoDoVetoDoContato({ ...CONTATO_LIMPO, is_personal: true })).toBe("Contato marcado como pessoal.");
  });

  it("a régua pura recusa as três marcas e aceita o contato limpo", () => {
    expect(contactMayBeProspected(CONTATO_LIMPO)).toBe(true);
    expect(contactMayBeProspected({ ...CONTATO_LIMPO, is_personal: true })).toBe(false);
    expect(contactMayBeProspected({ ...CONTATO_LIMPO, ai_opt_out: true })).toBe(false);
    expect(
      contactMayBeProspected({ ...CONTATO_LIMPO, tags: ["interno"] }, { internas: ["interno"], daEquipe: [] }),
    ).toBe(false);
  });
});

describe("pelo tick: a empresa vetada fica `failed` com o motivo e a campanha segue `running`", () => {
  it.each(MARCAS)("$caso: nada sai, nada é gerado e a campanha não é pausada", async (m) => {
    estado.contato = { ...CONTATO_LIMPO, ...m.contato };
    estado.settings = m.settings ?? {};
    const db = await rodarOTick();

    expect(envios, "a abordagem saiu para quem não podia recebê-la").toHaveLength(0);
    // A guarda roda ANTES da geração: o veto não gasta IA.
    expect(mocks.generate).not.toHaveBeenCalled();
    const pausou = db.query.mock.calls.find(([q]) =>
      String(q).includes("update prospecting_campaigns set status='paused'"),
    );
    expect(pausou, "a campanha foi PAUSADA por causa de um contato").toBeUndefined();
    const falhou = db.query.mock.calls.find(([q]) =>
      String(q).startsWith("update prospecting_candidates set status='failed',error=$3"),
    );
    expect(falhou?.[1]?.[2]).toBe(m.motivo);
  });

  // O veto não pausa mais, então a fila segue; se ele viesse DEPOIS da reserva,
  // cada vetada gastaria uma vaga do teto diário e do aquecimento do número,
  // mais um intervalo inteiro, sem mandar nada.
  it.each(MARCAS)("$caso: a vetada não gasta a vaga do número nem o intervalo", async (m) => {
    estado.contato = { ...CONTATO_LIMPO, ...m.contato };
    estado.settings = m.settings ?? {};
    const db = await rodarOTick();
    const sqls = db.query.mock.calls.map(([q]) => String(q));
    expect(sqls.some((q) => q.includes("status='sending',attempted_at=now()")), "gravou attempted_at").toBe(false);
    expect(sqls.some((q) => q.startsWith("update prospecting_campaigns set next_send_at")), "agendou o intervalo").toBe(
      false,
    );
    expect(recordSend, "reservou a vaga do número").not.toHaveBeenCalled();
    const falhou = db.query.mock.calls.find(([q]) =>
      String(q).startsWith("update prospecting_candidates set status='failed',error=$3"),
    );
    // Ela ainda está `queued` (não houve tentativa): o update é o da fila.
    expect(String(falhou?.[0])).toContain("status='queued'");
  });

  it("leitura das listas falhando antes da vaga: a guarda cheia falha fechada e pausa", async () => {
    estado.erroDaOrganizacao = true;
    const db = await rodarOTick();
    expect(envios).toHaveLength(0);
    const pausou = db.query.mock.calls.find(([q]) =>
      String(q).includes("update prospecting_campaigns set status='paused'"),
    );
    expect(pausou?.[1]?.[2]).toBe("Campanha pausada ou dados indisponíveis.");
  });

  it("controle: contato limpo recebe a abordagem pelo mesmo caminho", async () => {
    const db = await rodarOTick();
    expect(recordSend).toHaveBeenCalledTimes(1);
    expect(envios).toHaveLength(1);
    expect(
      db.query.mock.calls.some(([q]) => String(q).includes("update prospecting_campaigns set status='paused'")),
    ).toBe(false);
  });
});
