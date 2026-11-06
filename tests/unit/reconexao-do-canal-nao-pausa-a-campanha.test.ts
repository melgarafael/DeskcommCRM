import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A RECONEXÃO DE SEGUNDOS DO CANAL NÃO PODE PAUSAR A CAMPANHA (issue #3073).
 *
 * O QUE FOI MEDIDO no relato: a sessão caiu às 08:14:57 e voltou em SEGUNDOS;
 * às 08:15:00 a campanha `ef62da12` foi para `paused` com a mensagem de
 * configuração ("escolha uma conexão ativa que permita iniciar conversas..."),
 * a sessão voltou a `WORKING`, a campanha não — e o dia de envio seguinte foi
 * perdido até alguém notar.
 *
 * O CAMINHO: `sendNextCandidate` valida a configuração ANTES de qualquer envio
 * (`worker.ts:65`), e a validação do canal (`store.ts`) recusava com o MESMO
 * `status !== "WORKING"` três situações muito diferentes — canal arquivado,
 * canal sem a capability de texto livre e canal reconectando — todas no escopo
 * `campanha`, que é o escopo que o tick lê para PAUSAR a fila
 * (`worker.ts`: o `else` do `doCandidato` grava `status='paused'`).
 *
 * POR QUE O TICK, e não a função isolada: é no tick que "pausar a campanha" tem
 * consequência observável — o SQL que o caminho pediu é a prova, como em
 * `prospeccao-bolhas-com-guarda-real.test.ts`. Aqui a validação do canal NÃO é
 * dublada (o módulo de store é carregado de verdade, com só o lock e a
 * preparação de candidato substituídos): um dublê de `validateConfig` faria o
 * caso passar verde nos dois mundos e não provaria nada.
 *
 * O ESTADO TRANSITÓRIO é `STARTING` — medido, não escolhido: é o estado que a
 * linha assume no instante da queda e o que a tela rotula "Conectando…"
 * (`lib/channels/estado.ts`). `STOPPED` entra junto (o vigia religa sozinho,
 * `deveRetomarSessao`). `SCAN_QR_CODE` e `FAILED` são as ESCALADAS — alguém
 * precisa ler o QR no celular, ou o número caiu de vez — e continuam pausando.
 */
const id = "10000000-0000-4000-8000-000000000001";
const ESTAGIO = "10000000-0000-4000-8000-000000000002";
const CONVERSA = id;
const AGENTE = id;

/** O estado que a guarda lê — e que o envio da bolha anterior altera. */
const estado = {
  conversation: {
    status: "open",
    last_inbound_at: null as string | null,
    last_outbound_at: null as string | null,
    assigned_to_user_id: null as string | null,
    bot_silenced_until: null as string | null,
  },
};

/** O que de fato saiu pelo canal, na ordem. */
const envios: string[] = [];
/** Todo SQL que o caminho pediu — é onde se vê a campanha sendo pausada. */
const sqls: string[] = [];
/** O status que `channel_sessions` devolve nesta rodada (`null` = linha ausente). */
let statusDoCanal: string | null = "WORKING";
/** O provider da linha do canal (a matriz de capabilities é real e decide). */
let providerDoCanal: string = CHANNEL_PROVIDER_WAHA;

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  audit: vi.fn(),
  boundary: vi.fn(),
  preflight: vi.fn(),
  authorize: vi.fn(),
  knobs: vi.fn(),
  open: vi.fn(),
  paradas: vi.fn(),
  prepare: vi.fn(),
  router: vi.fn(),
  agentePublicado: vi.fn(),
}));

vi.mock("@/app/api/v1/messages/_handler", async () => {
  // A guarda REAL, importada de propósito: o dublê do handler a chama como o
  // handler de verdade chama, e é ela que carimba a conversa depois do envio.
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
// O ROTEADOR e o AGENTE PUBLICADO são vizinhos do canal na mesma validação: o
// que este arquivo mede é a checagem DO CANAL, então só eles são substituídos.
vi.mock("@/lib/agent-engine/agent/router-config", () => ({ loadActiveRouter: mocks.router }));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({
  loadPublishedAgentConfig: mocks.agentePublicado,
}));
// `validateConfig` fica REAL (é ele que decide a pausa); só o lock da sessão e
// a preparação do candidato são substituídos, como no teste vizinho.
vi.mock("@/lib/prospecting/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prospecting/store")>()),
  withProspectingLock: vi.fn(),
  prepararCandidatoNoEnvio: mocks.prepare,
}));

import { CHANNEL_PROVIDER_META, CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";
import { CanalReconectandoError, ProspectingError } from "@/lib/prospecting/provider";
import {
  MSG_CANAL_DESCONECTADO,
  MSG_CANAL_RECONECTANDO,
  validateConfig,
  withProspectingLock,
} from "@/lib/prospecting/store";
import type { Campaign } from "@/lib/prospecting/store";
import { TETO_DO_ADIAMENTO_MS, tickProspecting } from "@/lib/prospecting/worker";

/** O cliente Supabase que a guarda REAL enxerga (cadeia tolerante). */
function clienteDoSupa() {
  const linhas: Record<string, unknown> = {
    prospecting_candidates: {
      campaign_id: id,
      contact_id: id,
      status: "sending",
      conversation_id: CONVERSA,
    },
    prospecting_campaigns: { status: "running" },
    contacts: {
      is_blocked: false,
      force_human: false,
      is_anonymized: false,
      source: "prospecting",
      consent: { legitimate_interest: { ref: "LIA-example" } },
    },
  };
  return {
    from(table: string) {
      const consulta = {
        select: () => consulta,
        eq: () => consulta,
        maybeSingle: async () => ({
          data: table === "conversations" ? estado.conversation : (linhas[table] ?? null),
          error: null,
        }),
      };
      return consulta;
    },
  };
}

const campaign = {
  id,
  organization_id: id,
  next_send_at: new Date(0),
  channel_down_since: null as Date | null,
  config: {
    agent_id: AGENTE,
    channel_session_id: id,
    pipeline_id: id,
    stage_id: id,
    qualified_stage_id: ESTAGIO,
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

const textoDoModelo =
  "Olá! Somos a Acme e ajudamos lojas como a de vocês a vender mais.\n\n" +
  "Queria entender como vocês atendem hoje.";

/** O banco do tick e do envio. Toda query entra em `sqls`, com os params. */
function banco() {
  return {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      sqls.push(sql);
      if (
        sql.startsWith(
          "select * from prospecting_campaigns where organization_id=$1 and status='running'",
        )
      )
        return { rows: [campaign] };
      if (sql.startsWith("select daily_message_limit")) return { rows: [{ daily_message_limit: 50 }] };
      if (sql.includes("count(*) filter"))
        return { rows: [{ campaign: 0, total: 0, retry_at: null, last_attempt: null }] };
      if (sql.startsWith("select * from prospecting_candidates")) return { rows: [candidate] };
      if (sql.startsWith("select locale from organizations")) return { rows: [{ locale: "pt-BR" }] };
      if (/^select (a\.)?published_version_id/.test(sql))
        return {
          rows: [
            {
              published_version_id: id,
              operation_revision: 1,
              split_messages: true,
              split_max_chars: 60,
            },
          ],
        };
      // ── A VALIDAÇÃO DE VERDADE, que este arquivo exercita ponta a ponta ──
      if (sql.startsWith("select v.tool_ids,v.pipeline_ids from ai_agents a"))
        return { rows: [{ tool_ids: ["crm_move_lead_stage"], pipeline_ids: [id] }] };
      if (sql.startsWith("select provider,status from channel_sessions"))
        return {
          rows: statusDoCanal === null ? [] : [{ provider: providerDoCanal, status: statusDoCanal }],
        };
      if (sql.includes("from crm_stages")) return { rows: [{ id }, { id: ESTAGIO }] };
      return { rows: [] };
    }),
  };
}

/** Roda o TICK inteiro: é nele que "pausar a campanha" deixa rastro no SQL. */
async function rodarOTick() {
  const db = banco();
  (withProspectingLock as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (_pool: unknown, _org: unknown, fn: (d: unknown) => Promise<unknown>) => fn(db),
  );
  const pool = { query: vi.fn(async () => ({ rows: [{ organization_id: id }] })) };
  await tickProspecting(pool as never, clienteDoSupa() as never);
  return db;
}

type Banco = ReturnType<typeof banco>;
/** Os params da primeira SQL do caminho que casa o trecho, ou `null`. */
function paramsDa(db: Banco, trecho: string): unknown[] | null {
  const chamada = db.query.mock.calls.find(([q]) => String(q).includes(trecho));
  return chamada?.[1] ?? null;
}

/**
 * Aplica à `campaign` o que os `update prospecting_campaigns` do tick gravaram em
 * `channel_down_since`, NA ORDEM: é o que faz a próxima rodada ler a marca que a
 * anterior deixou. A semântica é a do Postgres — `coalesce(...)` só preenche o
 * nulo, `now()` sobrescreve, `null` zera. Escrita em forma desconhecida reprova,
 * em vez de passar calada como "não mexeu".
 */
function aplicarAsEscritasNaCampanha(db: Banco) {
  for (const [q] of db.query.mock.calls) {
    const sql = String(q);
    if (!sql.startsWith("update prospecting_campaigns set") || !sql.includes("channel_down_since="))
      continue;
    if (sql.includes("channel_down_since=coalesce(channel_down_since,now())"))
      campaign.channel_down_since ??= new Date();
    else if (sql.includes("channel_down_since=now()")) campaign.channel_down_since = new Date();
    else if (sql.includes("channel_down_since=null")) campaign.channel_down_since = null;
    else throw new Error(`escrita de channel_down_since que o dublê não conhece: ${sql}`);
  }
}

/** A mensagem gravada quando a campanha é PAUSADA, ou `null` se ela seguiu. */
function motivoDaPausa(db: Banco): unknown {
  return paramsDa(db, "update prospecting_campaigns set status='paused'")?.[2] ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  statusDoCanal = "WORKING";
  providerDoCanal = CHANNEL_PROVIDER_WAHA;
  estado.conversation = {
    status: "open",
    last_inbound_at: null,
    last_outbound_at: null,
    assigned_to_user_id: null,
    bot_silenced_until: null,
  };
  envios.length = 0;
  sqls.length = 0;
  // A espera pela reconexão começa zerada em todo caso: quem mede o TETO é o
  // `channel_down_since`, e um resíduo do caso anterior mudaria a régua.
  campaign.channel_down_since = null;
  campaign.next_send_at = new Date(0);
  mocks.knobs.mockResolvedValue({ knobs: {} });
  mocks.open.mockReturnValue(true);
  mocks.preflight.mockResolvedValue({ permite: true });
  mocks.boundary.mockResolvedValue(undefined);
  mocks.authorize.mockResolvedValue({ ok: true });
  mocks.paradas.mockResolvedValue([]);
  mocks.router.mockResolvedValue(null);
  mocks.agentePublicado.mockResolvedValue({ agentId: AGENTE });
  mocks.generate.mockResolvedValue({ ok: true, texto: textoDoModelo });
});

describe("a reconexão de segundos não pausa a campanha (issue #3073)", () => {
  it("canal reconectando (`STARTING`): a campanha NÃO é pausada e o envio é ADIADO", async () => {
    statusDoCanal = "STARTING";
    const db = await rodarOTick();

    // O DEFEITO, no SQL: com o canal fora de `WORKING`, o tick pausava a fila
    // inteira com a mensagem de configuração. Aqui não pode haver pausa nenhuma.
    expect(
      motivoDaPausa(db),
      "a campanha foi PAUSADA porque a conexão reconectou por instantes",
    ).toBeNull();

    // O envio é ADIADO pelo mecanismo que o tick já usa (`next_send_at`), com a
    // retomada curta: a sessão volta em segundos.
    const adiado = paramsDa(db, "channel_down_since=coalesce(channel_down_since,now())");
    expect(adiado, "o envio não foi adiado — a rodada tentaria de novo a cada tick").not.toBeNull();
    const retomarEm = adiado?.[2];
    expect(retomarEm, "o adiamento não gravou um instante de retomada").toBeInstanceOf(Date);
    expect((retomarEm as Date).getTime()).toBeGreaterThan(Date.now());

    // O ADIAMENTO NÃO REINICIA O RELÓGIO: ele grava o "desde quando" só na
    // PRIMEIRA vez (`coalesce(channel_down_since, now())`). É o que faz o TETO
    // medir a espera INTEIRA, e não o último tick — sem isto, um canal que
    // alterna `STARTING`↔`STOPPED` reiniciaria a contagem a cada volta e nunca
    // chegaria ao teto.
    const adiamento = db.query.mock.calls.find(([q]) =>
      String(q).includes("channel_down_since=coalesce(channel_down_since,now())"),
    )?.[0];
    expect(String(adiamento), "o adiamento reinicia o relógio do TETO a cada tick").toContain(
      "channel_down_since=coalesce(channel_down_since,now())",
    );

    // Nada saiu, nenhum candidato foi tentado e nenhum foi queimado: a checagem
    // do canal vem ANTES de `attempted_at`, então a lista não perdeu nada.
    expect(envios, "nenhuma bolha deveria sair com a conexão fora do ar").toHaveLength(0);
    // A varredura de housekeeping do tick marca `failed` o candidato PRESO em
    // `sending` — é outra SQL, e ela roda em toda rodada. O que não pode existir
    // é a marcação do candidato DESTA campanha, que é o rastro de uma tentativa
    // interrompida: com o canal fora do ar nada foi tentado.
    expect(
      paramsDa(db, "campaign_id=$2 and status='sending'"),
      "a rodada marcou o candidato desta campanha como falho por causa do canal",
    ).toBeNull();
    expect(mocks.audit, "a rodada auditou um envio que não houve").not.toHaveBeenCalled();
  });

  it("controle: canal ARQUIVADO (linha ausente) continua pausando com o motivo próprio", async () => {
    statusDoCanal = null;
    const db = await rodarOTick();

    expect(motivoDaPausa(db), "o canal arquivado deixou de pausar a campanha").toBe(
      "A conexão escolhida não existe nesta organização ou foi arquivada. Escolha uma conexão ativa para esta campanha.",
    );
    expect(envios).toHaveLength(0);
  });

  it("controle: canal que exige modelo aprovado continua pausando com o motivo próprio", async () => {
    statusDoCanal = "WORKING";
    providerDoCanal = CHANNEL_PROVIDER_META;
    const db = await rodarOTick();

    expect(motivoDaPausa(db), "o canal sem a capability deixou de pausar a campanha").toBe(
      "Esta conexão exige modelo aprovado e ainda não participa desta campanha. Escolha uma conexão que permita iniciar conversas de texto.",
    );
    expect(envios).toHaveLength(0);
  });

  it("controle: canal desconectado que NÃO volta sozinho (`FAILED`) pausa com o motivo de conexão", async () => {
    statusDoCanal = "FAILED";
    const db = await rodarOTick();

    expect(motivoDaPausa(db), "o canal caído de vez deixou de pausar a campanha").toBe(
      "A conexão de saída está desconectada e precisa ser reconectada antes de a campanha continuar.",
    );
    expect(envios).toHaveLength(0);
  });

  it("controle: canal em `WORKING` envia normalmente (o caminho feliz não regrediu)", async () => {
    const db = await rodarOTick();

    expect(motivoDaPausa(db), "a campanha foi pausada com o canal em WORKING").toBeNull();
    expect(paramsDa(db, "channel_down_since=coalesce(channel_down_since,now())"), "o envio foi adiado sem motivo").toBeNull();
    expect(envios.length, "nenhuma bolha saiu com o canal em WORKING").toBeGreaterThan(0);
    expect(mocks.audit.mock.calls[0]?.[0]).toMatchObject({ action: "prospecting.approach_sent" });
  });

  // ── O TETO DO ADIAMENTO (issue #3073) ────────────────────────────────────────
  // O adiamento NÃO pode ser infinito: uma sessão presa fora do `WORKING` deixava
  // a campanha "Ativa" sem enviar e SEM aviso (o `STARTING` não gera aviso de
  // saúde). Passado o teto — contado desde o primeiro adiamento da espera
  // (`channel_down_since`) — a espera vira a recusa de canal DESCONECTADO e a
  // campanha pausa, com o motivo no cartão.

  it("abaixo do teto: a espera segue e NÃO pausa (o teto não regride para o defeito)", async () => {
    statusDoCanal = "STARTING";
    // 5 minutos de espera — bem dentro dos 30 de `TETO_DO_ADIAMENTO_MS`.
    campaign.channel_down_since = new Date(Date.now() - 5 * 60_000);
    const db = await rodarOTick();

    expect(motivoDaPausa(db), "pausou ANTES do teto — é o defeito de novo").toBeNull();
    expect(paramsDa(db, "channel_down_since=coalesce(channel_down_since,now())"), "não adiou com o canal fora do ar").not.toBeNull();
  });

  it("⭐ `STARTING` fora do `WORKING` há 2h: a campanha PAUSA (teto vencido)", async () => {
    statusDoCanal = "STARTING";
    campaign.channel_down_since = new Date(Date.now() - 2 * 3_600_000);
    const db = await rodarOTick();

    expect(
      motivoDaPausa(db),
      "a espera passou do teto e a campanha continuou ativa sem enviar",
    ).toBe(MSG_CANAL_DESCONECTADO);
    // Não adianta mais: a rodada terminou em PAUSA, e a marca do adiamento sai
    // junto para a próxima espera começar do zero.
    expect(paramsDa(db, "channel_down_since=coalesce(channel_down_since,now())"), "pausou pelo teto mas ainda adiou").toBeNull();
    expect(envios).toHaveLength(0);
  });

  it("⭐ o ciclo `STARTING`→`STOPPED`→`STARTING` ao longo de 2h: a espera ACUMULA e pausa só no teto", async () => {
    // O relógio do TETO não é o do canal: `channel_sessions.last_status_change_at`
    // é regravado a cada evento, então o ciclo reiniciaria a contagem a cada
    // volta. A espera tem de ACUMULAR de um tick para o outro — por isso este
    // caso guarda a marca entre as rodadas: o dublê aplica a semântica do SET
    // que o tick pediu, e o tick seguinte lê o resultado. Conferir o TEXTO do
    // SQL não prova o acúmulo; percorrer as 2h prova.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const inicio = new Date("2026-10-22T12:00:00Z").getTime();
      let pausouNoMinuto: number | null = null;
      let motivo: unknown = null;
      for (let minuto = 0; minuto <= 120; minuto += 10) {
        vi.setSystemTime(inicio + minuto * 60_000);
        statusDoCanal = (minuto / 10) % 2 === 0 ? "STARTING" : "STOPPED";
        const db = await rodarOTick();
        aplicarAsEscritasNaCampanha(db);
        motivo = motivoDaPausa(db);
        if (motivo !== null) {
          pausouNoMinuto = minuto;
          break;
        }
      }

      expect(
        pausouNoMinuto,
        "a espera nunca chegou ao teto em 2h — o adiamento está reiniciando o relógio",
      ).not.toBeNull();
      expect(
        pausouNoMinuto,
        "a campanha pausou ANTES do teto (ou depois dele) com o canal só reconectando",
      ).toBe(TETO_DO_ADIAMENTO_MS / 60_000);
      expect(motivo).toBe(MSG_CANAL_DESCONECTADO);
      // A pausa zera a marca: a próxima espera, depois de "Retomar fila", conta do zero.
      expect(campaign.channel_down_since).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("o canal volta a `WORKING`: a espera ZERA (senão envelheceria e pausaria depois)", async () => {
    statusDoCanal = "WORKING";
    campaign.channel_down_since = new Date(Date.now() - 5 * 60_000);
    const db = await rodarOTick();

    expect(motivoDaPausa(db), "pausou com o canal de volta no ar").toBeNull();
    expect(
      paramsDa(db, "set channel_down_since=null"),
      "o canal voltou a WORKING e a marca da espera não foi limpa",
    ).not.toBeNull();
  });
});

describe("a frase da ativação e da retomada é uma só (issue #3073)", () => {
  /**
   * A ativação (`activateCampaign`) e a retomada (`POST /api/v1/prospecting`,
   * ação `resume`) recusam pela MESMA `validateConfig`, então a tela dos dois
   * caminhos recebe a MESMA mensagem. A frase antiga ("o envio sai quando ela
   * voltar") era FALSA ali: a ativação/retomada foi recusada e nada sai sozinho.
   */
  it("`validateConfig` recusa a reconexão com a frase que vale na ativação E na retomada", async () => {
    statusDoCanal = "STARTING";
    providerDoCanal = CHANNEL_PROVIDER_WAHA;
    const erro = await validateConfig(banco() as never, id, campaign.config!).then(
      () => null,
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(CanalReconectandoError);
    expect((erro as ProspectingError).message).toBe(MSG_CANAL_RECONECTANDO);
    expect((erro as ProspectingError).message).toContain("Tente de novo em instantes");
    // A promessa falsa saiu: quem foi recusado não vê "o envio sai quando ela voltar".
    expect((erro as ProspectingError).message).not.toContain("o envio sai quando ela voltar");
  });

  it("o teto é 30 minutos e o adiamento curto (1 min) segue curto", async () => {
    expect(TETO_DO_ADIAMENTO_MS).toBe(30 * 60_000);
    expect(new CanalReconectandoError(MSG_CANAL_RECONECTANDO).retomarEmMs).toBe(60_000);
  });
});

describe("a checagem do canal separa os três motivos (store.validateConfig)", () => {
  /** A recusa (ou o sucesso) da validação de verdade, com o canal do cenário. */
  async function validar(status: string | null, provider: string = CHANNEL_PROVIDER_WAHA) {
    statusDoCanal = status;
    providerDoCanal = provider;
    return validateConfig(banco() as never, id, campaign.config!).then(
      () => null,
      (e: unknown) => e,
    );
  }

  it("`STARTING` e `STOPPED` são TRANSITÓRIOS: erro próprio, e não o de configuração", async () => {
    for (const status of ["STARTING", "STOPPED"]) {
      const erro = await validar(status);
      expect(erro, `${status} deixou de ser reconhecido como reconexão`).toBeInstanceOf(
        CanalReconectandoError,
      );
      expect((erro as CanalReconectandoError).retomarEmMs).toBeGreaterThan(0);
      // O que o tick lê para pausar: o escopo NÃO pode ser o de campanha.
      expect((erro as ProspectingError).message).not.toContain("Escolha uma conexão ativa");
    }
  });

  it("as ESCALADAS (`SCAN_QR_CODE`, `FAILED`) não viram adiamento: seguem pausando", async () => {
    for (const status of ["SCAN_QR_CODE", "FAILED"]) {
      const erro = await validar(status);
      expect(erro, `${status} passou a adiar em vez de recusar`).not.toBeInstanceOf(
        CanalReconectandoError,
      );
      expect(erro).toBeInstanceOf(ProspectingError);
      expect((erro as ProspectingError).message).toBe(
        "A conexão de saída está desconectada e precisa ser reconectada antes de a campanha continuar.",
      );
    }
  });

  it("canal ausente/arquivado e canal sem capability têm mensagens DIFERENTES entre si", async () => {
    const arquivado = await validar(null);
    const semCapability = await validar("WORKING", CHANNEL_PROVIDER_META);
    expect((arquivado as ProspectingError).message).toContain("foi arquivada");
    expect((semCapability as ProspectingError).message).toContain("exige modelo aprovado");
    expect((arquivado as ProspectingError).message).not.toBe(
      (semCapability as ProspectingError).message,
    );
  });

  it("canal em `WORKING` com a capability passa a validação", async () => {
    expect(await validar("WORKING")).toBeNull();
  });
});
