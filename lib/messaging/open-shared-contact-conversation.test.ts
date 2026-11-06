/**
 * A CONVERSA DE "SALVAR E INICIAR CONVERSA" NASCE NO CANAL QUE ALCANÇA O CONTATO (#3483).
 *
 * ─── O que a issue pediu, e o que já existia ─────────────────────────────────
 *
 * O pedido é o botão do cadastro salvar e já abrir a conversa. O botão está nas
 * telas (`NewContactDialog`, `NewLeadDialog`) e chama ESTA rota —
 * `POST /conversations/open-with-contact` —, que é o caminho único de criação
 * de conversa: Contatos, funil, cartão de contato, painel do Inbox e MCP passam
 * todos por aqui. Não há segunda rota, e este arquivo não cria nenhuma.
 *
 * O que faltava era o SERVIDOR honrar o canal que a tela escolheu. A tela
 * filtra (`candidatosParaConversaNova`) e desabilita o que não pode ser
 * escolhido, mas filtro de tela não é defesa: o corpo do POST carrega
 * `channel_session_id`, e até aqui a rota só perguntava se a sessão existia
 * NAQUELA organização. Um canal DESLIGADO pelo operador (`metadata.disabled`,
 * #2318) ou INATIVO (`STOPPED`, `FAILED`, `SCAN_QR_CODE`) aceitava a abertura e
 * criava a conversa vazia — exatamente a conversa que a issue manda não criar.
 *
 * ─── O segundo lado: a corrida da lista de canais ───────────────────────────
 *
 * Sem `channel_session_id` — o caminho que a tela toma quando a lista de canais
 * ainda não chegou, ou falhou — quem escolhe a sessão é `sessaoProntaParaEnvio`,
 * pela ordem de criação. Numa organização que pareou Instagram antes do
 * WhatsApp, a conversa de um contato que TEM telefone nascia no canal social,
 * que não disca número nenhum: o cadastro salvo, a conversa "aberta" e a
 * primeira mensagem recusada por um canal que nunca poderia alcançar o destino
 * (`preferirTelefone`, #3358). O contato criado à mão já pedia a preferência
 * (`lib/contacts/conversa-ao-criar.ts`); esta porta, que é a do botão, não.
 *
 * ─── O que se mede aqui, e o que NÃO se mede ─────────────────────────────────
 *
 * Dublê, não banco. Mede-se o que ESTA função decide antes de delegar: qual
 * sessão ela manda para `fn_service_begin`, e quando ela recusa antes de
 * mandar. Que o `fn_service_begin` então reaproveite a conversa existente em
 * vez de inserir outra é invariante de Postgres (índice único por organização,
 * contato e sessão) e não se prova com dublê.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { PROVIDERS_DE_MENSAGEM, PROVIDERS_DE_TELEFONE } from "@/lib/channels/capabilities";

import { openSharedContactConversation } from "./open-shared-contact-conversation";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const TELEFONE = "5532999990000";

/** As capacidades, e não os fornecedores: uma sessão disca, a outra não. */
const PROVIDER_QUE_DISCA = PROVIDERS_DE_TELEFONE[0];
const PROVIDER_SOCIAL = PROVIDERS_DE_MENSAGEM.find(
  (p) => !(PROVIDERS_DE_TELEFONE as readonly string[]).includes(p),
)!;

type Linha = Record<string, unknown>;

const ID_WHATSAPP = "sessao-whatsapp";
const ID_INSTAGRAM = "sessao-instagram";

const WHATSAPP: Linha = {
  id: ID_WHATSAPP,
  organization_id: ORG,
  provider: PROVIDER_QUE_DISCA,
  phone_number: "+5532999990000",
  status: "WORKING",
  metadata: null,
  archived_at: null,
  created_at: "2026-06-01T00:00:00Z",
};

/** A social é MAIS ANTIGA: por ordem de criação ela é quem ganha. */
const INSTAGRAM: Linha = {
  id: ID_INSTAGRAM,
  organization_id: ORG,
  provider: PROVIDER_SOCIAL,
  phone_number: null,
  status: "WORKING",
  metadata: null,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
};

/**
 * `from(...)` encadeável, como o PostgREST: guarda predicados e só resolve no
 * `await`. Cobre o que `sessaoProntaParaEnvio` e esta função usam — `select`,
 * `eq`, `in`, `is`, `order`, `limit`, `maybeSingle`.
 */
function bancoDeMentira(sessoes: Linha[]) {
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const leituras: string[] = [];

  function tabela(nome: string): Linha[] {
    if (nome === "channel_sessions") return sessoes;
    if (nome === "contacts") return [{ id: CONTATO, organization_id: ORG, is_personal: false }];
    return [];
  }

  const from = (nome: string) => {
    leituras.push(nome);
    let atual = [...tabela(nome)];
    let teto: number | null = null;
    const cadeia = {
      select: () => cadeia,
      order: (coluna: string) => {
        atual = [...atual].sort((a, b) =>
          String(a[coluna] ?? "").localeCompare(String(b[coluna] ?? "")),
        );
        return cadeia;
      },
      eq: (c: string, v: unknown) => {
        atual = atual.filter((l) => l[c] === v);
        return cadeia;
      },
      is: (c: string, v: unknown) => {
        atual = atual.filter((l) => (l[c] ?? null) === v);
        return cadeia;
      },
      in: (c: string, vs: unknown[]) => {
        atual = atual.filter((l) => vs.includes(l[c]));
        return cadeia;
      },
      limit: (n: number) => {
        teto = n;
        return cadeia;
      },
      maybeSingle: async () => ({ data: (teto === null ? atual : atual.slice(0, teto))[0] ?? null, error: null }),
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) =>
        ok({ data: teto === null ? atual : atual.slice(0, teto), error: null }),
    };
    return cadeia;
  };

  const rpc = async (nome: string, args: Record<string, unknown> = {}) => {
    rpcs.push({ nome, args });
    return {
      data: {
        organization_id: ORG,
        contact_id: CONTATO,
        conversation_id: CONVERSA,
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
        status: "open",
        demanda_fechada_em: null,
      },
      error: null,
    };
  };

  return { db: { from, rpc } as unknown as SupabaseClient, rpcs, leituras };
}

/** O `p_session` que a função entregou ao `fn_service_begin`. */
function sessaoDoBegin(rpcs: Array<{ nome: string; args: Record<string, unknown> }>): unknown {
  return rpcs.find((r) => r.nome === "fn_service_begin")?.args.p_session;
}

describe("abrir conversa: o canal é o que a tela escolheu, e só se ele serve (#3483)", () => {
  it("controle positivo: o canal ESCOLHIDO e conectado é o que abre a conversa", async () => {
    const { db, rpcs } = bancoDeMentira([INSTAGRAM, WHATSAPP]);

    const res = await openSharedContactConversation(db, ORG, {
      contact_id: CONTATO,
      phone_number: TELEFONE,
      channel_session_id: ID_WHATSAPP,
    });

    expect(res).toEqual({ conversation_id: CONVERSA, contact_id: CONTATO });
    expect(sessaoDoBegin(rpcs)).toBe(ID_WHATSAPP);
  });

  it("canal DESLIGADO pelo operador é recusado ANTES de criar a conversa", async () => {
    // `metadata.disabled` é a intenção declarada do dono do número (#2318): o
    // canal não entra na inbox, não recebe IA e não envia. Criar a conversa nele
    // é gravar a conversa vazia que a issue manda não existir — e ainda por cima
    // num canal que o produto promete ignorar.
    const desligado = { ...WHATSAPP, metadata: { disabled: true } };
    const { db, rpcs } = bancoDeMentira([INSTAGRAM, desligado]);

    await expect(
      openSharedContactConversation(db, ORG, {
        contact_id: CONTATO,
        phone_number: TELEFONE,
        channel_session_id: ID_WHATSAPP,
      }),
    ).rejects.toThrow("session_unavailable");

    expect(rpcs.filter((r) => r.nome === "fn_service_begin")).toHaveLength(0);
  });

  it("canal INATIVO escolhido é recusado ANTES de criar a conversa", async () => {
    // Fora do ar (`STOPPED`) não há por onde a primeira mensagem sair. A tela
    // nem oferece esse canal; quem chega aqui com ele é o corpo do POST (MCP,
    // aba aberta desde antes de o canal cair). Quem ESCOLHEU responde por ele.
    const parado = { ...WHATSAPP, status: "STOPPED" };
    const { db, rpcs } = bancoDeMentira([INSTAGRAM, parado]);

    await expect(
      openSharedContactConversation(db, ORG, {
        contact_id: CONTATO,
        phone_number: TELEFONE,
        channel_session_id: ID_WHATSAPP,
      }),
    ).rejects.toThrow("session_unavailable");

    expect(rpcs.filter((r) => r.nome === "fn_service_begin")).toHaveLength(0);
  });

  it("sessão de OUTRA organização continua respondendo 'não encontrada'", async () => {
    const daOutra = { ...WHATSAPP, id: "sessao-da-outra", organization_id: OUTRA_ORG };
    const { db, rpcs } = bancoDeMentira([INSTAGRAM, daOutra]);

    await expect(
      openSharedContactConversation(db, ORG, {
        contact_id: CONTATO,
        channel_session_id: daOutra.id as string,
      }),
    ).rejects.toThrow("session_not_found");

    expect(rpcs).toHaveLength(0);
  });

  it("sem canal escolhido, contato COM telefone abre no canal que disca o número", async () => {
    // A corrida real: a lista de canais não chegou, o corpo vai sem
    // `channel_session_id`, e a sessão mais antiga da organização é a social.
    // A conversa de um contato com telefone nascia no Instagram — o cadastro
    // salvo e a primeira mensagem recusada pelo canal errado (#3358).
    const { db, rpcs } = bancoDeMentira([INSTAGRAM, WHATSAPP]);

    await openSharedContactConversation(db, ORG, {
      contact_id: CONTATO,
      phone_number: TELEFONE,
    });

    expect(sessaoDoBegin(rpcs)).toBe(ID_WHATSAPP);
  });

  it("sem canal escolhido, o DESLIGADO mais antigo é pulado: a conversa abre no próximo que envia (#4092)", async () => {
    // O número velho foi desligado pelo operador e o novo foi conectado depois.
    // `sessaoProntaParaEnvio` pegava o mais antigo sem olhar `metadata.disabled`
    // e esta função recusava a abertura (`session_unavailable` → 409 na rota,
    // `route.ts:154`) mesmo havendo um canal pronto: o cadastro salvo não abria
    // conversa nenhuma.
    const desligado = { ...WHATSAPP, id: "sessao-desligada", created_at: "2025-01-01T00:00:00Z", metadata: { disabled: true } };
    const { db, rpcs } = bancoDeMentira([desligado, INSTAGRAM, WHATSAPP]);

    await openSharedContactConversation(db, ORG, {
      contact_id: CONTATO,
      phone_number: TELEFONE,
    });

    expect(sessaoDoBegin(rpcs)).toBe(ID_WHATSAPP);
  });

  it("sem canal escolhido e TODOS desligados: a recusa continua a de antes (409, não 404)", async () => {
    // Desligar é intenção declarada do dono do número: a recusa é
    // `session_unavailable` — a mesma de antes desta issue, com a mensagem que
    // manda reativar ou escolher outro canal. `session_not_found` (404) é
    // resposta para organização SEM canal, e dizer isso aqui esconderia a causa.
    const desligadoA = { ...WHATSAPP, id: "sessao-desligada", metadata: { disabled: true } };
    const desligadoB = { ...INSTAGRAM, id: "social-desligada", metadata: { disabled: true } };
    const { db, rpcs } = bancoDeMentira([desligadoA, desligadoB]);

    await expect(
      openSharedContactConversation(db, ORG, { contact_id: CONTATO, phone_number: TELEFONE }),
    ).rejects.toThrow("session_unavailable");

    expect(rpcs.filter((r) => r.nome === "fn_service_begin")).toHaveLength(0);
  });

  it("abrir de novo o MESMO contato no MESMO canal devolve a conversa existente", async () => {
    // Não há segunda criação: esta porta nunca insere — delega ao
    // `fn_service_begin`, que reabre a conversa que existe (índice único por
    // organização, contato e sessão, migration 0027). Duas aberturas seguidas
    // são duas delegações à MESMA linha, com o mesmo id de volta; nenhuma rota
    // paralela nasce aqui.
    const { db, rpcs } = bancoDeMentira([INSTAGRAM, WHATSAPP]);

    const primeira = await openSharedContactConversation(db, ORG, {
      contact_id: CONTATO,
      phone_number: TELEFONE,
      channel_session_id: ID_WHATSAPP,
    });
    const segunda = await openSharedContactConversation(db, ORG, {
      contact_id: CONTATO,
      phone_number: TELEFONE,
      channel_session_id: ID_WHATSAPP,
    });

    expect(segunda).toEqual(primeira);
    expect(rpcs.filter((r) => r.nome === "fn_service_begin")).toHaveLength(2);
    // O mesmo par contato+sessão nas duas vezes: quem deduplica é o banco, e
    // recebe sempre a mesma chave — nunca uma segunda thread.
    expect(rpcs.filter((r) => r.nome === "fn_service_begin").map((r) => [r.args.p_contact, r.args.p_session]))
      .toEqual([
        [CONTATO, ID_WHATSAPP],
        [CONTATO, ID_WHATSAPP],
      ]);
  });

  it("sem canal escolhido e sem telefone no pedido, a escolha continua a de sempre", async () => {
    // Contato que veio de rede social não tem telefone a discar: a preferência
    // seria escolher um canal que não alcança o destino dele. A ordem de criação
    // é a resposta certa, e é a que o produto já dava.
    const { db, rpcs } = bancoDeMentira([INSTAGRAM, WHATSAPP]);

    await openSharedContactConversation(db, ORG, { contact_id: CONTATO });

    expect(sessaoDoBegin(rpcs)).toBe(ID_INSTAGRAM);
  });
});
