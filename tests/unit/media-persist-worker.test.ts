import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDeEnv from "@/lib/env";
import type * as ModuloDaLeitura from "@/lib/messaging/media/leitura-adiada";

const uploadMock = vi.fn();
const updateEqMock = vi.fn();
const rpcMock = vi.fn();
const messageRow = {
  id: "msg1",
  organization_id: "org1",
  conversation_id: "conv1",
  channel_session_id: "channel1",
  // Os casos de sempre não dizem o tipo: a trava da foto (abaixo) só alcança
  // quem diz `image`, e eles continuam exercitando o caminho de antes.
  type: undefined as string | undefined,
  media_url: "http://localhost:3030/api/files/abc.jpg" as string | null,
  media_mime: "image/jpeg",
  media_storage_path: null as string | null,
  metadata: { raw_type: "image" } as Record<string, unknown>,
};

// A trava "foto só com leitor": o knob, a pergunta por organização e o pool
// que o worker entrega a ela.
const leitor = vi.hoisted(() => ({
  knob: "always",
  haLeitorMock: vi.fn(async (..._args: unknown[]) => true),
  pool: { query: async () => ({ rows: [] }) },
  falhaNaTrava: false,
  redigidaNaTrava: false,
}));
vi.mock("@/lib/env", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDeEnv>();
  return {
    env: {
      ...real.env,
      get MEDIA_VISION_WITHOUT_READER() {
        return leitor.knob;
      },
    },
  };
});
vi.mock("@/lib/messaging/media/leitura-adiada", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloDaLeitura>()),
  haLeitorDaDescricao: (...args: unknown[]) => leitor.haLeitorMock(...args),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => leitor.pool }));

// Grupo nunca deriva (Task 8, controller A): a IA não serve grupos, e a
// derivação (visão/transcrição paga) não pode ser pedida para eles.
const conversationRow = { is_group: false };
// Fixture de erro (fix round 1, ruling do controller): leitura de
// `conversations.is_group` que falha — o worker precisa fechar FECHADO
// (não deriva) em vez de assumir `is_group: false` por omissão.
let conversationReadError: { message: string } | null = null;
let sessionReadError: { message: string } | null = null;
let sessionExists = true;
const loggerWarnMock = vi.fn();

vi.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => loggerWarnMock(...args), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    // Três consultas agora, cada uma com um encadeamento diferente: a mensagem
    // casa por `id` + `organization_id` (dois `eq`), a SESSÃO casa só por `id`
    // (um `eq`), a CONVERSA casa por `id` + `organization_id` (dois `eq`,
    // igual à mensagem). O dublê responde pela TABELA porque, sem isso, a
    // consulta da sessão receberia a linha da mensagem — e o worker cairia em
    // "canal sem mídia" achando que a sessão não existe.
    from: (tabela: string) => ({
      select: () => {
        if (tabela === "conversations") {
          return {
            eq: () => ({
              eq: () => ({
                maybeSingle: async () =>
                  conversationReadError
                    ? { data: null, error: conversationReadError }
                    : { data: conversationRow, error: null },
              }),
            }),
          };
        }
        const resolvido = {
          maybeSingle: async () => tabela === "channel_sessions"
            ? { data: sessionReadError || !sessionExists ? null : sessionRow, error: sessionReadError }
            : { data: messageRow, error: null },
        };
        return { eq: () => ({ ...resolvido, eq: () => resolvido }) };
      },
      update: (patch: Record<string, unknown>) => {
        updateEqMock(patch);
        const naTrava = patch.media_derived_status === "skipped";
        const falha = leitor.falhaNaTrava && naTrava;
        // Anonimizada entre o upload e a trava: o filtro do corpo redigido não casa nada.
        const linhas = leitor.redigidaNaTrava && naTrava ? [] : [{ id: "msg1" }];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cadeia: any = {
          eq: () => cadeia,
          filter: () => cadeia,
          select: async () =>
            falha ? { data: null, error: { message: "conexão caiu" } } : { data: linhas, error: null },
        };
        return cadeia;
      },
    }),
    storage: { from: () => ({ upload: uploadMock }) },
    rpc: rpcMock,
  }),
}));

/**
 * A sessão que o worker resolve para escolher QUEM baixa.
 *
 * `provider: "waha"` mantém este arquivo exercitando o mesmo caminho de sempre —
 * o que muda é que agora ele passa pelo adapter em vez de chamar o transporte
 * fixo. Se o dublê não existisse, o worker sairia em "canal sem mídia" e todos
 * os casos abaixo passariam por AUSÊNCIA.
 */
const sessionRow = {
  provider: "waha",
  waha_session_name: "default",
  meta_phone_number_id: null,
  zernio_account_id: null,
};

vi.mock("@/lib/messaging/media/waha-source", () => ({
  fetchWahaMedia: vi.fn(async () => ({ buffer: Buffer.from([1, 2, 3]), mime: "image/jpeg" })),
}));

import { persistMessageMedia } from "@/workers/media-persist-worker";
import { fetchWahaMedia } from "@/lib/messaging/media/waha-source";
import { adiarSemLeitorLigado, MOTIVO_SEM_LEITOR } from "@/lib/messaging/media/leitura-adiada";

function eventRow(attempts = 0) {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "media.persist_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts,
  };
}

describe("persistMessageMedia", () => {
  beforeEach(() => {
    uploadMock.mockReset().mockResolvedValue({ error: null });
    updateEqMock.mockReset();
    rpcMock.mockReset().mockResolvedValue({ error: null });
    messageRow.media_storage_path = null;
    messageRow.media_url = "http://localhost:3030/api/files/abc.jpg";
    messageRow.metadata = { raw_type: "image" };
    messageRow.type = undefined;
    leitor.knob = "always";
    leitor.haLeitorMock.mockReset().mockResolvedValue(true);
    leitor.falhaNaTrava = false;
    conversationRow.is_group = false;
    conversationReadError = null;
    sessionReadError = null;
    sessionExists = true;
    loggerWarnMock.mockReset();
    vi.mocked(fetchWahaMedia).mockReset().mockResolvedValue({
      buffer: Buffer.from([1, 2, 3]),
      mime: "image/jpeg",
    });
  });

  it("baixa, sobe pro bucket e atualiza a mensagem", async () => {
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("ok");
    expect(uploadMock).toHaveBeenCalledWith(
      "org1/conv1/msg1.jpg",
      expect.any(Buffer),
      expect.objectContaining({ contentType: "image/jpeg", upsert: true }),
    );
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_storage_path: "org1/conv1/msg1.jpg",
        media_size_bytes: 3,
        metadata: expect.objectContaining({ media_status: "stored" }),
      }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({ p_event_type: "media.derive_requested", p_entity_id: "msg1" }),
    );
  });

  it("1:1 (controle): persiste E pede derivação", async () => {
    conversationRow.is_group = false;
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("ok");
    expect(uploadMock).toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({ p_event_type: "media.derive_requested", p_entity_id: "msg1" }),
    );
  });

  it("histórico importado (#999): guarda no storage mas NÃO pede derivação (sem visão/transcrição paga)", async () => {
    messageRow.metadata = { raw_type: "image", historico_importado: "true" };
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("ok");
    expect(uploadMock).toHaveBeenCalled();
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_storage_path: "org1/conv1/msg1.jpg",
        metadata: expect.objectContaining({ media_status: "stored", historico_importado: "true" }),
      }),
    );
    expect(rpcMock).not.toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({ p_event_type: "media.derive_requested" }),
    );
  });

  it("grupo: persiste mas NÃO pede derivação (a IA não serve grupos)", async () => {
    conversationRow.is_group = true;
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("ok");
    expect(uploadMock).toHaveBeenCalled();
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ media_status: "stored" }) }),
    );
    expect(rpcMock).not.toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({ p_event_type: "media.derive_requested" }),
    );
  });

  it("erro ao ler conversations.is_group: fecha FECHADO — NÃO pede derivação, avisa com organização/conversa/causa", async () => {
    conversationReadError = { message: "conexão recusada" };
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("ok");
    expect(uploadMock).toHaveBeenCalled();
    // A mídia continua persistida mesmo sem saber se a conversa é de grupo.
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ media_status: "stored" }) }),
    );
    expect(rpcMock).not.toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({ p_event_type: "media.derive_requested" }),
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("media-persist"),
      expect.objectContaining({
        organization_id: "org1",
        conversation_id: "conv1",
        detail: "conexão recusada",
      }),
    );
  });

  it("mídia apagada pela retenção (#1534): pula com o motivo real e não baixa de novo", async () => {
    // A poda anula `media_url` E `media_storage_path` e marca `expired`. Sem a
    // guarda ANTES do `!media_url`, o detalhe diria "no media_url".
    messageRow.media_url = null;
    messageRow.metadata = { raw_type: "image", media_status: "expired" };
    vi.mocked(fetchWahaMedia).mockClear();
    const result = await persistMessageMedia(eventRow());
    expect(result).toMatchObject({ status: "skipped", detail: "expired by retention" });
    expect(fetchWahaMedia).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("pula mensagem já persistida (idempotência)", async () => {
    messageRow.media_storage_path = "org1/conv1/msg1.jpg";
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("skipped");
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("retorna error em falha de download com poucas tentativas, sem marcar failed", async () => {
    vi.mocked(fetchWahaMedia).mockRejectedValue(new Error("waha_media_503"));
    const result = await persistMessageMedia(eventRow(1));
    expect(result.status).toBe("error");
    expect(updateEqMock).not.toHaveBeenCalled();
  });

  it("falha ao ler a sessão permite retry sem declarar que o canal não tem mídia", async () => {
    sessionReadError = { message: "connection reset ao consultar a sessão" };
    const result = await persistMessageMedia(eventRow());

    expect(result).toMatchObject({ status: "error" });
    expect(result.detail).toContain(sessionReadError.message);
    expect(updateEqMock).not.toHaveBeenCalled();
    expect(fetchWahaMedia).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("última falha ao ler a sessão marca failed antes de o dreno desistir", async () => {
    sessionReadError = { message: "connection reset ao consultar a sessão" };
    const result = await persistMessageMedia(eventRow(4));

    expect(result.status).toBe("error");
    expect(updateEqMock).toHaveBeenCalledWith(expect.objectContaining({
      media_derived_status: "failed",
      metadata: expect.objectContaining({
        media_status: "failed",
        media_derived_motivo: expect.stringContaining(sessionReadError.message),
      }),
    }));
    expect(fetchWahaMedia).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("sessão ausente sem erro continua sendo canal sem mídia de entrada", async () => {
    sessionExists = false;
    const result = await persistMessageMedia(eventRow());

    expect(result).toMatchObject({ status: "skipped", detail: "canal_sem_midia_de_entrada" });
    expect(updateEqMock).toHaveBeenCalledWith(expect.objectContaining({ media_derived_status: "skipped" }));
    expect(fetchWahaMedia).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("a tentativa seguinte persiste a mídia quando a leitura da sessão se recupera", async () => {
    sessionReadError = { message: "connection reset ao consultar a sessão" };
    const primeira = await persistMessageMedia(eventRow());
    const escritasDuranteFalha = updateEqMock.mock.calls.slice();
    sessionReadError = null;
    const segunda = await persistMessageMedia(eventRow(1));

    expect(segunda.status).toBe("ok");
    expect(fetchWahaMedia).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("emit_event", expect.objectContaining({
      p_event_type: "media.derive_requested",
      p_entity_id: "msg1",
    }));
    expect(primeira.status).toBe("error");
    expect(escritasDuranteFalha).toEqual([]);
  });

  it("marca failed quando o download falha na última tentativa (drain dead-letra em seguida)", async () => {
    vi.mocked(fetchWahaMedia).mockRejectedValue(new Error("waha_media_503"));
    const result = await persistMessageMedia(eventRow(4));
    expect(result.status).toBe("error");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ media_status: "failed" }) }),
    );
  });

  it("marca failed quando o upload falha na última tentativa", async () => {
    uploadMock.mockResolvedValue({ error: { message: "bucket unreachable" } });
    const result = await persistMessageMedia(eventRow(4));
    expect(result.status).toBe("error");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ media_status: "failed" }) }),
    );
  });
});

/**
 * FOTO SÓ PASSA PELA VISÃO QUANDO ALGUÉM DA EMPRESA VAI LER A DESCRIÇÃO.
 *
 * Com `MEDIA_VISION_WITHOUT_READER=defer` (o padrão), a foto de uma empresa sem
 * NENHUM leitor (agente com "ver as fotos" ligado, inscrição sem agente, token,
 * anúncio, modo external, venda pelo canal) é guardada e fica `skipped` com a
 * marca `derivacao_adiada` — o dreno e o cron a reabrem quando aparecer quem
 * leia. Os controles reprovam a trava que alcança demais: só foto, a válvula
 * `always` desliga, e toda dúvida DERIVA.
 */
describe("foto só com leitor (MEDIA_VISION_WITHOUT_READER)", () => {
  const pediuDerivacao = () =>
    rpcMock.mock.calls.some(
      ([nome, args]) => nome === "emit_event" && (args as { p_event_type?: string }).p_event_type === "media.derive_requested",
    );

  beforeEach(() => {
    uploadMock.mockReset().mockResolvedValue({ error: null });
    updateEqMock.mockReset();
    rpcMock.mockReset().mockResolvedValue({ error: null });
    loggerWarnMock.mockReset();
    messageRow.media_storage_path = null;
    messageRow.media_url = "http://localhost:3030/api/files/abc.jpg";
    messageRow.metadata = { raw_type: "image" };
    messageRow.type = "image";
    conversationRow.is_group = false;
    conversationReadError = null;
    sessionReadError = null;
    sessionExists = true;
    leitor.knob = "defer";
    leitor.haLeitorMock.mockReset().mockResolvedValue(false);
    leitor.falhaNaTrava = false;
    leitor.redigidaNaTrava = false;
  });

  it("foto de empresa sem leitor: guarda, fica skipped com a marca e NÃO pede a visão", async () => {
    const result = await persistMessageMedia(eventRow());

    expect(result).toMatchObject({ status: "ok", detail: "leitura_adiada_sem_leitor" });
    expect(uploadMock).toHaveBeenCalled();
    expect(pediuDerivacao(), "a visão paga foi pedida numa empresa sem leitor").toBe(false);
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_derived_status: "skipped",
        metadata: expect.objectContaining({
          media_status: "stored",
          derivacao_adiada: "sem_leitor",
          media_derived_motivo: MOTIVO_SEM_LEITOR,
        }),
      }),
    );
  });

  it("a régua é a ORGANIZAÇÃO: pergunta com o pool e o id da empresa, nada da sessão", async () => {
    await persistMessageMedia(eventRow());
    expect(leitor.haLeitorMock).toHaveBeenCalledTimes(1);
    expect(leitor.haLeitorMock).toHaveBeenCalledWith(leitor.pool, "org1");
  });

  it.each(["audio", "document", "video"])("controle: %s sem leitor deriva como sempre", async (tipo) => {
    messageRow.type = tipo;
    await persistMessageMedia(eventRow());
    expect(pediuDerivacao()).toBe(true);
    expect(leitor.haLeitorMock).not.toHaveBeenCalled();
  });

  it("controle: com leitor, a foto deriva", async () => {
    leitor.haLeitorMock.mockResolvedValue(true);
    await persistMessageMedia(eventRow());
    expect(pediuDerivacao()).toBe(true);
  });

  it("controle: a pergunta ao banco falhou — deriva (falha aberta) e avisa", async () => {
    leitor.haLeitorMock.mockRejectedValue(new Error("pool fora do ar"));
    await persistMessageMedia(eventRow());
    expect(pediuDerivacao()).toBe(true);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("media-persist"),
      expect.objectContaining({ message_id: "msg1", detail: expect.stringContaining("pool fora do ar") }),
    );
  });

  it("controle: a gravação da própria trava falhou — deriva, senão a foto nunca mais seria pedida", async () => {
    leitor.falhaNaTrava = true;
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("ok");
    expect(pediuDerivacao()).toBe(true);
  });

  it("anonimizada entre o upload e a trava: skipped/message_redacted, igual ao ramo irmão, e sem visão", async () => {
    leitor.redigidaNaTrava = true;
    const result = await persistMessageMedia(eventRow());
    expect(result).toMatchObject({ status: "skipped", detail: "message_redacted" });
    expect(pediuDerivacao()).toBe(false);
  });

  it.each(["always", "ALWAYS", " Always "])(
    "controle: a válvula %j desliga a trava — deriva sem perguntar ao banco",
    async (valor) => {
      leitor.knob = valor;
      await persistMessageMedia(eventRow());
      expect(pediuDerivacao()).toBe(true);
      expect(leitor.haLeitorMock).not.toHaveBeenCalled();
    },
  );

  it.each(["", "defe", " DEFER "])(
    "knob %j (vazio ou torto) fica no padrão: a trava segue ligada",
    async (valor) => {
      leitor.knob = valor;
      const result = await persistMessageMedia(eventRow());
      expect(result).toMatchObject({ detail: "leitura_adiada_sem_leitor" });
      expect(pediuDerivacao()).toBe(false);
    },
  );

  it("o padrão da instalação (lib/env.ts) é a trava LIGADA: foto de empresa sem leitor não paga visão", async () => {
    const { env: real } = await vi.importActual<typeof ModuloDeEnv>("@/lib/env");
    expect(real.MEDIA_VISION_WITHOUT_READER).toBeDefined();
    expect(adiarSemLeitorLigado(real.MEDIA_VISION_WITHOUT_READER)).toBe(true);
    // O padrão pelo caminho do worker, não só pela função: o env de verdade.
    leitor.knob = real.MEDIA_VISION_WITHOUT_READER;
    const result = await persistMessageMedia(eventRow());
    expect(result).toMatchObject({ status: "ok", detail: "leitura_adiada_sem_leitor" });
    expect(pediuDerivacao()).toBe(false);
    expect(adiarSemLeitorLigado("always")).toBe(false);
  });
});
