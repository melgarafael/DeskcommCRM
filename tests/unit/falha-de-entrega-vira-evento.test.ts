/**
 * A falha de entrega vira EVENTO que quem integra consegue assinar (#1614).
 *
 * Dois caminhos emitem `message.failed`, e é isto que fecha o buraco descrito
 * na issue: a linha virava `failed` sozinha, não havia gatilho de webhook para
 * ela, e o sistema do lado de fora seguia achando que a mensagem saiu.
 *
 *   1. falha de PRÉ-VOO do próprio envio (o `catch` do handler) — um evento por
 *      falha, com o payload que a issue pede;
 *   2. recusa que chega DEPOIS, pelo webhook de status da Meta — e aí o "uma
 *      vez" é o `.neq("status", "failed")`: a Meta reentrega o mesmo status
 *      enquanto não recebe 2xx, e cada reentegra seria um novo aviso para o
 *      integrador sobre a MESMA falha.
 *
 * O gatilho em si (`ENTIDADE_ESPERADA_POR_GATILHO`) e o registro que o drain
 * lê são cobertos pelos testes de fonte única (`gatilhos-em-uma-fonte`) e por
 * `evento-de-fato-nao-fica-pendente`; aqui fica o que só este caminho sabe.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { deriveActor } from "@/lib/mcp/auth";
import type { SendMessageInput } from "@/lib/schemas";
import { telefoneDoEmbed } from "@/lib/messaging/falha-de-entrega";
import { ENTIDADE_ESPERADA_POR_GATILHO } from "@/lib/schemas/webhooks";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/a.jpg" }, error: null }),
      }),
    },
  }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const TELEFONE = "+5531999998888";

const ctxToken: HandlerCtx = {
  organization_id: ORG,
  actor: deriveActor(["mcp:write"], "77777777-7777-4777-8777-777777777777"),
  requestId: "req-1614",
};

function conversa() {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    provider_conversation_id: null,
    // Janela ABERTA: aqui o que se testa é a falha, não o gate da janela.
    last_inbound_at: new Date(Date.now() - 3_600_000).toISOString(),
    contacts: { phone_number: TELEFONE, wa_identity: null, wa_lid: null, is_blocked: false },
    channel_sessions: {
      id: SESSION,
      organization_id: ORG,
      provider: "meta_cloud",
      waha_session_name: null,
      status: "WORKING",
      archived_at: null,
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("falha de entrega emite message.failed", () => {
  it("uma vez, com o payload que a issue pede, quando o envio falha no pré-voo", async () => {
    vi.stubEnv("META_PHONE_NUMBER_ID", "1103328999528818");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("conexao recusada")));

    const { supabase, capturas } = criarDubleDoHandler({ conversation: conversa() });
    const msg = await sendMessageHandler(supabase, ctxToken, {
      conversation_id: CONV,
      type: "text",
      body: "oi",
    } as SendMessageInput);

    expect((msg as { status: string }).status, "a linha não passou a failed").toBe("failed");

    const eventos = capturas.rpcs.filter(
      (r) => r.nome === "emit_event" && r.args.p_event_type === "message.failed",
    );
    expect(eventos, "uma falha, um aviso").toHaveLength(1);
    expect(eventos[0]!.args).toMatchObject({
      p_entity_kind: "message",
      p_entity_id: "msg-1",
      p_organization_id: ORG,
      p_payload: {
        message_id: "msg-1",
        conversation_id: CONV,
        contact_id: CONTACT,
        contact: TELEFONE,
        sent_via: "system",
        erro: { codigo: expect.any(String), titulo: expect.any(String) },
      },
    });
    expect(eventos[0]!.args.p_metadata).toMatchObject({ source: "messages-send" });
  });

  it("o gatilho existe e aponta para a entidade que o motor espera", () => {
    expect(ENTIDADE_ESPERADA_POR_GATILHO["message.failed"]).toBe("message");
  });

  it("o webhook da Meta emite só na PRIMEIRA recusa — a reentrega não vira segundo aviso", () => {
    // O guard é a cláusula do UPDATE: sem ela, a Meta reentregando o mesmo
    // `failed` (ela reentrega tudo que não recebe 2xx) regravaria a linha e
    // avisaria o integrador de novo sobre a mesma falha. Coberto na fonte
    // porque montar a rota inteira em teste custaria um dublê de NextRequest +
    // HMAC para provar UMA cláusula — e o que importa é que ela esteja lá.
    const rota = readFileSync("app/api/v1/webhooks/meta/[token]/route.ts", "utf8");
    const inicio = rota.indexOf('e.status === "failed"');
    expect(inicio, "o ramo de recusa sumiu da rota do webhook").toBeGreaterThan(-1);
    const ramo = rota.slice(inicio);
    expect(ramo).toContain('.neq("status", "failed")');
    expect(ramo).toContain("emitirFalhaDeEntrega");
    expect(ramo).toContain(".maybeSingle()");
    expect(ramo, "o telefone precisa ler o embed como objeto").toContain("telefoneDoEmbed(");
  });

  it("o telefone sai do embed N:1 como OBJETO (o que o PostgREST devolve) e como lista", () => {
    // Ler `contacts?.[0]` de um objeto dá undefined: o aviso saía sempre sem telefone.
    expect(telefoneDoEmbed({ phone_number: TELEFONE })).toBe(TELEFONE);
    expect(telefoneDoEmbed([{ phone_number: TELEFONE }])).toBe(TELEFONE);
    expect(telefoneDoEmbed(null)).toBeNull();
    expect(telefoneDoEmbed([])).toBeNull();
  });
});
