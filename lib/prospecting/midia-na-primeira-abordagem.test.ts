import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A MÍDIA FIXA DA PRIMEIRA ABORDAGEM (#4581).
 *
 * O caminho é o do TICK, não o do envio isolado: é nele que "a mídia saiu uma
 * vez", "sem mídia nada mudou" e "a repetição não reenvia" têm consequência
 * observável (o que chegou ao canal, na ordem).
 *
 * O dublê do handler é FIEL nas três linhas que decidem o desfecho:
 *   1. roda a guarda de PRIMEIRO CONTATO de verdade (`@/lib/prospecting/guard`
 *      real), como `_handler.ts` faz na entrada da 1ª bolha;
 *   2. devolve sem falar com o canal quando recebe um `internalMessageId` que
 *      já virou linha — é o ramo 23505 do handler (`_handler.ts`), e é ele que
 *      impede a mídia de sair duas vezes;
 *   3. carimba `last_outbound_at` na conversa DEPOIS de enviar, que é o que a
 *      guarda cheia lê na bolha seguinte.
 *
 * A assinatura da URL também é dublada (o Storage não existe aqui), e o que se
 * afirma é o PEDIDO: bucket, caminho do arquivo configurado e validade.
 */
const id = "10000000-0000-4000-8000-000000000001";
const CONVERSA = id;
const CAMINHO_DA_MIDIA = `${id}/templates/10000000-0000-4000-8000-0000000000aa/10000000-0000-4000-8000-0000000000bb.jpg`;
const URL_ASSINADA = `https://supabase.local/storage/v1/object/sign/whatsapp-media/${CAMINHO_DA_MIDIA}?token=abc`;

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

/** O que o handler recebeu — só entra aqui o que de fato foi ao CANAL. */
type Envio = {
  conversation_id: string;
  type: string;
  body?: string;
  media_url?: string;
  media_mime?: string;
};
const envios: Envio[] = [];
/** As linhas `messages` que o handler "gravou", por `internalMessageId`. */
const linhasPorId = new Map<string, { id: string; status: string }>();
/** Quantas vezes a guarda de primeiro contato rodou na entrada. */
const guardasNaEntrada = { chamadas: 0 };
/** Os pedidos de assinatura de URL feitos ao Storage. */
const assinaturas: Array<{ bucket: string; caminho: string; validade: number }> = [];
/** Erro de Storage forçado pelo caso. */
let assinaturaFalha = false;
/** Erro transitório do canal na próxima 1ª bolha. */
let falharPrimeiraBolha = false;
/** O "Estilo de resposta" do agente que o tick lê (`ai_agent_versions`). */
let estiloDoAgente = { split_messages: true, split_max_chars: 60 };
/** Quantas abordagens com mídia o número já mandou hoje (a contagem que o teto lê). */
let midiasHoje = 0;
/** Todo SQL que o caminho pediu — é onde se vê o candidato sendo marcado. */
const sqls: Array<{ sql: string; params?: unknown[] }> = [];

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
  dayStart: vi.fn(),
}));

vi.mock("@/app/api/v1/messages/_handler", async () => {
  const { assertProspectingDelivery } =
    await vi.importActual<typeof import("@/lib/prospecting/guard")>("@/lib/prospecting/guard");
  return {
    sendMessageHandler: async (
      _supabase: unknown,
      ctx: { prospectingDelivery?: unknown; internalMessageId?: string },
      input: Envio,
    ) => {
      if (ctx.prospectingDelivery) {
        guardasNaEntrada.chamadas++;
        await assertProspectingDelivery(clienteDoSupa() as never, ctx.prospectingDelivery as never);
      }
      // Ramo 23505: a linha já existe para este id → devolve SEM mandar ao canal.
      if (ctx.internalMessageId && linhasPorId.has(ctx.internalMessageId))
        return linhasPorId.get(ctx.internalMessageId)!;
      if (falharPrimeiraBolha && envios.length === 0) {
        falharPrimeiraBolha = false;
        throw new Error("canal indisponível");
      }
      envios.push(input);
      estado.conversation.last_outbound_at = new Date().toISOString();
      const linha = { id: `balao-${envios.length}`, status: "sent" };
      if (ctx.internalMessageId) linhasPorId.set(ctx.internalMessageId, linha);
      return linha;
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
  dayStartInTz: mocks.dayStart,
  janelaDeProspeccaoAberta: () => true,
  proximaAberturaDaProspeccao: () => new Date(Date.now() + 3600000),
  decidePacing: () => ({ allow: true, waitMs: 0 }),
  proximaAberturaDaJanela: () => new Date(Date.now() + 3600000),
  warmupCapFor: (_idade: number, degraus: Array<{ minAgeDays: number; cap: number | null }>) => {
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
  // A validação de servidor fica DUBLADA aqui de propósito: o que este arquivo
  // mede é o ENVIO. A régua de tipo/tamanho/posse tem os casos dela abaixo.
  validateConfig: vi.fn().mockResolvedValue(undefined),
  prepararCandidatoNoEnvio: mocks.prepare,
}));

import { withProspectingLock } from "@/lib/prospecting/store";
import type { Campaign } from "@/lib/prospecting/store";
import { tickProspecting } from "@/lib/prospecting/worker";
import {
  ABORDAGENS_COM_MIDIA_DESDE_SQL,
  TETO_DIARIO_DE_MIDIA_POR_NUMERO,
  classificarMidiaDaAbordagem,
  problemaNaMidiaDaAbordagem,
  TAMANHO_MAXIMO_DO_VIDEO,
  TETO_DE_LEGENDA,
  VALIDADE_DA_URL_DA_MIDIA_S,
} from "@/lib/prospecting/midia-da-abordagem";

/**
 * O cliente Supabase que a guarda real e a assinatura de URL enxergam. Cadeia
 * tolerante porque a guarda usa `.from().select().eq().eq().maybeSingle()`, e o
 * valor devolvido é o ESTADO VIVO da conversa.
 */
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
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (caminho: string, validade: number) => {
            assinaturas.push({ bucket, caminho, validade });
            if (assinaturaFalha) return { data: null, error: { message: "Object not found" } };
            return { data: { signedUrl: URL_ASSINADA }, error: null };
          },
        };
      },
    },
  };
}

const MIDIA = {
  storage_path: CAMINHO_DA_MIDIA,
  media_mime: "image/jpeg",
  media_size_bytes: 320_000,
};

const configBase = {
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
};

/** A campanha do caso — com ou sem a mídia da fatia. */
function campanha(comMidia: boolean): Campaign {
  return {
    id,
    organization_id: id,
    next_send_at: new Date(0),
    config: comMidia ? { ...configBase, midia_da_abordagem: MIDIA } : { ...configBase },
  } as Campaign;
}

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

/** O banco do tick e do envio. O `config` vem do caso corrente. */
function banco(config: Campaign) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      sqls.push({ sql, params });
      if (
        sql.startsWith(
          "select * from prospecting_campaigns where organization_id=$1 and status='running'",
        )
      )
        return { rows: [config] };
      if (
        sql.startsWith(
          "select * from prospecting_campaigns where organization_id=$1 and status='running' and id=$2",
        )
      )
        return { rows: [config] };
      if (sql === ABORDAGENS_COM_MIDIA_DESDE_SQL) return { rows: [{ n: midiasHoje }] };
      if (sql.startsWith("select daily_message_limit"))
        return { rows: [{ daily_message_limit: 50 }] };
      if (sql.includes("count(*) filter"))
        return { rows: [{ campaign: 0, total: 0, retry_at: null, last_attempt: null }] };
      if (sql.startsWith("select * from prospecting_candidates")) return { rows: [candidate] };
      if (sql.startsWith("select locale from organizations"))
        return { rows: [{ locale: "pt-BR" }] };
      if (/^select (a\.)?published_version_id/.test(sql))
        // O "Estilo de resposta" do caso (teto baixo o bastante para fatiar).
        return {
          rows: [
            {
              published_version_id: id,
              operation_revision: 1,
              ...estiloDoAgente,
            },
          ],
        };
      return { rows: [] };
    }),
  };
}

/** Roda o TICK inteiro para a campanha do caso. */
async function rodarOTick(comMidia: boolean) {
  const db = banco(campanha(comMidia));
  (withProspectingLock as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (_pool: unknown, _org: unknown, fn: (d: unknown) => Promise<unknown>) => fn(db),
  );
  const pool = { query: vi.fn(async () => ({ rows: [{ organization_id: id }] })) };
  await tickProspecting(pool as never, clienteDoSupa() as never);
  return db;
}

/** Só os envios que levaram o arquivo. */
function enviosComMidia(): Envio[] {
  return envios.filter((e) => e.media_url != null);
}

beforeEach(() => {
  vi.clearAllMocks();
  estado.conversation = {
    status: "open",
    last_inbound_at: null,
    last_outbound_at: null,
    assigned_to_user_id: null,
    bot_silenced_until: null,
  };
  envios.length = 0;
  linhasPorId.clear();
  assinaturas.length = 0;
  sqls.length = 0;
  guardasNaEntrada.chamadas = 0;
  assinaturaFalha = false;
  falharPrimeiraBolha = false;
  estiloDoAgente = { split_messages: true, split_max_chars: 60 };
  midiasHoje = 0;
  mocks.dayStart.mockReturnValue(new Date("2026-11-15T03:00:00.000Z"));
  mocks.knobs.mockResolvedValue({ knobs: {} });
  mocks.open.mockReturnValue(true);
  mocks.preflight.mockResolvedValue({ permite: true });
  mocks.boundary.mockResolvedValue(undefined);
  mocks.authorize.mockResolvedValue({ ok: true });
  mocks.paradas.mockResolvedValue([]);
  mocks.generate.mockResolvedValue({ ok: true, texto: textoDoModelo });
});

describe("campanha COM mídia: o arquivo vai junto da 1ª abordagem", () => {
  it("a mídia sai UMA vez, na MESMA mensagem da 1ª bolha, e a abordagem continua igual", async () => {
    await rodarOTick(true);

    // O arquivo foi pedido ao Storage: o caminho da configuração, no bucket das
    // mídias do atendimento, com a validade da fatia.
    expect(assinaturas).toEqual([
      { bucket: "whatsapp-media", caminho: CAMINHO_DA_MIDIA, validade: VALIDADE_DA_URL_DA_MIDIA_S },
    ]);

    // A 1ª bolha é a mídia, com o texto dela como LEGENDA — e a saída dentro.
    expect(envios).toHaveLength(3);
    expect(envios[0]).toMatchObject({
      type: "image",
      media_url: URL_ASSINADA,
      media_mime: "image/jpeg",
    });
    expect(envios[0]!.body, "a legenda não levou o texto da 1ª bolha").toBeTruthy();
    expect(envios[0]!.body, "a saída não está na legenda").toContain("responda PARAR");
    // Nenhuma bolha depois da primeira leva o arquivo: o texto segue sozinho.
    for (const seguinte of envios.slice(1)) {
      expect(seguinte.type).toBe("text");
      expect(seguinte.media_url).toBeUndefined();
    }
    expect(enviosComMidia()).toHaveLength(1);

    // A trilha registra que a abordagem saiu COM arquivo.
    expect(mocks.audit.mock.calls[0]?.[0]).toMatchObject({
      action: "prospecting.approach_sent",
      metadata: { media_type: "image", sent: true },
    });
  });

  it("legenda acima do teto da plataforma é repartida: o texto não vai cortado dentro do arquivo", async () => {
    // ~1.550 caracteres, com o teto de bolha do agente em 4000 (o máximo que o
    // schema aceita): sem o teto da legenda, a 1ª bolha sairia inteira como
    // legenda de uma imagem e a plataforma cortaria o texto.
    estiloDoAgente = { split_messages: true, split_max_chars: 4000 };
    mocks.generate.mockResolvedValue({ ok: true, texto: "palavra ".repeat(220).trim() });

    await rodarOTick(true);

    expect(envios[0]!.type).toBe("image");
    // A legenda (com a saída dentro) cabe no teto da plataforma.
    expect(envios[0]!.body!.length).toBeLessThanOrEqual(TETO_DE_LEGENDA);
    // O que não coube na legenda continua saindo, nas bolhas seguintes.
    const textoEntregue = envios.map((e) => e.body ?? "").join(" ");
    expect(textoEntregue.match(/palavra/g)).toHaveLength(220);
  });

  it("Storage sem o arquivo configurado RECUSA a abordagem — não sai texto sem a mídia", async () => {
    assinaturaFalha = true;

    await rodarOTick(true);

    // Nada saiu: nem a mídia (que não foi possível assinar) nem o texto no lugar dela.
    expect(envios).toHaveLength(0);
    // E o candidato ficou com o motivo, em vez de seguir em silêncio.
    const falhou = sqls.find((q) => q.sql.includes("set status='failed',error=$3"));
    expect(falhou?.params?.[2], "o motivo da recusa não chegou ao candidato").toContain(
      "não está no Storage desta instalação",
    );
  });
});

describe("teto diário de mídia por número (doc 358 › 2A)", () => {
  it("o teto padrão é 30 abordagens com mídia por número por dia", () => {
    expect(TETO_DIARIO_DE_MIDIA_POR_NUMERO).toBe(30);
  });

  it("abaixo do teto a mídia vai, e a contagem é do NÚMERO desde o início do dia no fuso dele", async () => {
    midiasHoje = TETO_DIARIO_DE_MIDIA_POR_NUMERO - 1;
    mocks.knobs.mockResolvedValue({ knobs: { timezone: "America/Sao_Paulo" } });

    await rodarOTick(true);

    expect(enviosComMidia()).toHaveLength(1);
    expect(envios[0]!.type).toBe("image");
    expect(mocks.dayStart).toHaveBeenCalledWith(expect.any(Date), "America/Sao_Paulo");
    const contagem = sqls.find((q) => q.sql === ABORDAGENS_COM_MIDIA_DESDE_SQL);
    expect(contagem?.params).toEqual([id, id, new Date("2026-11-15T03:00:00.000Z")]);
    const metadata = (mocks.audit.mock.calls[0]?.[0] as { metadata: Record<string, unknown> })
      .metadata;
    expect(metadata).not.toHaveProperty("media_omitted");
  });

  it("no teto, a abordagem sai só com texto, a campanha segue e a trilha diz por quê", async () => {
    midiasHoje = TETO_DIARIO_DE_MIDIA_POR_NUMERO;

    await rodarOTick(true);

    // Nenhum arquivo: nem assinado, nem enviado. O texto sai inteiro.
    expect(assinaturas).toHaveLength(0);
    expect(enviosComMidia()).toHaveLength(0);
    expect(envios.length).toBeGreaterThan(0);
    for (const envio of envios) expect(envio.type).toBe("text");
    expect(envios[0]!.body, "a saída não está na 1ª bolha").toContain("responda PARAR");
    // Não trava: nem o candidato falha, nem a campanha pausa.
    // (A varredura de `sending` antigos do tick também diz `status='failed'`; a
    // falha DESTE candidato é a que leva o motivo em `$3`.)
    expect(sqls.some((q) => q.sql.includes("set status='failed',error=$3"))).toBe(false);
    expect(sqls.some((q) => q.sql.includes("status='paused'"))).toBe(false);
    // O rastro: a trilha da abordagem diz que a mídia foi omitida pelo teto.
    expect(mocks.audit.mock.calls[0]?.[0]).toMatchObject({
      action: "prospecting.approach_sent",
      metadata: { sent: true, media_omitted: "teto_diario_por_numero", media_daily_cap: 30 },
    });
  });

  it("campanha sem mídia nem consulta a contagem", async () => {
    await rodarOTick(false);
    expect(sqls.some((q) => q.sql === ABORDAGENS_COM_MIDIA_DESDE_SQL)).toBe(false);
  });
});

describe("campanha SEM mídia: nada muda", () => {
  it("as bolhas saem de texto, sem arquivo, e o Storage não é consultado", async () => {
    await rodarOTick(false);

    expect(assinaturas).toHaveLength(0);
    expect(envios).toHaveLength(3);
    for (const envio of envios) {
      expect(envio.type).toBe("text");
      expect(envio.media_url).toBeUndefined();
    }
    expect(envios[0]!.body, "a saída não está na 1ª bolha").toContain("responda PARAR");
    // A trilha de sempre, sem o campo da mídia.
    const metadata = (mocks.audit.mock.calls[0]?.[0] as { metadata: Record<string, unknown> })
      .metadata;
    expect(metadata).not.toHaveProperty("media_type");
  });
});

describe("repetição: a mídia não sai duas vezes", () => {
  it("com a 1ª bolha já gravada, o MESMO id devolve a linha e não reenvia o arquivo", async () => {
    await rodarOTick(true);
    expect(enviosComMidia()).toHaveLength(1);

    // A repetição do tick: a conversa não tem carimbo de saída (é o estado em que
    // o candidato volta para a fila), a 1ª bolha leva o MESMO `p.message_id`.
    estado.conversation.last_outbound_at = null;
    await rodarOTick(true);

    // O ramo 23505 devolveu a linha da 1ª bolha: o arquivo NÃO foi pedido de novo
    // ao canal. (As bolhas seguintes não têm id — repetem por desenho antigo, e
    // isso é do texto, não da mídia.)
    expect(enviosComMidia()).toHaveLength(1);
  });

  it("depois de a 1ª tentativa falhar sem sair, a retentativa manda o arquivo UMA vez", async () => {
    falharPrimeiraBolha = true;
    await rodarOTick(true);
    expect(envios).toHaveLength(0);

    estado.conversation.last_outbound_at = null;
    await rodarOTick(true);

    expect(enviosComMidia()).toHaveLength(1);
    expect(envios[0]!.type).toBe("image");
  });
});

describe("a régua da mídia da abordagem: tipo e tamanho", () => {
  it("aceita imagem, vídeo e PDF dentro do teto do tipo", () => {
    expect(
      classificarMidiaDaAbordagem({ media_mime: "image/png", media_size_bytes: 200_000 }),
    ).toEqual({
      ok: true,
      tipo: "image",
      mime: "image/png",
    });
    expect(
      classificarMidiaDaAbordagem({ media_mime: "video/mp4", media_size_bytes: 3_000_000 }),
    ).toMatchObject({
      tipo: "video",
    });
    expect(
      classificarMidiaDaAbordagem({
        media_mime: "application/pdf;charset=binary",
        media_size_bytes: 900_000,
      }),
    ).toMatchObject({ ok: true, tipo: "document", mime: "application/pdf" });
  });

  it("recusa áudio, documento que não é PDF e tipo desconhecido", () => {
    for (const mime of ["audio/ogg", "application/zip", "text/plain", "image/bmp"]) {
      const classificada = classificarMidiaDaAbordagem({
        media_mime: mime,
        media_size_bytes: 1_000,
      });
      expect(classificada.ok, `${mime} deveria ser recusado`).toBe(false);
      if (!classificada.ok) expect(classificada.motivo).toMatch(/imagem|vídeo|PDF/);
    }
  });

  it("recusa acima do teto do tipo — e o de vídeo não é o da imagem", () => {
    expect(
      problemaNaMidiaDaAbordagem({ media_mime: "image/jpeg", media_size_bytes: 6 * 1024 * 1024 }),
    ).toContain("5 MB");
    expect(
      problemaNaMidiaDaAbordagem({
        media_mime: "video/mp4",
        media_size_bytes: TAMANHO_MAXIMO_DO_VIDEO - 1,
      }),
    ).toBeNull();
    expect(
      problemaNaMidiaDaAbordagem({
        media_mime: "video/mp4",
        media_size_bytes: TAMANHO_MAXIMO_DO_VIDEO + 1,
      }),
    ).toContain("16 MB");
  });
});
