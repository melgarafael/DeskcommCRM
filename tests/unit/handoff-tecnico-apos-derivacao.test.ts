import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2210 — a derivação que conclui DEPOIS do handoff.
 *
 * Medido na issue (produção, 03/10): dois áudios entraram sem saldo, a
 * derivação falhou com 429 e reagendou; o turno saiu sem o texto e o modelo
 * passou a conversa para humano (`bot_silenced_until = 'infinity'`,
 * `force_human = true`, `last_handoff_reason` = "não há transcrição de texto
 * disponível no sistema"). Quinze minutos depois a derivação entregou o texto
 * (`media_derived_status = 'ready'`) e NADA reavaliou: o motivo gravado seguiu
 * afirmando algo que o próprio banco desmentia, e a conversa só saía do
 * silêncio pelo botão "Devolver ao automático".
 *
 * Estes casos cobrem os dois pontos do corpo da issue:
 *
 *  1. o motivo gravado não pode seguir afirindo o que o banco já desmentiu;
 *  2. falha transitória de infraestrutura não vira estado permanente — quando a
 *     derivação conclui, a conversa volta a ser atendida e o turno tardio é
 *     (re)enfileirado, sem intervenção manual.
 *
 * E o não-regressão exigido: handoff por DECISÃO humana continua `infinity`.
 *
 * O dublê é o mesmo molde de `tests/unit/media-derive-worker.test.ts` — o
 * worker é o alvo, e a marca (metadata da conversa) é a entrada de teste.
 */
const { devolverMock, rpcMock, updateConversasMock, updateMensagemMock } = vi.hoisted(() => ({
  devolverMock: vi.fn(),
  rpcMock: vi.fn(),
  updateConversasMock: vi.fn(),
  updateMensagemMock: vi.fn(),
}));

const messageRow: Record<string, unknown> = {
  id: "msg1",
  organization_id: "org1",
  conversation_id: "conv1",
  type: "audio" as string,
  media_mime: "audio/ogg",
  media_storage_path: "org1/conv1/msg1.ogg" as string | null,
  media_derived_status: null as string | null,
  metadata: null as Record<string, unknown> | null,
};

const MOTIVO_FALSO = "O cliente enviou áudios duas vezes seguidas e não há transcrição de texto disponível no sistema.";

let conversaRow: Record<string, unknown> = {};
/** O que a consulta "um humano respondeu depois da marca?" devolve (`sent_via` user/external_device). */
let respostasHumanas: { data: Array<{ id: string }> | null; error: { message: string } | null } = {
  data: [],
  error: null,
};
const filtrosDaRespostaHumana: Array<[string, unknown]> = [];

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha =
        tabela === "conversations"
          ? conversaRow
          : tabela === "ai_purpose_bindings"
            ? null
            : tabela === "agent_inbox_items"
              ? null
              : tabela === "ai_agent_versions"
                ? { id: "v1" }
                : messageRow;
      // A consulta de resposta humana é a única que filtra `sent_via`: é por ela
      // que o dublê sabe qual resposta entregar.
      let perguntaPorRespostaHumana = false;
      const update =
        tabela === "conversations"
          ? updateConversasMock
          : tabela === "messages"
            ? updateMensagemMock
            : vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const terminais: any = {
        maybeSingle: async () => ({ data: linha, error: null }),
        single: async () => ({ data: linha, error: null }),
        insert: async () => ({ error: null }),
        in: (coluna: string, valores: unknown) => {
          if (coluna === "sent_via") perguntaPorRespostaHumana = true;
          filtrosDaRespostaHumana.push([`in:${coluna}`, valores]);
          return chain;
        },
        gt: (coluna: string, valor: unknown) => {
          filtrosDaRespostaHumana.push([`gt:${coluna}`, valor]);
          return chain;
        },
        update: (patch: Record<string, unknown>) => {
          update(patch);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chain: any = new Proxy(
            {
              eq: () => chain,
              filter: () => chain,
              select: () => chain,
              then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
                Promise.resolve({ data: [linha], error: null }).then(ok, erro),
            },
            { get: (alvo, prop) => (prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain) },
          );
          return chain;
        },
        then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
          Promise.resolve(
            perguntaPorRespostaHumana ? respostasHumanas : { data: linha ? [linha] : [], error: null },
          ).then(ok, erro),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(terminais, {
        get: (alvo, prop) => (prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain),
      });
      return chain;
    },
    storage: { from: () => ({ download: vi.fn(async () => ({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null })) }) },
    rpc: (nome: string, args: Record<string, unknown>) => {
      rpcMock(nome, args);
      return Promise.resolve({ data: null, error: null });
    },
  }),
}));

vi.mock("@/lib/messaging/media/derive", () => ({
  deriveMediaText: vi.fn(async () => "Teste, teste, teste, teste. Tá me ouvindo aí?"),
}));

vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async () => {
    const config: Record<string, unknown> = {
      provider: "openai",
      origemDaChave: "credencial_da_organizacao",
      defaultModel: "gpt-5",
      params: {},
      enabledModels: [],
      orcamento: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 },
      orcamentoIndisponivelPorque: null,
      baseUrl: null,
    };
    config["apiKey"] = ["chave", "de", "teste"].join("-");
    return config;
  }),
}));

/** A MESMA função que o botão "Devolver ao automático" usa — é ela que tem de ser chamada. */
vi.mock("@/lib/escalacao/retomada", () => ({
  devolverAtendimentoAoAgente: devolverMock,
}));

import { deriveMessageMedia } from "@/workers/media-derive-worker";

function eventRow() {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

/** Conversa no estado em que a issue a mediu: silêncio formal, ninguém assumiu. */
function conversaEmHandoff(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "conv1",
    organization_id: "org1",
    contact_id: "cont1",
    channel_session_id: "sess1",
    status: "pending",
    bot_silenced_until: "infinity",
    last_handoff_at: "2026-10-03T21:05:58.000Z",
    last_handoff_reason: MOTIVO_FALSO,
    assigned_to_user_id: null,
    assignee_kind: null,
    metadata: {},
    ...over,
  };
}

/** A marca que o handoff grava quando ele disparou com a derivação ainda aberta. */
function marca(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handoff_tecnico: {
      causa: "derivacao_ausente",
      message_id: "msg1",
      motivo_gravado: MOTIVO_FALSO,
      marcado_em: "2026-10-03T21:05:58.000Z",
      ...over,
    },
  };
}

function dispatchesEmitidos(): Array<Record<string, unknown>> {
  return rpcMock.mock.calls
    .filter(([nome]) => nome === "emit_event")
    .map(([, args]) => args as Record<string, unknown>)
    .filter((args) => args.p_event_type === "ai_agent.dispatch_requested");
}

describe("a derivação que conclui depois do handoff (#2210)", () => {
  beforeEach(() => {
    devolverMock.mockReset().mockResolvedValue({
      ok: true,
      conversationId: "conv1",
      jaEstavaComOAgente: false,
      continuidade: { houveAtendimentoHumano: false, decisoes: [], notas: [] },
    });
    rpcMock.mockReset();
    updateConversasMock.mockReset();
    updateMensagemMock.mockReset();
    conversaRow = conversaEmHandoff({ metadata: marca() });
    respostasHumanas = { data: [], error: null };
    filtrosDaRespostaHumana.length = 0;
    messageRow.media_derived_status = null;
    messageRow.type = "audio";
    messageRow.media_storage_path = "org1/conv1/msg1.ogg";
    messageRow.metadata = null;
  });

  it("devolve o atendimento e (re)enfileira o turno — o caso medido na issue", async () => {
    const r = await deriveMessageMedia(eventRow());

    expect(r.status).toBe("ok");
    expect(
      devolverMock,
      "a conversa seguia silenciada até alguém clicar em 'Devolver ao automático'",
    ).toHaveBeenCalledTimes(1);
    expect(devolverMock.mock.calls[0]![0]).toMatchObject({ organizationId: "org1" });
    expect(devolverMock.mock.calls[0]![1]).toMatchObject({ conversationId: "conv1" });

    const dispatch = dispatchesEmitidos();
    expect(dispatch, "o turno tardio precisa ser (re)enfileirado, senão ninguém responde").toHaveLength(1);
    expect(dispatch[0]).toMatchObject({
      p_entity_kind: "message",
      p_entity_id: "msg1",
      p_organization_id: "org1",
      p_payload: expect.objectContaining({
        conversation_id: "conv1",
        contact_id: "cont1",
        channel_session_id: "sess1",
        inbound_message_id: "msg1",
      }),
    });
  });

  it("humano assumiu a conversa: corrige o motivo e NÃO arranca a conversa da pessoa", async () => {
    conversaRow = conversaEmHandoff({
      assigned_to_user_id: "user1",
      assignee_kind: "user",
      metadata: marca(),
    });

    const r = await deriveMessageMedia(eventRow());

    expect(r.status).toBe("ok");
    expect(devolverMock, "roubar a conversa de quem já assumiu seria pior que o defeito").not.toHaveBeenCalled();
    expect(dispatchesEmitidos()).toHaveLength(0);

    expect(updateConversasMock).toHaveBeenCalled();
    const patches = updateConversasMock.mock.calls.map((chamada) => chamada[0] as Record<string, unknown>);
    const doMotivo = patches.find((patch) => "last_handoff_reason" in patch);
    expect(doMotivo, "o motivo segue afirmando algo que o banco desmentiu").toBeTruthy();
    expect(doMotivo!.last_handoff_reason).not.toBe(MOTIVO_FALSO);
    expect(String(doMotivo!.last_handoff_reason)).toContain("chegou");
    // As três travas permanecem: sem mexer no silêncio, sem apagar o handoff.
    for (const patch of patches) {
      expect(patch).not.toHaveProperty("bot_silenced_until");
      expect(patch).not.toHaveProperty("force_human");
      expect(patch).not.toHaveProperty("last_handoff_at");
    }
  });

  it("atendente RESPONDEU sem clicar em 'Assumir': corrige o motivo e NÃO devolve", async () => {
    // Responder não atribui a conversa: pelo inbox o handler só estende o
    // silêncio, pelo celular (silêncio já `infinity`) nada é gravado. A conversa
    // segue sem dono e com o mesmo motivo — só a mensagem enviada denuncia a pessoa.
    respostasHumanas = { data: [{ id: "out-celular" }], error: null };

    const r = await deriveMessageMedia(eventRow());

    expect(r.status).toBe("ok");
    expect(devolverMock, "o agente voltaria a falar por cima de quem está conversando").not.toHaveBeenCalled();
    expect(dispatchesEmitidos()).toHaveLength(0);
    const patches = updateConversasMock.mock.calls.map((chamada) => chamada[0] as Record<string, unknown>);
    const doMotivo = patches.find((patch) => "last_handoff_reason" in patch);
    expect(doMotivo, "o motivo segue afirmando algo que o banco desmentiu").toBeTruthy();
    expect(doMotivo!.last_handoff_reason).not.toBe(MOTIVO_FALSO);

    // A pergunta é a certa: gente (inbox ou celular), depois da marca.
    expect(filtrosDaRespostaHumana).toContainEqual(["in:sent_via", ["user", "external_device"]]);
    expect(filtrosDaRespostaHumana).toContainEqual(["gt:created_at", "2026-10-03T21:05:58.000Z"]);
  });

  it("não deu para saber se alguém respondeu: falha fechado — não devolve", async () => {
    respostasHumanas = { data: null, error: { message: "timeout" } };

    await deriveMessageMedia(eventRow());

    expect(devolverMock).not.toHaveBeenCalled();
    expect(dispatchesEmitidos()).toHaveLength(0);
  });

  it("handoff por decisão humana (sem a marca) continua permanente — controle", async () => {
    // Sem `handoff_tecnico` no metadata: pedido explícito, opt-out, 'Assumir eu',
    // pausa manual. A derivação concluir não muda nada aqui.
    conversaRow = conversaEmHandoff({ last_handoff_reason: "requested_human", metadata: {} });

    await deriveMessageMedia(eventRow());

    expect(devolverMock).not.toHaveBeenCalled();
    expect(updateConversasMock).not.toHaveBeenCalled();
    expect(dispatchesEmitidos()).toHaveLength(0);
  });

  it("marca de OUTRO handoff (motivo gravado divergiu) não vale para este — controle", async () => {
    // Um handoff posterior, por outro motivo, sobrescreveu `last_handoff_reason`:
    // a marca antiga não pode devolver a conversa do handoff novo.
    conversaRow = conversaEmHandoff({
      last_handoff_reason: "requested_human",
      metadata: marca(),
    });

    await deriveMessageMedia(eventRow());

    expect(devolverMock).not.toHaveBeenCalled();
    expect(updateConversasMock).not.toHaveBeenCalled();
    expect(dispatchesEmitidos()).toHaveLength(0);
  });

  it("silêncio NÃO formal (pausa manual com prazo) não é devolvido — controle", async () => {
    conversaRow = conversaEmHandoff({
      bot_silenced_until: "2026-10-04T21:05:58.000Z",
      metadata: marca(),
    });

    await deriveMessageMedia(eventRow());

    expect(devolverMock).not.toHaveBeenCalled();
    expect(updateConversasMock).not.toHaveBeenCalled();
    expect(dispatchesEmitidos()).toHaveLength(0);
  });
});
