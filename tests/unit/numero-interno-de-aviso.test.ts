/**
 * O NÚMERO QUE RECEBE OS AVISOS É INTERNO — nada que venha dele vira atendimento.
 *
 * ## O que acontece sem o corte
 *
 * A equipe responde "ok" ao aviso. Essa mensagem entra pelo webhook como
 * qualquer outra e, na ordem em que os efeitos rodam hoje, vira: um CONTATO com
 * o número do plantão, uma CONVERSA, uma linha em `messages`, um pedido de
 * rodízio (o trigger dispara no INSERT da conversa), possivelmente um CARD no
 * funil, e um despacho do agente — a IA passa a conversar com o próprio
 * suporte. Um "cancelar" digitado ali chega a bloquear o "contato", que é a
 * equipe.
 *
 * ## As três decisões que este arquivo guarda
 *
 * **1. As DUAS grafias do nono dígito.** O suporte cadastrado com 9 e registrado
 * sem (ou o contrário) é a causa número um de "configurei e as mensagens
 * sumiram" — só que aqui o sintoma é o inverso: o corte não pega, e o número do
 * plantão vira lead.
 *
 * **2. O ramo do identificador opaco.** Quem está em modo privacidade chega sem
 * telefone nenhum, com um identificador que o canal inventa. Sem casar por ele,
 * o corte falha justamente para esse destinatário — e ele é comum em celular
 * corporativo.
 *
 * **3. A leitura IGNORA `ligado`.** Número configurado é interno mesmo com o
 * aviso pausado. Do contrário, pausar o aviso numa sexta transformaria o número
 * do suporte em lead na segunda — e ninguém ligaria uma coisa à outra.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  TTL_DO_CACHE_MS,
  ehNumeroInternoDeAviso,
  ehOChatDoAviso,
  lerNumeroInternoDeAviso,
  limparCacheDoNumeroInterno,
} from "@/lib/escalacao/numero-interno-de-aviso";

const ORG = "11111111-1111-4111-8111-111111111111";

/** Client falso que conta as idas ao banco — é o que mede o cache. */
function fakeDb(linha: Record<string, unknown> | null) {
  let leituras = 0;
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => {
      leituras += 1;
      return { data: linha, error: null };
    },
  };
  return {
    db: { from: () => builder } as unknown as SupabaseClient,
    leituras: () => leituras,
  };
}

beforeEach(() => {
  limparCacheDoNumeroInterno();
});

describe("ehOChatDoAviso — a regra pura", () => {
  const cfg = { destino: "+5531998966398", jid: "224466@lid" };

  it("casa o telefone exato", () => {
    expect(ehOChatDoAviso({ kind: "phone", phone: "+5531998966398", lid: null }, cfg)).toBe(true);
  });

  it("casa a OUTRA grafia do nono dígito — a mesma pessoa, dois cadastros", () => {
    expect(ehOChatDoAviso({ kind: "phone", phone: "+553198966398", lid: null }, cfg)).toBe(true);
  });

  it("não casa outro número", () => {
    expect(ehOChatDoAviso({ kind: "phone", phone: "+5511988887777", lid: null }, cfg)).toBe(false);
  });

  it("casa o identificador opaco pelo JID que o transporte resolveu", () => {
    expect(ehOChatDoAviso({ kind: "lid", phone: null, lid: "224466" }, cfg)).toBe(true);
    expect(ehOChatDoAviso({ kind: "lid", phone: null, lid: "999999" }, cfg)).toBe(false);
  });

  it("sem JID gravado, o identificador opaco NÃO casa — e isso é o buraco declarado", () => {
    // O JID só é conhecido depois do PRIMEIRO aviso enviado. Antes disso, uma
    // resposta de quem está em modo privacidade passa. É por isso que o handler
    // grava `destino_jid` no sucesso do envio, e não em outro momento.
    expect(
      ehOChatDoAviso({ kind: "lid", phone: null, lid: "224466" }, { destino: "+5531998966398", jid: null }),
    ).toBe(false);
  });

  it("@lid com o telefone alternativo do payload casa pelo telefone, mesmo sem JID", () => {
    // O transporte resolve o destino por telefone (`<tel>@c.us`): `destino_jid`
    // nunca vira `@lid`, e o reconhecimento vem do `remoteJidAlt`.
    expect(
      ehOChatDoAviso({ kind: "lid", phone: "+5531998966398", lid: "224466" }, { destino: "+5531998966398", jid: "5531998966398@c.us" }),
    ).toBe(true);
    expect(
      ehOChatDoAviso({ kind: "lid", phone: "+5511988887777", lid: "777" }, { destino: "+5531998966398", jid: "5531998966398@c.us" }),
    ).toBe(false);
  });

  it("sem configuração nenhuma, nada casa", () => {
    expect(ehOChatDoAviso({ kind: "phone", phone: "+5531998966398", lid: null }, { destino: null, jid: null })).toBe(
      false,
    );
  });

  it("grupo e formato desconhecido nunca casam", () => {
    expect(ehOChatDoAviso({ kind: "group", phone: null, lid: null }, cfg)).toBe(false);
    expect(ehOChatDoAviso({ kind: "unknown", phone: null, lid: null }, cfg)).toBe(false);
  });
});

describe("lerNumeroInternoDeAviso — a leitura quente", () => {
  it("A LEITURA IGNORA `ligado`: número configurado é interno mesmo com o aviso pausado", async () => {
    // Se a leitura filtrasse por `ligado`, pausar o aviso transformaria o número
    // do suporte em lead na semana seguinte — e ninguém ligaria uma coisa à
    // outra. A consulta NÃO pergunta pelo campo, e é isso que este caso mede.
    const { db } = fakeDb({ telefone_destino: "+5531998966398", destino_jid: null, ligado: false });
    const cfg = await lerNumeroInternoDeAviso(db, ORG);
    expect(cfg.destino).toBe("+5531998966398");
    expect(await ehNumeroInternoDeAviso(db, ORG, { kind: "phone", phone: "+5531998966398", lid: null })).toBe(
      true,
    );
  });

  it("organização sem configuração devolve vazio e não casa nada", async () => {
    const { db } = fakeDb(null);
    expect(await lerNumeroInternoDeAviso(db, ORG)).toEqual({
      destino: null, jid: null, respostaWhatsappHabilitada: false, sessaoId: null,
    });
    expect(await ehNumeroInternoDeAviso(db, ORG, { kind: "phone", phone: "+5531998966398", lid: null })).toBe(
      false,
    );
  });

  it("a segunda leitura no mesmo instante NÃO vai ao banco", async () => {
    // Isto roda em TODO webhook de mensagem. Sem cache, o corte custa uma ida ao
    // banco por mensagem recebida na instalação inteira.
    const { db, leituras } = fakeDb({ telefone_destino: "+5531998966398", destino_jid: null });
    await lerNumeroInternoDeAviso(db, ORG);
    await lerNumeroInternoDeAviso(db, ORG);
    expect(leituras()).toBe(1);
  });

  it("o cache expira em 30 s — trocar o número não leva meia hora para valer", async () => {
    const { db, leituras } = fakeDb({ telefone_destino: "+5531998966398", destino_jid: null });
    const base = Date.now();
    const relogio = vi.spyOn(Date, "now");
    relogio.mockReturnValue(base);
    await lerNumeroInternoDeAviso(db, ORG);
    relogio.mockReturnValue(base + TTL_DO_CACHE_MS - 1);
    await lerNumeroInternoDeAviso(db, ORG);
    expect(leituras(), "o cache expirou cedo demais").toBe(1);
    relogio.mockReturnValue(base + TTL_DO_CACHE_MS + 1);
    await lerNumeroInternoDeAviso(db, ORG);
    expect(leituras(), "o cache não expirou — número trocado continuaria valendo").toBe(2);
    relogio.mockRestore();
  });

  it("o cache é POR ORGANIZAÇÃO — o número de uma não responde pela outra", async () => {
    const { db, leituras } = fakeDb({ telefone_destino: "+5531998966398", destino_jid: null });
    await lerNumeroInternoDeAviso(db, ORG);
    await lerNumeroInternoDeAviso(db, "22222222-2222-4222-8222-222222222222");
    expect(leituras()).toBe(2);
  });

  it("falha de leitura NÃO vira `é interno` — o desfecho seguro é a mensagem passar", async () => {
    // Falhar fechado aqui significaria DESCARTAR mensagem de cliente sempre que
    // o banco engasgasse. A mensagem que passa indevidamente vira um contato a
    // mais; a mensagem descartada some para sempre.
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: null, error: { message: "boom" } }),
    };
    const db = { from: () => builder } as unknown as SupabaseClient;
    expect(await ehNumeroInternoDeAviso(db, ORG, { kind: "phone", phone: "+5531998966398", lid: null })).toBe(
      false,
    );
  });
});
