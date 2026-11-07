/**
 * #3642 — NO ENVIO: quem não responde pelo número desta conversa não fala por ele.
 *
 * A peça do banco (migration 9039) faz o número SEGUIR o dono na transferência e
 * na troca de carteira. Esta prova a segunda tranca, a do envio humano: o dono
 * novo que — por qualquer motivo — ficou numa conversa que está no número de
 * outra pessoa recebe uma recusa CLARA, e nada sai pelo WhatsApp do colega.
 *
 * O caso que a issue chama de grave: o vendedor tem número próprio, a
 * conversa está no número de outro. Antes, a mensagem saía pela sessão da
 * conversa — o cliente recebia no número do antigo e o antigo continuava
 * recebendo as respostas no celular dele.
 *
 * Os controles estão aqui de propósito, para a guarda não virar parede:
 *  - quem NÃO tem número próprio (o gerente fora da lista, numa empresa com um
 *    número só) responde como hoje — doc 237, escolha 1-B;
 *  - número próprio desconectado, ou de OUTRO canal, não conta como "ter
 *    número" — a mesma régua da transferência;
 *  - número COMPARTILHADO (os dois na lista): envia;
 *  - instalação sem um número por vendedor: nada muda;
 *  - ator NÃO humano (token de integração, IA): nada muda — a regra é de quem
 *    digita no Inbox.
 */
import { describe, expect, it } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSAO_DO_COLEGA = "44444444-4444-4444-8444-444444444444";
const SESSAO_COMPARTILHADA = "66666666-6666-4666-8666-666666666666";
const EU = "55555555-5555-4555-8555-555555555555";
const COLEGA = "77777777-7777-4777-8777-777777777777";
const POLITICA = "88888888-8888-4888-8888-888888888888";
const MINHA_POLITICA = "99999999-9999-4999-8999-999999999999";
const MINHA_SESSAO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const conversa = (sessao: string) => ({
  id: CONV,
  organization_id: ORG,
  contact_id: CONTACT,
  channel_session_id: sessao,
  is_group: false,
  group_chat_id: null,
  bot_silenced_until: null,
  provider_conversation_id: null,
  last_inbound_at: new Date().toISOString(),
  contacts: {
    phone_number: "+5511999999999",
    wa_identity: null,
    wa_lid: null,
    is_blocked: false,
    is_personal: false,
  },
  channel_sessions: { provider: "zernio", status: "WORKING", archived_at: null },
});

const texto = (): SendMessageInput =>
  ({ conversation_id: CONV, type: "text", body: "oi" }) as SendMessageInput;

async function enviar(opcoes: {
  sessao: string;
  politicas?: Array<Record<string, unknown>>;
  responsaveis?: Array<Record<string, unknown>>;
  sessoes?: Array<Record<string, unknown>>;
  actor?: HandlerCtx["actor"];
}) {
  const duble = criarDubleDoHandler({
    conversation: conversa(opcoes.sessao),
    politicasDeNumero: opcoes.politicas,
    responsaveisDeNumero: opcoes.responsaveis,
    sessoesDeNumero: opcoes.sessoes,
  });
  const ctx: HandlerCtx = {
    organization_id: ORG,
    actor: opcoes.actor ?? { type: "user", id: EU },
    requestId: "req-3642",
  };
  const resultado = await sendMessageHandler(duble.supabase, ctx, texto()).catch(
    (e: unknown) => e,
  );
  return { resultado, duble };
}

const politicaDaSessaoDoColega = [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO_DO_COLEGA }];

/** O colega na lista do número da conversa, e EU com o meu número próprio. */
const comMeuNumero = (sessao: Record<string, unknown>) => ({
  sessao: SESSAO_DO_COLEGA,
  politicas: [
    ...politicaDaSessaoDoColega,
    { id: MINHA_POLITICA, organization_id: ORG, channel_session_id: MINHA_SESSAO },
  ],
  responsaveis: [
    { policy_id: POLITICA, user_id: COLEGA, organization_id: ORG },
    { policy_id: MINHA_POLITICA, user_id: EU, organization_id: ORG },
  ],
  sessoes: [
    { id: MINHA_SESSAO, provider: "zernio", status: "WORKING", archived_at: null, metadata: {}, ...sessao },
  ],
});

/** Recusado pela guarda do número? (Outro desfecho do dublê não importa aqui.) */
const recusadoPeloNumero = (resultado: unknown) =>
  resultado instanceof ApiError && resultado.code === "conversa_em_numero_de_outro_atendente";

describe("#3642 — o envio humano não fala pelo número do colega", () => {
  it("⭐ vendedor com número PRÓPRIO conectado numa conversa no número do colega: 409, e nada é gravado", async () => {
    const { resultado, duble } = await enviar(comMeuNumero({}));

    expect(resultado).toBeInstanceOf(ApiError);
    const err = resultado as ApiError;
    expect(err.status).toBe(409);
    expect(err.code).toBe("conversa_em_numero_de_outro_atendente");
    expect(err.message).toMatch(/número de outro atendente/i);
    // E o que importa de verdade: nada saiu. Nem mensagem, nem mudança na conversa.
    expect(duble.capturas.inserts.messages).toHaveLength(0);
    expect(duble.capturas.patches.conversations).toHaveLength(0);
  });

  it("⭐ doc 237, 1-B: o gerente SEM número próprio e fora da lista responde como hoje", async () => {
    const { resultado } = await enviar({
      sessao: SESSAO_DO_COLEGA,
      politicas: politicaDaSessaoDoColega,
      responsaveis: [{ policy_id: POLITICA, user_id: COLEGA, organization_id: ORG }],
      actor: { type: "user", id: EU, role: "manager" },
    });

    expect(recusadoPeloNumero(resultado)).toBe(false);
    if (resultado instanceof ApiError) expect(resultado.status).not.toBe(409);
  });

  it("número próprio DESCONECTADO não conta como ter número: responde como hoje", async () => {
    const { resultado } = await enviar(comMeuNumero({ status: "STOPPED" }));
    expect(recusadoPeloNumero(resultado)).toBe(false);
  });

  it("número próprio de OUTRO canal não conta: a conversa não iria para ele, e o envio não é barrado", async () => {
    const { resultado } = await enviar(comMeuNumero({ provider: "waha" }));
    expect(recusadoPeloNumero(resultado)).toBe(false);
  });

  it("número COMPARTILHADO: quem está na lista responde por ele e não é recusado", async () => {
    const { resultado } = await enviar({
      sessao: SESSAO_COMPARTILHADA,
      politicas: [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO_COMPARTILHADA }],
      responsaveis: [
        { policy_id: POLITICA, user_id: EU, organization_id: ORG },
        { policy_id: POLITICA, user_id: COLEGA, organization_id: ORG },
      ],
    });
    if (resultado instanceof ApiError) expect(resultado.status).not.toBe(409);
  });

  it("CONTROLE: instalação sem um número por vendedor (número sem policy) não muda", async () => {
    const { resultado } = await enviar({ sessao: SESSAO_DO_COLEGA });
    if (resultado instanceof ApiError) expect(resultado.status).not.toBe(409);
  });

  it("CONTROLE: token de integração e IA não são \"a pessoa do número\" — seguem como estavam", async () => {
    for (const actor of [
      { type: "api_token", id: "tok-1" },
      { type: "ai_agent", id: "ag-1", role: "agent" },
    ] as HandlerCtx["actor"][]) {
      const { resultado } = await enviar({
        sessao: SESSAO_DO_COLEGA,
        politicas: politicaDaSessaoDoColega,
        responsaveis: [{ policy_id: POLITICA, user_id: COLEGA, organization_id: ORG }],
        actor,
      });
      if (resultado instanceof ApiError) expect(resultado.status).not.toBe(409);
    }
  });
});
