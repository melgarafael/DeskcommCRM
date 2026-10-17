import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  send: vi.fn(),
  audit: vi.fn(),
  guard: vi.fn(),
  boundary: vi.fn(),
  preflight: vi.fn(),
  authorize: vi.fn(),
  knobs: vi.fn(),
  open: vi.fn(),
  prospeccaoAberta: vi.fn(),
  pacing: vi.fn(),
  paradas: vi.fn(),
  prepare: vi.fn(),
  preparo: vi.fn(),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.send }));
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
vi.mock("@/lib/prospecting/guard", () => ({ assertProspectingDelivery: mocks.guard }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: mocks.knobs,
  loadPacingState: vi.fn().mockResolvedValue({ sentToday: 0 }),
  recordSend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/agent-engine/pacing/engine", () => ({
  janelaDeEnvioAberta: mocks.open,
  // A prospecção lê o portão próprio (dias + horas, 0642) — o genérico não é
  // mais chamado neste worker. Sem estas duas chaves o import morre e TODOS os
  // casos desta suíte falham com "not a function", não só os de janela.
  janelaDeProspeccaoAberta: mocks.prospeccaoAberta,
  decidePacing: mocks.pacing,
  proximaAberturaDaJanela: () => new Date(Date.now() + 3600000),
  proximaAberturaDaProspeccao: () => new Date(Date.now() + 3600000),
  // O ritmo da esteira fria (`lib/prospecting/ritmo-da-esteira-fria.ts`) deriva
  // o teto diário DESTA função em vez de manter uma tabela de degraus própria.
  // O mock precisa dela, senão o import do worker morre antes de qualquer caso
  // — e a falha aparece como "esperava erro X" em testes que não têm nada a ver.
  warmupCapFor: (_idade: number, degraus: Array<{ minAgeDays: number; cap: number | null }>) => {
    let cap: number | null = degraus[0]?.cap ?? null;
    for (const d of degraus) if (_idade >= d.minAgeDays) cap = d.cap;
    return cap;
  },
}));
vi.mock("@/lib/env", () => ({ env: {} }));
// Só `idsDeOrgsParadas` é dublê: `OrgNaoOperanteError` segue a classe real
// (a Task 26b a usa no `catch` do tick, e `instanceof` exige a mesma classe).
vi.mock("@/lib/organizacao/operante", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizacao/operante")>()),
  idsDeOrgsParadas: mocks.paradas,
}));
vi.mock("@/lib/prospecting/store", () => ({
  withProspectingLock: vi.fn(),
  synchronizeSearch: vi.fn(),
  validateConfig: vi.fn().mockResolvedValue(undefined),
  prepararCandidatoNoEnvio: mocks.prepare,
}));
// O preparo automático (B2) tem a suíte própria em lib/prospecting/preparo.test.ts;
// aqui só se mede QUANDO o tick o chama (ordem, fora do bloqueio, fail-open).
vi.mock("@/lib/prospecting/preparo", () => ({ prepararCandidatos: mocks.preparo }));
import { sendNextCandidate, tickProspecting } from "@/lib/prospecting/worker";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";
import { withProspectingLock } from "@/lib/prospecting/store";
import type { Campaign } from "@/lib/prospecting/store";
const id = "10000000-0000-4000-8000-000000000001";
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
  conversation_id: id,
  message_id: "stable-message",
  phone: "+5511999990000",
  service_boundary: { conversation_id: id },
  data: { name: "Example", socials: [] },
};
function database(
  counts = {
    campaign: 0,
    total: 0,
    retry_at: null as Date | null,
    last_attempt: null as Date | null,
  },
  row: Record<string, unknown> = candidate,
) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("select daily_message_limit"))
        return { rows: [{ daily_message_limit: 50 }] };
      if (sql.includes("count(*) filter")) return { rows: [counts] };
      if (sql.startsWith("select * from prospecting_candidates")) return { rows: [row] };
      if (sql.startsWith("select published_version_id"))
        return { rows: [{ published_version_id: id, operation_revision: 1 }] };
      return { rows: [] };
    }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.knobs.mockResolvedValue({ knobs: {} });
  mocks.open.mockReturnValue(true);
  mocks.prospeccaoAberta.mockReturnValue(true);
  mocks.pacing.mockReturnValue({ allow: true, waitMs: 0 });
  mocks.preflight.mockResolvedValue({ permite: true });
  mocks.guard.mockResolvedValue(undefined);
  mocks.boundary.mockResolvedValue(undefined);
  mocks.generate.mockResolvedValue({
    ok: true,
    texto: "Olá. Posso entender como vocês atendem hoje?",
  });
  mocks.authorize.mockResolvedValue({ ok: true });
  mocks.send.mockResolvedValue({ status: "sent" });
});
describe("gradual outreach", () => {
  it("sends one candidate with stable identity and the mandatory last-moment guard", async () => {
    const db = database();
    await sendNextCandidate({} as never, db as never, {} as never, campaign);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({
      internalMessageId: "stable-message",
      prospectingDelivery: { candidateId: "candidate" },
      agentOperation: { agentId: id },
    });
    expect(mocks.guard).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls.some(([q]) => q.includes("attempted_at=now()"))).toBe(true);
  });
  /*
   * A TRILHA DA ABORDAGEM FRIA (LGPD adjacente).
   *
   * Esta é a única linha do produto que fala PRIMEIRO com quem nunca falou com
   * a empresa. Sem entrada em `api_audit_log`, "por que vocês me escreveram?"
   * não tem resposta: `prospecting_candidates.status` guarda o estado ATUAL e é
   * reescrito no passo seguinte.
   *
   * O par abaixo é o que impede as duas falhas opostas: não auditar o envio, e
   * auditar rodada de cron vazia (a regra do CLAUDE.md — 43.200 linhas/mês numa
   * instalação que não aborda ninguém).
   */
  it("audita a abordagem que SAIU, com os ponteiros e sem PII", async () => {
    await sendNextCandidate({} as never, database() as never, {} as never, campaign);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const entrada = mocks.audit.mock.calls[0]?.[0];
    expect(entrada).toMatchObject({
      action: "prospecting.approach_sent",
      resourceType: "prospecting_candidate",
      resourceId: "candidate",
      metadata: { campaign_id: campaign.id, sent: true },
    });
    const texto = JSON.stringify(entrada);
    expect(texto, "telefone ou texto da mensagem na trilha seria PII a mais").not.toMatch(
      /Posso entender como vocês atendem|\+55/,
    );
  });

  it("NÃO audita quando o tick não abordou ninguém (teto batido)", async () => {
    await sendNextCandidate(
      {} as never,
      database({ campaign: 10, total: 10, retry_at: new Date(), last_attempt: null }) as never,
      {} as never,
      campaign,
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.audit, "rodada sem efeito não é mutação — não audita").not.toHaveBeenCalled();
  });

  it.each([
    { campaign: 10, total: 10 },
    { campaign: 1, total: 50 },
  ])("stops at campaign or organization limit %j", async (counts) => {
    await sendNextCandidate(
      {} as never,
      database({ ...counts, retry_at: new Date(), last_attempt: null }) as never,
      {} as never,
      campaign,
    );
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("pede o ritmo como prospecção: o gate genérico não veta o domingo que os dias próprios liberaram", async () => {
    await sendNextCandidate({} as never, database() as never, {} as never, campaign);
    // Sem a flag, o veto de domingo do gate genérico barra a abordagem que o
    // portão próprio deixou passar: a prospecção de domingo é reagendada para
    // segunda, calada, mesmo com o domingo marcado na caixa da prospecção.
    expect(mocks.pacing).toHaveBeenCalledWith(expect.objectContaining({ prospeccao: true }));
  });
  it("keeps spacing across campaign switches", async () => {
    await sendNextCandidate(
      {} as never,
      database({ campaign: 0, total: 1, retry_at: null, last_attempt: new Date() }) as never,
      {} as never,
      campaign,
    );
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("stops outside the configured window", async () => {
    mocks.prospeccaoAberta.mockReturnValue(false);
    const db = database();
    await sendNextCandidate({} as never, db as never, {} as never, campaign);
    expect(mocks.send).not.toHaveBeenCalled();
    // Sem tentativa e sem trilha: reagendou para a próxima abertura e voltou.
    expect(
      db.query.mock.calls.some(
        ([q]) => q.includes("update prospecting_campaigns set next_send_at=$3"),
      ),
    ).toBe(true);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("fails closed when channel settings cannot be read", async () => {
    mocks.knobs.mockRejectedValue(new Error("database unavailable"));
    await expect(
      sendNextCandidate({} as never, database() as never, {} as never, campaign),
    ).rejects.toThrow();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("does not send when campaign pauses while the model generates", async () => {
    mocks.guard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("paused"));
    await expect(
      sendNextCandidate({} as never, database() as never, {} as never, campaign),
    ).rejects.toThrow("paused");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("does not bypass channel pre-go-live restrictions", async () => {
    mocks.preflight.mockResolvedValue({ permite: false, motivo: "restricted" });
    await expect(
      sendNextCandidate({} as never, database() as never, {} as never, campaign),
    ).rejects.toThrow("restricted");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("records uncertain sends as failures without retrying", async () => {
    mocks.send.mockResolvedValue({ status: "queued" });
    const db = database();
    await sendNextCandidate({} as never, db as never, {} as never, campaign);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(
      db.query.mock.calls.some(([q]) => q.startsWith("update messages set status='failed'")),
    ).toBe(true);
  });
});

describe("tick da prospecção × organização parada", () => {
  it("exclui as paradas NO SQL, via fn_org_operante, antes do limit — sem lista de ids na query (issue #2015)", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    await tickProspecting({ query } as never, {} as never);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toMatch(/fn_org_operante/);
    expect(sql.indexOf("fn_org_operante")).toBeLessThan(sql.indexOf("limit 20"));
    // Nenhuma lista de ids de org parada é carregada nem passada à query — a
    // régua SQL decide no banco, e a query não cortaria em `max_rows`.
    expect(sql).not.toMatch(/organization_id <> all/);
    expect(params ?? []).toEqual([]);
  });

  it("a consulta de organizações do tick (a de campanhas rodando) não mexe em data->'site'", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    await tickProspecting({ query } as never, {} as never);
    const [sql] = query.mock.calls[0]!;
    // O portão do BLOCO COM BLOQUEIO continua só com quem roda busca/campanha. A
    // verificação de site e a prévia (B2) saem por `prepararCandidatos`, fora do
    // bloqueio, e as organizações só-rascunho vêm de uma SEGUNDA consulta.
    expect(sql).not.toMatch(/data->'site'/);
    expect(sql).toMatch(/status='running'/);
  });
});

describe("tick da prospecção × organização que para no meio do envio", () => {
  function tickComEnvioQueFalha(erro: Error) {
    mocks.paradas.mockResolvedValue([]);
    mocks.send.mockRejectedValueOnce(erro);
    const base = database();
    const db = {
      query: vi.fn(async (sql: string) =>
        sql.startsWith("select * from prospecting_campaigns where organization_id=$1 and status='running'")
          ? { rows: [campaign] }
          : base.query(sql),
      ),
    };
    (withProspectingLock as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_pool: unknown, _org: unknown, fn: (d: unknown) => Promise<unknown>) => fn(db),
    );
    const pool = { query: vi.fn(async () => ({ rows: [{ organization_id: id }] })) };
    return { db, rodar: () => tickProspecting(pool as never, {} as never) };
  }
  const gravou = (db: { query: ReturnType<typeof vi.fn> }, trecho: string) =>
    db.query.mock.calls.some(([sql]) => String(sql).includes(trecho));

  it("OrgNaoOperanteError no envio NÃO pausa a campanha nem queima o candidato: ele volta à fila", async () => {
    const { db, rodar } = tickComEnvioQueFalha(new OrgNaoOperanteError(id, "suspended"));
    await rodar();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(gravou(db, "status='paused'")).toBe(false);
    expect(gravou(db, "update prospecting_candidates set status='failed',error=$3")).toBe(false);
    expect(gravou(db, "update prospecting_candidates set status='queued'")).toBe(true);
  });

  it("controle: falha inesperada do envio continua pausando a campanha e marcando o candidato failed", async () => {
    const { db, rodar } = tickComEnvioQueFalha(new Error("provedor fora do ar"));
    await rodar();
    expect(gravou(db, "status='paused'")).toBe(true);
    expect(gravou(db, "update prospecting_candidates set status='failed',error=$3")).toBe(true);
  });
});

describe("funil só no envio (`funnel_entry: on_send`)", () => {
  const noEnvio = {
    ...campaign,
    config: { ...campaign.config, funnel_entry: "on_send" },
  } as Campaign;
  /** A empresa está na fila, mas ainda não existe no CRM: sem conversa, contato nem fronteira. */
  const naFila = {
    id: "candidate",
    contact_id: null,
    lead_id: null,
    conversation_id: null,
    service_boundary: null,
    message_id: "stable-message",
    phone: "+5511999990000",
    data: { name: "Example", socials: [] },
  };

  it("prepara a empresa ANTES de gerar e enviar, e envia com os dados que a preparação criou", async () => {
    mocks.prepare.mockResolvedValue(candidate);
    const db = database(undefined, naFila);
    await sendNextCandidate({} as never, db as never, {} as never, noEnvio);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.prepare.mock.calls[0]?.[4]).toMatchObject({
      id: "candidate",
      conversation_id: null,
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const antes = mocks.prepare.mock.invocationCallOrder[0] ?? Infinity;
    expect(antes, "criar a pegada vem antes do envio").toBeLessThan(
      mocks.send.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.send.mock.calls[0]?.[2]).toMatchObject({ conversation_id: id });
  });

  it("empresa que saiu da fila no caminho (pulada ou recusada pelo CRM): não gera, não envia, não grava tentativa", async () => {
    mocks.prepare.mockResolvedValue(null);
    const db = database(undefined, naFila);
    await sendNextCandidate({} as never, db as never, {} as never, noEnvio);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(
      db.query.mock.calls.some(([q]) => String(q).includes("attempted_at=now()")),
      "sem tentativa: a próxima rodada pega a seguinte",
    ).toBe(false);
  });

  it("empresa que já tem conversa não é preparada de novo", async () => {
    const db = database(undefined, candidate);
    await sendNextCandidate({} as never, db as never, {} as never, noEnvio);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("no modo `on_start` (o padrão) a preparação nunca roda, nem para quem estiver sem conversa", async () => {
    const db = database(undefined, naFila);
    await expect(
      sendNextCandidate({} as never, db as never, {} as never, campaign),
    ).rejects.toMatchObject({ escopo: "candidato" });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("funil só no envio: a checagem do canal vem ANTES de criar qualquer coisa", () => {
  const noEnvio = {
    ...campaign,
    config: { ...campaign.config, funnel_entry: "on_send" },
  } as Campaign;
  const naFila = {
    id: "candidate",
    contact_id: null,
    lead_id: null,
    conversation_id: null,
    service_boundary: null,
    message_id: "stable-message",
    phone: "+5511999990000",
    data: { name: "Example", socials: [] },
  };

  it("canal que recusa a abordagem: a campanha pausa SEM ter deixado contato, negócio nem conversa", async () => {
    mocks.preflight.mockResolvedValue({ permite: false, motivo: "telefone fora da lista liberada" });
    const db = database(undefined, naFila);
    await expect(
      sendNextCandidate({} as never, db as never, {} as never, noEnvio),
    ).rejects.toThrow("O canal ainda não permite esta abordagem");
    expect(mocks.prepare, "recusa do canal vem antes de qualquer criação").not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("a checagem usa o telefone da empresa que ainda está só na fila", async () => {
    mocks.prepare.mockResolvedValue(candidate);
    await sendNextCandidate({} as never, database(undefined, naFila) as never, {} as never, noEnvio);
    expect(mocks.preflight.mock.calls[0]?.[1]).toMatchObject({
      contactPhoneNumber: "+5511999990000",
    });
    const checagem = mocks.preflight.mock.invocationCallOrder[0] ?? Infinity;
    expect(checagem).toBeLessThan(mocks.prepare.mock.invocationCallOrder[0] ?? 0);
  });
});

/**
 * A PROVA EM PAR DA PRÉVIA (B1, `docs/doctrine/prova-em-par.md`).
 *
 * A tela gera a prévia com a estratégia e a guarda no candidato. Se o ENVIO não
 * levar a MESMA estratégia e o MESMO rascunho, o par se rompe: a pessoa revisa
 * um texto e o tick manda outro, e nenhum dos dois lados acusa sozinho. Aqui
 * mede-se o lado da ferramenta (o worker) com o mesmo candidato que a tela
 * (caso C, `route.test.ts`) mede do outro lado.
 */
describe("a abordagem fria leva a estratégia e a prévia guardada (par com a tela)", () => {
  const comPrevia = {
    ...candidate,
    data: {
      name: "Example",
      website: null,
      site: null,
      socials: [],
      previa: {
        texto: "Rascunho guardado pela tela",
        baseada_em: "sem-site@derivado",
        gerada_em: "2026-10-11T09:00:00.000Z",
        // O MESMO agente da campanha: a prévia de outro agente não é aproveitada.
        agente_id: id,
      },
    },
  };

  it("F) a prévia escrita por OUTRO agente (o padrão) não vai: o envio escreve do zero", async () => {
    const deOutro = {
      ...comPrevia,
      data: {
        ...comPrevia.data,
        previa: { ...comPrevia.data.previa, agente_id: "11111111-1111-4111-8111-111111111111" },
      },
    };
    await sendNextCandidate({} as never, database(undefined, deOutro) as never, {} as never, campaign);
    const args = mocks.generate.mock.calls[0]![2] as { dados: Record<string, string> };
    expect(args.dados["Rascunho de abordagem"]).toBeUndefined();
  });

  it("F) passa a estratégia na instrução e o rascunho nos dados", async () => {
    await sendNextCandidate({} as never, database(undefined, comPrevia) as never, {} as never, campaign);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    const args = mocks.generate.mock.calls[0]![2] as {
      instrucao: string;
      dados: Record<string, string>;
    };
    expect(args.dados["Rascunho de abordagem"]).toBe("Rascunho guardado pela tela");
    // A mesma estratégia que a tela mostra ("Sem site", sem-site derivado).
    expect(args.instrucao).toContain("Sem site");
    expect(args.instrucao).toContain("Estratégia");
  });

  it("F) sem prévia guardada o rascunho não vai — mas a estratégia continua indo", async () => {
    await sendNextCandidate({} as never, database() as never, {} as never, campaign);
    const args = mocks.generate.mock.calls[0]![2] as {
      instrucao: string;
      dados: Record<string, string>;
    };
    expect(args.dados["Rascunho de abordagem"]).toBeUndefined();
    expect(args.instrucao).toContain("Sem site");
  });
});

describe("tick × preparo automático (B2)", () => {
  const ORG_A = "10000000-0000-4000-8000-00000000000a";
  const ORG_B = "10000000-0000-4000-8000-00000000000b";
  type Corpo = (d: unknown) => Promise<unknown>;

  function montar(opts: { segundaConsulta?: string[]; preparoFalhaEm?: string } = {}) {
    mocks.paradas.mockResolvedValue([]);
    const ordem: string[] = [];
    const base = database();
    const db = {
      query: vi.fn(async (sql: string) =>
        sql.startsWith("select * from prospecting_campaigns where organization_id=$1 and status='running'")
          ? { rows: [campaign] }
          : base.query(sql),
      ),
    };
    (withProspectingLock as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_pool: unknown, org: string, fn: Corpo) => {
        ordem.push(`bloqueio:${org}`);
        const r = await fn(db);
        ordem.push(`fim-bloqueio:${org}`);
        return r;
      },
    );
    mocks.preparo.mockImplementation(async (_p: unknown, _a: unknown, org: string) => {
      ordem.push(`preparo:${org}`);
      if (org === opts.preparoFalhaEm) throw new Error("preparo caiu");
      return { sites: 0, previas: 0, pulou: false };
    });
    const sqls: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        sqls.push(sql);
        if (sql.includes("'draft'"))
          return { rows: (opts.segundaConsulta ?? []).map((organization_id) => ({ organization_id })) };
        return { rows: [{ organization_id: ORG_A }] };
      }),
    };
    return { pool, ordem, sqls, db };
  }

  it("organização só com campanha em rascunho/pausada e pendência entra na rodada (só no preparo)", async () => {
    const { pool, ordem } = montar({ segundaConsulta: [ORG_B] });
    await tickProspecting(pool as never, {} as never);
    expect(ordem).toContain(`preparo:${ORG_B}`);
    // Nada do bloco com bloqueio (busca, abordagem) para quem não roda campanha.
    expect(ordem).not.toContain(`bloqueio:${ORG_B}`);
  });

  it("a segunda consulta é barata, filtra operante e limita 20, e a primeira ficou como era", async () => {
    const { pool, sqls } = montar({ segundaConsulta: [ORG_B] });
    await tickProspecting(pool as never, {} as never);
    expect(sqls).toHaveLength(2);
    expect(sqls[0]).toMatch(/pc\.status='running' or pc\.search_status in \('starting','running'\)/);
    expect(sqls[0]).not.toContain("'draft'");
    const segunda = sqls[1]!;
    expect(segunda).toContain("'draft','paused'");
    expect(segunda).toContain("fn_org_operante");
    expect(segunda).toMatch(/limit 20/);
    expect(segunda).toContain("exists");
    expect(segunda).toContain("selected is not false");
    expect(segunda).toContain("data->'previa' is null");
  });

  it("une as duas listas sem duplicar: a mesma organização é preparada uma vez", async () => {
    const { pool, ordem } = montar({ segundaConsulta: [ORG_A, ORG_B] });
    await tickProspecting(pool as never, {} as never);
    expect(ordem.filter((x) => x === `preparo:${ORG_A}`)).toHaveLength(1);
    expect(ordem.filter((x) => x === `bloqueio:${ORG_A}`)).toHaveLength(1);
  });

  it("o preparo roda DEPOIS e FORA do bloqueio da organização", async () => {
    const { pool, ordem } = montar();
    await tickProspecting(pool as never, {} as never);
    const fim = ordem.indexOf(`fim-bloqueio:${ORG_A}`);
    const preparo = ordem.indexOf(`preparo:${ORG_A}`);
    expect(fim).toBeGreaterThanOrEqual(0);
    expect(preparo).toBeGreaterThan(fim);
  });

  it("o preparo nunca atrasa o envio de ninguém: todos os blocos com bloqueio rodam antes dos preparos", async () => {
    const { pool, ordem } = montar({ segundaConsulta: [ORG_B] });
    await tickProspecting(pool as never, {} as never);
    const ultimoBloqueio = ordem.lastIndexOf(`fim-bloqueio:${ORG_A}`);
    const primeiroPreparo = ordem.findIndex((x) => x.startsWith("preparo:"));
    expect(ultimoBloqueio).toBeLessThan(primeiroPreparo);
  });

  it("recebe o resto do prazo, no máximo 100 s por organização, e um requestId", async () => {
    const { pool } = montar();
    const antes = Date.now();
    await tickProspecting(pool as never, {} as never);
    const [, , org, requestId, deadline] = mocks.preparo.mock.calls[0]!;
    expect(org).toBe(ORG_A);
    expect(typeof requestId).toBe("string");
    expect(deadline).toBeGreaterThan(antes);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 100_000);
  });

  it("falha do preparo não impede o envio nem as outras organizações", async () => {
    const { pool, ordem } = montar({ segundaConsulta: [ORG_B], preparoFalhaEm: ORG_A });
    mocks.send.mockResolvedValue({ status: "sent" });
    await expect(tickProspecting(pool as never, {} as never)).resolves.toBeDefined();
    expect(mocks.send).toHaveBeenCalledTimes(1); // sendNextCandidate rodou
    expect(ordem).toContain(`preparo:${ORG_B}`); // e a outra organização seguiu
  });

  it("falha da SEGUNDA consulta não derruba a rodada das organizações que já rodam", async () => {
    const { pool, ordem } = montar();
    const original = pool.query.getMockImplementation()!;
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("'draft'")) throw new Error("consulta caiu");
      return original(sql);
    });
    await expect(tickProspecting(pool as never, {} as never)).resolves.toBeDefined();
    expect(ordem).toContain(`bloqueio:${ORG_A}`);
    expect(ordem).toContain(`preparo:${ORG_A}`);
  });
});
