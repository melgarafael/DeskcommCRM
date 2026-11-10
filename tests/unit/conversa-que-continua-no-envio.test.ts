/**
 * #3732 — a RECUSA diz para onde ir.
 *
 * ─── O que a issue mediu ────────────────────────────────────────────────────
 *
 * Numa empresa com um número por vendedor, a conversa antiga não pôde seguir o
 * vendedor (o contato já tem conversa no número dele): ela fica com o dono novo
 * num número que não é dele, e o envio responde
 *
 *   "Esta conversa está no número de outro atendente, e você tem número próprio.
 *    Responda ao cliente pela conversa do seu número, ou peça que esta seja
 *    transferida para você."
 *
 * — mandando transferir uma conversa que já é de quem está tentando responder.
 * A pessoa não sabia para onde ir.
 *
 * ─── O que este arquivo prova ───────────────────────────────────────────────
 *
 * 1. Com continuação no número de quem envia, a recusa leva o ID da conversa
 *    nova e o nome de quem atende, e a frase aponta para lá.
 * 2. Com continuação no número de OUTRA pessoa, a frase nomeia essa pessoa.
 * 3. CONTROLE: sem continuação (o banco devolve nulo), a frase de sempre fica —
 *    a guarda do número não muda de comportamento por causa do aviso.
 *
 * O banco é dublado: a regra de "qual conversa continua" mora na
 * `fn_conversa_que_continua` (migration 9054) e é medida em
 * `tests/invariants/o-numero-segue-o-vendedor.test.ts`. Aqui o que se mede é o
 * contrato da ROTA: o detalhe chega no 409, junto com a frase.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const admin = vi.hoisted(() => ({ rpc: vi.fn(), linha: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = admin.linha;
    return { rpc: admin.rpc, from: () => chain };
  },
}));

// Service role "configurada": é ela que autoriza a leitura da conversa nova, que
// pode estar com outra pessoa. O resto do módulo de auditoria segue real.
vi.mock("@/lib/audit", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, isServiceRoleConfigured: () => true };
});

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSAO_DO_COLEGA = "44444444-4444-4444-8444-444444444444";
const EU = "55555555-5555-4555-8555-555555555555";
const COLEGA = "77777777-7777-4777-8777-777777777777";
const POLITICA = "88888888-8888-4888-8888-888888888888";
const MINHA_POLITICA = "99999999-9999-4999-8999-999999999999";
const MINHA_SESSAO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** A conversa NOVA do mesmo contato, no número de quem responde. */
const CONVERSA_NOVA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const conversa = {
  id: CONV,
  organization_id: ORG,
  contact_id: CONTACT,
  channel_session_id: SESSAO_DO_COLEGA,
  is_group: false,
  group_chat_id: null,
  bot_silenced_until: null,
  provider_conversation_id: null,
  last_inbound_at: new Date().toISOString(),
  contacts: {
    phone_number: "+551****9999",
    wa_identity: null,
    wa_lid: null,
    is_blocked: false,
    is_personal: false,
  },
  channel_sessions: { provider: "zernio", status: "WORKING", archived_at: null },
};

const texto = (): SendMessageInput =>
  ({ conversation_id: CONV, type: "text", body: "oi" }) as SendMessageInput;

/** EU tenho número próprio; a conversa está no número do COLEGA. */
function euComMeuNumero() {
  return criarDubleDoHandler({
    conversation: conversa,
    politicasDeNumero: [
      { id: POLITICA, organization_id: ORG, channel_session_id: SESSAO_DO_COLEGA },
      { id: MINHA_POLITICA, organization_id: ORG, channel_session_id: MINHA_SESSAO },
    ],
    responsaveisDeNumero: [
      { policy_id: POLITICA, user_id: COLEGA, organization_id: ORG },
      { policy_id: MINHA_POLITICA, user_id: EU, organization_id: ORG },
    ],
    sessoesDeNumero: [
      { id: MINHA_SESSAO, provider: "zernio", status: "WORKING", archived_at: null, metadata: {} },
    ],
  });
}

async function enviar(): Promise<ApiError> {
  const duble = euComMeuNumero();
  const ctx: HandlerCtx = {
    organization_id: ORG,
    actor: { type: "user", id: EU },
    requestId: "req-3732",
  };
  const resultado = await sendMessageHandler(duble.supabase, ctx, texto()).catch(
    (e: unknown) => e,
  );
  expect(resultado).toBeInstanceOf(ApiError);
  return resultado as ApiError;
}

beforeEach(() => {
  vi.clearAllMocks();
  admin.rpc.mockResolvedValue({ data: null, error: null });
  admin.linha.mockResolvedValue({ data: null, error: null });
});

describe("#3732 — a recusa do envio leva para a conversa que continua", () => {
  it("⭐ a conversa continua no SEU número: o 409 leva o id e fala do próprio número", async () => {
    admin.rpc.mockResolvedValue({ data: CONVERSA_NOVA, error: null });
    admin.linha.mockResolvedValue({
      data: { id: CONVERSA_NOVA, assigned_to_user_id: EU, assigned_to_user_name: "Ana Vendedora" },
      error: null,
    });

    const err = await enviar();

    expect(err.status).toBe(409);
    expect(err.code).toBe("conversa_em_numero_de_outro_atendente");
    expect(err.details).toMatchObject({
      conversa_que_continua: { id: CONVERSA_NOVA, nome: "Ana Vendedora", propria: true },
    });
    expect(err.message).toMatch(/seu número/i);
    expect(err.message).toMatch(/Abra a conversa/i);
    // A regra do banco é consultada com a conversa e QUEM envia — nunca com id
    // vindo do corpo da requisição.
    expect(admin.rpc).toHaveBeenCalledWith("fn_conversa_que_continua", {
      p_organization_id: ORG,
      p_conversation_id: CONV,
      p_user_id: EU,
    });
  });

  it("a conversa continua pelo número de OUTRA pessoa: a frase nomeia quem atende", async () => {
    admin.rpc.mockResolvedValue({ data: CONVERSA_NOVA, error: null });
    admin.linha.mockResolvedValue({
      data: { id: CONVERSA_NOVA, assigned_to_user_id: COLEGA, assigned_to_user_name: "Bruno Vendedor" },
      error: null,
    });

    const err = await enviar();

    expect(err.message).toMatch(/pelo número de Bruno Vendedor/i);
    expect(err.details).toMatchObject({
      conversa_que_continua: { id: CONVERSA_NOVA, nome: "Bruno Vendedor", propria: false },
    });
  });

  it("a conversa que continua está SEM dono (a IA atende, doc 237 3-B): fala do seu número", async () => {
    // Ela está sempre num número de quem envia; sem dono, "no número de outro
    // atendente" seria falso.
    admin.rpc.mockResolvedValue({ data: CONVERSA_NOVA, error: null });
    admin.linha.mockResolvedValue({
      data: { id: CONVERSA_NOVA, assigned_to_user_id: null, assigned_to_user_name: null },
      error: null,
    });

    const err = await enviar();

    expect(err.message).toMatch(/seu número/i);
    expect(err.details).toMatchObject({
      conversa_que_continua: { id: CONVERSA_NOVA, nome: null, propria: true },
    });
  });

  it("CONTROLE: sem continuação, a frase de sempre fica e o detalhe não aparece", async () => {
    const err = await enviar();

    expect(err.status).toBe(409);
    expect(err.message).toMatch(/número de outro atendente/i);
    expect(err.details).not.toHaveProperty("conversa_que_continua");
  });
});
