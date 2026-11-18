/**
 * crm_start_conversation_and_send — a tool compõe duas peças que já existem
 * (`openSharedContactConversation` + `sendMessageHandler`) e não deve
 * reimplementar nenhuma das duas. O teste prova a COMPOSIÇÃO: que a tool
 * passa `channel_session_id`/`contact_id`/`phone_number`/`name` para a
 * abertura de conversa, usa o `conversation_id` que ela devolveu — não um
 * `contact_id` de entrada não resolvido — para o envio, e que a chave de
 * idempotência cobre o PAR (abrir + enviar), não só o envio.
 *
 * A chave é RESERVADA antes do efeito (`comIdempotencia`, #1613 item B): o
 * banco falso de `idempotency_keys` é o mesmo da publicação de Status —
 * unicidade por (endpoint, chave), filtro de janela e recibo terminal na mesma
 * linha —, porque um dublê que só devolve "achei/não achei" não enxerga a
 * corrida, o hash nem a janela.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/messaging/open-shared-contact-conversation", () => ({
  openSharedContactConversation: vi.fn(),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/messaging/ritmo-do-envio-por-token", () => ({
  depsDoRitmo: vi.fn(async () => ({})),
  segurarEnvioPorToken: vi.fn(async () => null),
  registrarEnvioPorToken: vi.fn(async () => {}),
}));

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { registrarEnvioPorToken, segurarEnvioPorToken } from "@/lib/messaging/ritmo-do-envio-por-token";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import type { McpContext } from "@/lib/mcp/types";
import { bancoFalso, type Linha } from "@/tests/helpers/banco-falso-do-status";

import { crmStartConversationAndSend } from "./start-conversation";

const mockedOpen = vi.mocked(openSharedContactConversation);
const mockedSend = vi.mocked(sendMessageHandler);
const mockedSegurar = vi.mocked(segurarEnvioPorToken);
const mockedRegistrar = vi.mocked(registrarEnvioPorToken);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";
const OUTRA_CONVERSA = "77777777-7777-4777-8777-777777777777";

/** As linhas de `idempotency_keys`, por (endpoint, chave) — o mapa do banco falso. */
type IdemState = Map<string, Linha>;

function makeCtx(idem: IdemState = new Map()): McpContext {
  const { db: recibos } = bancoFalso({ idem });
  const supabase = {
    from: (table: string) => {
      // Spec 21: a tool confere `is_personal` antes de abrir. Sem pessoal na
      // base do teste, a consulta volta vazia e o fluxo segue igual a antes.
      // Spec 31 B1: a busca do telefone extra lê `contact_phones`; sem extra na
      // base do teste ela também volta vazia (`maybeSingle` com data nulo).
      if (table === "contacts" || table === "contact_phones") {
        const cadeia: Record<string, () => unknown> = {};
        for (const metodo of ["select", "eq", "in", "is", "limit"]) {
          cadeia[metodo] = () => cadeia;
        }
        cadeia["maybeSingle"] = () => Promise.resolve({ data: null, error: null });
        return cadeia;
      }
      if (table !== "idempotency_keys") throw new Error(`tabela inesperada: ${table}`);
      return recibos.from(table);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return {
    organizationId: ORG_ID,
    role: "manager",
    actor: { type: "user", id: "u1" },
    apiTokenId: "tok",
    requestId: "req-1",
    supabase,
  } as McpContext;
}

beforeEach(() => {
  mockedOpen.mockReset();
  mockedSend.mockReset();
  mockedSegurar.mockReset();
  mockedSegurar.mockResolvedValue(null);
  mockedRegistrar.mockClear();
});

describe("crm_start_conversation_and_send — freio anti-ban do número", () => {
  it("passa pelo freio ANTES de enviar e conta o envio que saiu", async () => {
    const segurado = { channelSessionId: SESSION_ID };
    mockedSegurar.mockResolvedValue(segurado);
    mockedOpen.mockResolvedValue({ conversation_id: CONVERSATION_ID, contact_id: CONTACT_ID });
    mockedSend.mockResolvedValue({
      id: MESSAGE_ID,
      status: "sent",
      external_id: "wamid.abc",
      sent_at: "2026-09-14T12:00:00.000Z",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await crmStartConversationAndSend.handler(
      { channel_session_id: SESSION_ID, contact_id: CONTACT_ID, body: "Oi!", type: "text" } as never,
      makeCtx(),
    );

    expect(mockedSegurar).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG_ID,
      channelSessionId: SESSION_ID,
      requestId: "req-1",
    });
    expect(mockedSegurar.mock.invocationCallOrder[0]!).toBeLessThan(
      mockedOpen.mock.invocationCallOrder[0]!,
    );
    expect(mockedRegistrar).toHaveBeenCalledWith(expect.anything(), ORG_ID, segurado, "sent");
  });

  it("quando o freio recusa, a conversa NÃO é aberta e a mensagem NÃO sai", async () => {
    mockedSegurar.mockRejectedValue(new ApiError(429, "rate_limited", undefined, "req-1"));
    mockedOpen.mockResolvedValue({ conversation_id: CONVERSATION_ID, contact_id: CONTACT_ID });

    await expect(
      crmStartConversationAndSend.handler(
        { channel_session_id: SESSION_ID, contact_id: CONTACT_ID, body: "Oi!", type: "text" } as never,
        makeCtx(),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedRegistrar).not.toHaveBeenCalled();
  });
});

describe("crm_start_conversation_and_send", () => {
  it("recusa sem contact_id e sem phone_number, antes de tocar o banco", async () => {
    const state: IdemState = new Map();
    const parsedInput = {
      channel_session_id: SESSION_ID,
      type: "text" as const,
    };

    await expect(
      crmStartConversationAndSend.handler(parsedInput as never, makeCtx(state)),
    ).rejects.toThrow(/contact_id ou phone_number/);

    expect(mockedOpen).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it.each([
    ["texto sem corpo", { type: "text" }],
    ["contato compartilhado sem o contato", { type: "contact", body: "Oi" }],
  ])("mensagem inválida (%s) é recusada ANTES de abrir a conversa", async (_nome, mensagem) => {
    await expect(
      crmStartConversationAndSend.handler(
        { channel_session_id: SESSION_ID, phone_number: "+5511999990000", ...mensagem } as never,
        makeCtx(),
      ),
    ).rejects.toThrow(/body, media_url/);

    expect(mockedSegurar).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("abre a conversa no canal escolhido e envia usando o conversation_id devolvido", async () => {
    const state: IdemState = new Map();
    mockedOpen.mockResolvedValue({ conversation_id: CONVERSATION_ID, contact_id: CONTACT_ID });
    mockedSend.mockResolvedValue({
      id: MESSAGE_ID,
      status: "sent",
      external_id: "wamid.abc",
      sent_at: "2026-09-14T12:00:00.000Z",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const ctx = makeCtx(state);
    const result = await crmStartConversationAndSend.handler(
      {
        channel_session_id: SESSION_ID,
        phone_number: "+55 11 91234-5678",
        name: "Cliente Novo",
        body: "Oi! Tudo bem?",
        type: "text",
      } as never,
      ctx,
    );

    // A abertura recebe exatamente o que o chamador mandou — inclusive o
    // canal, que é a lacuna que esta tool fecha (o create-contact antigo
    // escolhia sozinho).
    expect(mockedOpen).toHaveBeenCalledWith(ctx.supabase, ORG_ID, {
      channel_session_id: SESSION_ID,
      contact_id: undefined,
      phone_number: "+55 11 91234-5678",
      name: "Cliente Novo",
    });

    // O envio usa o conversation_id que a ABERTURA devolveu — nunca um
    // contact_id de entrada não resolvido nem um id inventado.
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const [, sendCtx, sendInput] = mockedSend.mock.calls[0]!;
    expect(sendCtx).toMatchObject({ organization_id: ORG_ID, requestId: "req-1" });
    expect(sendInput).toMatchObject({ conversation_id: CONVERSATION_ID, body: "Oi! Tudo bem?" });

    expect(result).toEqual({
      contact_id: CONTACT_ID,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      status: "sent",
      external_id: "wamid.abc",
      sent_at: "2026-09-14T12:00:00.000Z",
    });

    // Sem idempotency_key, nada é gravado.
    expect(state.size).toBe(0);
  });

  it("com idempotency_key, grava o recibo cobrindo o PAR abrir+enviar, no endpoint de sempre", async () => {
    const state: IdemState = new Map();
    mockedOpen.mockResolvedValue({ conversation_id: CONVERSATION_ID, contact_id: CONTACT_ID });
    mockedSend.mockResolvedValue({
      id: MESSAGE_ID,
      status: "queued",
      external_id: null,
      sent_at: "2026-09-14T12:00:00.000Z",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const ctx = makeCtx(state);
    await crmStartConversationAndSend.handler(
      {
        channel_session_id: SESSION_ID,
        contact_id: CONTACT_ID,
        body: "Oi!",
        type: "text",
        idempotency_key: "run-1:step-1",
      } as never,
      ctx,
    );

    expect(state.size).toBe(1);
    const gravado = [...state.values()][0]!;
    expect(gravado.key).toBe("run-1:step-1");
    expect(gravado.organization_id).toBe(ORG_ID);
    // A mesma tag de antes do conserto: o recibo não muda de endereço.
    expect(gravado.endpoint).toBe("mcp:crm_start_conversation_and_send");
    expect(gravado.status_code).toBe(200);
    expect(gravado.response_body).toMatchObject({
      contact_id: CONTACT_ID,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
    });
  });

  it("retry com a mesma idempotency_key NÃO abre outra conversa nem manda outra mensagem", async () => {
    const state: IdemState = new Map();
    mockedOpen.mockResolvedValue({ conversation_id: CONVERSATION_ID, contact_id: CONTACT_ID });
    mockedSend.mockResolvedValue({
      id: MESSAGE_ID,
      status: "sent",
      external_id: "wamid.abc",
      sent_at: "2026-09-14T12:00:00.000Z",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const pedido = {
      channel_session_id: SESSION_ID,
      contact_id: CONTACT_ID,
      body: "Oi!",
      type: "text",
      idempotency_key: "run-1:step-1",
    } as never;

    const primeira = await crmStartConversationAndSend.handler(pedido, makeCtx(state));
    const retry = await crmStartConversationAndSend.handler(pedido, makeCtx(state));

    expect(retry).toEqual({ ...(primeira as object), deduplicated: true });
    // O retry nem chega a abrir conversa nem a mandar mensagem — é o ponto
    // inteiro de ter idempotency_key num par abrir+enviar.
    expect(mockedOpen).toHaveBeenCalledTimes(1);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it("o hash sai do corpo que CHEGOU (o telefone), nunca do conversation_id resolvido", async () => {
    const state: IdemState = new Map();
    mockedOpen
      .mockResolvedValueOnce({ conversation_id: CONVERSATION_ID, contact_id: CONTACT_ID })
      .mockResolvedValueOnce({ conversation_id: OUTRA_CONVERSA, contact_id: CONTACT_ID });
    mockedSend.mockResolvedValue({
      id: MESSAGE_ID,
      status: "sent",
      external_id: null,
      sent_at: "2026-09-14T12:00:00.000Z",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const pedido = (chave: string) =>
      ({
        channel_session_id: SESSION_ID,
        phone_number: "+55 11 91234-5678",
        body: "Oi!",
        type: "text",
        idempotency_key: chave,
      }) as never;

    await crmStartConversationAndSend.handler(pedido("chave-a"), makeCtx(state));
    await crmStartConversationAndSend.handler(pedido("chave-b"), makeCtx(state));

    const [a, b] = [...state.values()];
    expect(a!.response_body).toMatchObject({ conversation_id: CONVERSATION_ID });
    expect(b!.response_body).toMatchObject({ conversation_id: OUTRA_CONVERSA });
    // Conversas resolvidas diferentes, MESMO pedido: a identidade é o que chegou.
    expect(a!.request_hash).toBe(b!.request_hash);
  });
});

// ─── Idempotência (#1613, item B) ──────────────────────────────────────────

describe("crm_start_conversation_and_send — idempotência pela chave reservada (#1613, item B)", () => {
  const CHAVE = "run-1:step-1";
  const pedido = (body: string, chave?: string) =>
    ({
      channel_session_id: SESSION_ID,
      contact_id: CONTACT_ID,
      body,
      type: "text",
      ...(chave ? { idempotency_key: chave } : {}),
    }) as never;
  const mensagem = (id: string) =>
    ({
      id,
      status: "sent",
      external_id: `wamid.${id}`,
      sent_at: "2026-11-17T12:00:00.000Z",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  beforeEach(() => {
    mockedOpen.mockResolvedValue({ conversation_id: CONVERSATION_ID, contact_id: CONTACT_ID });
    mockedSend.mockResolvedValueOnce(mensagem("m1")).mockResolvedValueOnce(mensagem("m2"));
  });

  it("(1) mesma chave com corpo DIFERENTE: 409 idempotency_conflict, sem abrir nem enviar de novo", async () => {
    const state: IdemState = new Map();

    await crmStartConversationAndSend.handler(pedido("Oi!", CHAVE), makeCtx(state));
    const erro = await crmStartConversationAndSend
      .handler(pedido("Outro texto", CHAVE), makeCtx(state))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(erro).toBeInstanceOf(ApiError);
    expect(erro).toMatchObject({ status: 409, code: "idempotency_conflict" });
    // O servidor MCP devolve só a MENSAGEM do erro: o código tem de estar nela.
    expect((erro as Error).message).toMatch(/^idempotency_conflict: /);
    expect(mockedOpen).toHaveBeenCalledTimes(1);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it("(2) segunda chamada com a primeira em curso: 409 idempotency_in_progress, sem segunda conversa nem segundo envio", async () => {
    const state: IdemState = new Map();
    let chegouAoEnvio!: () => void;
    const chegada = new Promise<void>((r) => (chegouAoEnvio = r));
    let liberarEnvio!: (m: unknown) => void;
    mockedSend.mockReset().mockImplementationOnce(() => {
      chegouAoEnvio();
      return new Promise((r) => (liberarEnvio = r)) as never;
    });
    mockedSend.mockResolvedValue(mensagem("m2"));

    const primeira = crmStartConversationAndSend.handler(pedido("Oi!", CHAVE), makeCtx(state));
    await chegada;
    const segunda = await crmStartConversationAndSend
      .handler(pedido("Oi!", CHAVE), makeCtx(state))
      .then(
        () => null,
        (e: unknown) => e,
      );
    liberarEnvio(mensagem("m1"));
    const respostaDaPrimeira = await primeira;

    expect(segunda).toBeInstanceOf(ApiError);
    expect(segunda).toMatchObject({ status: 409, code: "idempotency_in_progress" });
    expect((segunda as Error).message).toMatch(/^idempotency_in_progress: /);
    expect(mockedOpen).toHaveBeenCalledTimes(1);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    // O freio mora DENTRO do efeito: quem não executa não gasta o freio.
    expect(mockedSegurar).toHaveBeenCalledTimes(1);
    expect(respostaDaPrimeira).toMatchObject({ message_id: "m1" });
  });

  it("(3) recibo VENCIDO não conta: a mesma chave abre e envia de novo", async () => {
    const state: IdemState = new Map();

    await crmStartConversationAndSend.handler(pedido("Oi!", CHAVE), makeCtx(state));
    for (const linha of state.values()) linha.expires_at = "2000-01-01T00:00:00.000Z";
    const depois = await crmStartConversationAndSend.handler(pedido("Oi!", CHAVE), makeCtx(state));

    expect(mockedOpen).toHaveBeenCalledTimes(2);
    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(depois).toMatchObject({ message_id: "m2" });
    expect(depois).not.toHaveProperty("deduplicated");
    // A linha velha é retomada, não duplicada.
    expect(state.size).toBe(1);
  });

  it("(4) sem chave: abre e envia a cada chamada, e não grava recibo nenhum", async () => {
    const state: IdemState = new Map();

    const primeira = await crmStartConversationAndSend.handler(pedido("Oi!"), makeCtx(state));
    const segunda = await crmStartConversationAndSend.handler(pedido("Oi!"), makeCtx(state));

    expect(mockedOpen).toHaveBeenCalledTimes(2);
    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(primeira).toMatchObject({ message_id: "m1" });
    expect(segunda).toMatchObject({ message_id: "m2" });
    expect(segunda).not.toHaveProperty("deduplicated");
    expect(state.size).toBe(0);
  });
});
