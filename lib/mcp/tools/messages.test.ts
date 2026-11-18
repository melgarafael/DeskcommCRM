/**
 * crm_send_whatsapp_message passa pelo freio anti-ban do número antes de
 * enviar, e conta no ledger o envio que saiu (`ritmo-do-envio-por-token.ts`).
 *
 * E a idempotência das duas ferramentas de envio deste arquivo (#1613, item B):
 * a chave é RESERVADA antes do efeito (`comIdempotencia`), o hash do pedido é
 * comparado e o recibo vencido não conta. Antes, cada ferramenta lia, enviava
 * e só depois gravava — duas chamadas simultâneas enviavam as duas, a mesma
 * chave com outro texto devolvia a resposta antiga e um recibo vencido seguia
 * valendo. O banco falso é o mesmo da publicação de Status: unicidade por
 * (endpoint, chave), filtro de janela e recibo terminal na mesma linha.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/messaging/ritmo-do-envio-por-token", () => ({
  depsDoRitmo: vi.fn(async () => ({})),
  segurarEnvioPorToken: vi.fn(async () => null),
  registrarEnvioPorToken: vi.fn(async () => {}),
}));
// `crm_send_material`: a preparação do arquivo é dublê — o que se mede aqui é
// a chave, não a cópia no Storage.
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({})) }));
vi.mock("@/lib/materiais/copiar-no-storage", () => ({ copiarMaterialNoStorage: vi.fn(() => ({})) }));
vi.mock("@/lib/agent-engine/agent/materiais-da-empresa", () => ({
  // `null` é o canal de quem não declarou outro — a régua do material o lê como WhatsApp.
  canalDaConversa: vi.fn(async () => null),
  prepararMaterialDaEmpresa: vi.fn(async () => ({
    ok: true,
    anexo: {
      type: "document",
      storagePath: "org/conversa/catalogo.pdf",
      mime: "application/pdf",
      filename: "catalogo.pdf",
    },
    material: { id: "66666666-6666-4666-8666-666666666666", nome: "Catálogo" },
    legenda: "",
  })),
}));

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import type { McpContext } from "@/lib/mcp/types";
import { registrarEnvioPorToken, segurarEnvioPorToken } from "@/lib/messaging/ritmo-do-envio-por-token";
import { bancoFalso } from "@/tests/helpers/banco-falso-do-status";

import { crmSendMaterial, crmSendWhatsappMessage } from "./messages";

const mockedSend = vi.mocked(sendMessageHandler);
const mockedSegurar = vi.mocked(segurarEnvioPorToken);
const mockedRegistrar = vi.mocked(registrarEnvioPorToken);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const MATERIAL_ID = "66666666-6666-4666-8666-666666666666";
const CHAVE = "run-1:step-1";

const ctx = {
  organizationId: ORG_ID,
  role: "agent",
  actor: { type: "api_token", id: "tok" },
  apiTokenId: "tok",
  requestId: "req-1",
  supabase: {},
} as unknown as McpContext;

const input = { conversation_id: CONVERSATION_ID, body: "Oi!", type: "text" } as never;

beforeEach(() => {
  mockedSend.mockReset();
  mockedSegurar.mockReset();
  mockedRegistrar.mockClear();
});

describe("crm_send_whatsapp_message — freio anti-ban do número", () => {
  it("passa pelo freio ANTES de enviar e conta o envio que saiu", async () => {
    const segurado = { channelSessionId: SESSION_ID };
    mockedSegurar.mockResolvedValue(segurado);
    mockedSend.mockResolvedValue({
      id: "m1",
      status: "sent",
      external_id: "x",
      sent_at: "2026-09-22T12:00:00.000Z",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await crmSendWhatsappMessage.handler(input, ctx);

    expect(mockedSegurar).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG_ID,
      conversationId: CONVERSATION_ID,
      requestId: "req-1",
    });
    expect(mockedSegurar.mock.invocationCallOrder[0]!).toBeLessThan(
      mockedSend.mock.invocationCallOrder[0]!,
    );
    expect(mockedRegistrar).toHaveBeenCalledWith(expect.anything(), ORG_ID, segurado, "sent");
  });

  it("quando o freio recusa, a mensagem NÃO sai", async () => {
    mockedSegurar.mockRejectedValue(new ApiError(429, "rate_limited", undefined, "req-1"));
    await expect(crmSendWhatsappMessage.handler(input, ctx)).rejects.toBeInstanceOf(ApiError);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedRegistrar).not.toHaveBeenCalled();
  });
});

// ─── Idempotência (#1613, item B) ──────────────────────────────────────────

/** A mensagem que o envio devolve; o id muda a cada envio para provar QUAL resposta voltou. */
function mensagem(id: string) {
  return {
    id,
    status: "sent",
    external_id: `wamid.${id}`,
    sent_at: "2026-11-17T12:00:00.000Z",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

type Ferramenta = {
  nome: string;
  endpoint: string;
  chamar: (body: string, chave: string | undefined, contexto: McpContext) => Promise<unknown>;
};

const FERRAMENTAS: Ferramenta[] = [
  {
    nome: "crm_send_whatsapp_message",
    endpoint: "mcp:crm_send_whatsapp_message",
    chamar: (body, chave, contexto) =>
      crmSendWhatsappMessage.handler(
        {
          conversation_id: CONVERSATION_ID,
          body,
          type: "text",
          ...(chave ? { idempotency_key: chave } : {}),
        } as never,
        contexto,
      ),
  },
  {
    nome: "crm_send_material",
    endpoint: "mcp:crm_send_material",
    chamar: (body, chave, contexto) =>
      crmSendMaterial.handler(
        {
          conversation_id: CONVERSATION_ID,
          material_id: MATERIAL_ID,
          body,
          ...(chave ? { idempotency_key: chave } : {}),
        } as never,
        contexto,
      ),
  },
];

describe.each(FERRAMENTAS)("$nome — idempotência pela chave reservada (#1613, item B)", (f) => {
  const contexto = (db: McpContext["supabase"]): McpContext => ({ ...ctx, supabase: db });

  beforeEach(() => {
    mockedSegurar.mockResolvedValue(null);
    mockedSend.mockResolvedValueOnce(mensagem("m1")).mockResolvedValueOnce(mensagem("m2"));
  });

  it("mesma chave, mesmo corpo: UM envio, e a segunda chamada devolve o recibo gravado", async () => {
    const { db, idem } = bancoFalso();

    const primeira = await f.chamar("Oi!", CHAVE, contexto(db));
    const segunda = await f.chamar("Oi!", CHAVE, contexto(db));

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(primeira).toMatchObject({ message_id: "m1" });
    expect(primeira).not.toHaveProperty("deduplicated");
    expect(segunda).toEqual({ ...(primeira as object), deduplicated: true });
    // O recibo continua no endpoint de sempre: a tag não mudou com o conserto.
    expect([...idem.values()].map((l) => l.endpoint)).toEqual([f.endpoint]);
  });

  it("(1) mesma chave com corpo DIFERENTE: 409 idempotency_conflict, sem segundo envio", async () => {
    const { db } = bancoFalso();

    await f.chamar("Oi!", CHAVE, contexto(db));
    const erro = await f.chamar("Outro texto", CHAVE, contexto(db)).then(
      () => null,
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(ApiError);
    expect(erro).toMatchObject({ status: 409, code: "idempotency_conflict" });
    // O servidor MCP devolve só a MENSAGEM do erro: o código tem de estar nela.
    expect((erro as Error).message).toMatch(/^idempotency_conflict: /);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it("(2) segunda chamada com a primeira em curso: 409 idempotency_in_progress, sem segundo envio", async () => {
    const { db } = bancoFalso();
    let chegouAoEnvio!: () => void;
    const chegada = new Promise<void>((r) => (chegouAoEnvio = r));
    let liberarEnvio!: (m: unknown) => void;
    mockedSend.mockReset().mockImplementationOnce(() => {
      chegouAoEnvio();
      return new Promise((r) => (liberarEnvio = r)) as never;
    });
    mockedSend.mockResolvedValue(mensagem("m2"));

    const primeira = f.chamar("Oi!", CHAVE, contexto(db));
    await chegada;
    const segunda = await f.chamar("Oi!", CHAVE, contexto(db)).then(
      () => null,
      (e: unknown) => e,
    );
    liberarEnvio(mensagem("m1"));
    const respostaDaPrimeira = await primeira;

    expect(segunda).toBeInstanceOf(ApiError);
    expect(segunda).toMatchObject({ status: 409, code: "idempotency_in_progress" });
    expect((segunda as Error).message).toMatch(/^idempotency_in_progress: /);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    // O freio mora DENTRO do efeito: quem não executa não gasta o freio.
    expect(mockedSegurar).toHaveBeenCalledTimes(1);
    expect(respostaDaPrimeira).toMatchObject({ message_id: "m1" });
  });

  it("(3) recibo VENCIDO não conta: a mesma chave envia de novo", async () => {
    const { db, idem } = bancoFalso();

    await f.chamar("Oi!", CHAVE, contexto(db));
    for (const linha of idem.values()) linha.expires_at = "2000-01-01T00:00:00.000Z";
    const depois = await f.chamar("Oi!", CHAVE, contexto(db));

    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(depois).toMatchObject({ message_id: "m2" });
    expect(depois).not.toHaveProperty("deduplicated");
    // A linha velha é retomada, não duplicada.
    expect(idem.size).toBe(1);
  });

  it("(4) sem chave: envia a cada chamada e não grava recibo nenhum", async () => {
    const { db, idem } = bancoFalso();

    const primeira = await f.chamar("Oi!", undefined, contexto(db));
    const segunda = await f.chamar("Oi!", undefined, contexto(db));

    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(primeira).toMatchObject({ message_id: "m1" });
    expect(segunda).toMatchObject({ message_id: "m2" });
    expect(segunda).not.toHaveProperty("deduplicated");
    expect(idem.size).toBe(0);
  });
});
