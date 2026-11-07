/**
 * #3510 — As avaliações do Google chegam à Central (fatia 1, só leitura).
 *
 * O que esta suíte prova, caso a caso:
 *
 *  1. canal conectado + credencial da instalação → a avaliação vira conversa na
 *     Central com AUTOR (contato), NOTA (metadata da conversa) e TEXTO
 *     (mensagem + prévia da lista);
 *  2. avaliação de outro projeto/local NÃO entra, e canal de outra organização
 *     não é nem consultado;
 *  3. sem o par OAuth a sincronização devolve o que falta (a tela explica) em
 *     vez de lançar — e não chama o Google;
 *  4. canal DESLIGADO sai da Central pela régua que a lista já usa
 *     (`idsDosCanaisDesativados`), com o histórico intacto e sem reimportar
 *     nada ao religar.
 *
 * O banco é um dublê em memória: ele imita as constraints que a ingestão
 * depende (unique de `messages(organization_id, external_id)` e de
 * `contacts(organization_id, social_identity)`), então a segunda rodada mede a
 * idempotência de verdade, e não o dublê dizendo amém.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { idsDosCanaisDesativados } from "@/lib/channels/desativado";
import {
  lerAvaliacoes,
  notaDaAvaliacaoNaConversa,
  oQueFaltaParaLerAvaliacoes,
} from "@/lib/channels/google-business/avaliacoes";
import { sincronizarAvaliacoes } from "@/lib/channels/google-business/sincronizar";
import { inboxSupported } from "@/lib/channels/social/catalog";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
const ESCOPO = "accounts/123456789/locations/987654321";
const AMBIENTE = {
  GOOGLE_BUSINESS_OAUTH_CLIENT_ID: "id-da-instalacao.apps.googleusercontent.com",
  GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET: "segredo-da-instalacao",
};

type Linha = Record<string, unknown>;

interface BancoFalso {
  db: SupabaseClient;
  tabelas: {
    channel_sessions: Linha[];
    contacts: Linha[];
    conversations: Linha[];
    messages: Linha[];
  };
  escritas: { contacts: number; conversations: number; messages: number; updates: number };
}

/**
 * Dublê mínimo do cliente Supabase: as quatro tabelas que a ingestão toca, a
 * cadeia `select/eq/is/insert/update` e o 23505 das duas constraints únicas.
 */
function bancoFalso(inicial: { channel_sessions: Linha[] }): BancoFalso {
  const tabelas: Record<string, Linha[]> = {
    channel_sessions: inicial.channel_sessions,
    contacts: [],
    conversations: [],
    messages: [],
  };
  const escritas = { contacts: 0, conversations: 0, messages: 0, updates: 0 };
  let sequencia = 0;

  function consulta(tabela: string) {
    const filtros: [string, unknown][] = [];
    let modo: "select" | "insert" | "update" = "select";
    let payload: Linha | null = null;

    const casa = (linha: Linha) =>
      filtros.every(([coluna, valor]) => {
        if (coluna === "metadata->>disabled")
          return String((linha.metadata as Linha | undefined)?.disabled) === String(valor);
        return linha[coluna] === valor;
      });

    async function executar(): Promise<{ data: unknown; error: { code: string } | null }> {
      const linhas = tabelas[tabela] ?? [];
      if (modo === "select") return { data: linhas.filter(casa), error: null };

      if (modo === "insert") {
        const nova: Linha = { id: `${tabela}-${(sequencia += 1)}`, ...payload };
        if (tabela === "messages") {
          const duplicada = linhas.some(
            (l) =>
              l.organization_id === nova.organization_id && l.external_id === nova.external_id,
          );
          if (duplicada) return { data: null, error: { code: "23505" } };
        }
        if (tabela === "contacts") {
          const duplicado = linhas.some(
            (l) =>
              l.organization_id === nova.organization_id &&
              l.social_identity === nova.social_identity,
          );
          if (duplicado) return { data: null, error: { code: "23505" } };
        }
        linhas.push(nova);
        escritas[tabela as "contacts" | "conversations" | "messages"] += 1;
        return { data: nova, error: null };
      }

      const alvos = linhas.filter(casa);
      for (const alvo of alvos) Object.assign(alvo, payload);
      escritas.updates += alvos.length;
      return { data: alvos, error: null };
    }

    const api = {
      select() {
        return api;
      },
      insert(linha: Linha) {
        modo = "insert";
        payload = linha;
        return api;
      },
      update(patch: Linha) {
        modo = "update";
        payload = patch;
        return api;
      },
      eq(coluna: string, valor: unknown) {
        filtros.push([coluna, valor]);
        return api;
      },
      is(coluna: string, valor: unknown) {
        filtros.push([coluna, valor]);
        return api;
      },
      not() {
        return api;
      },
      filter(coluna: string, _operador: string, valor: unknown) {
        filtros.push([coluna, valor]);
        return api;
      },
      async maybeSingle() {
        const resultado = await executar();
        if (resultado.error) return { data: null, error: resultado.error };
        // Em `select` a resposta é a lista filtrada; em `insert` já é a linha.
        if (Array.isArray(resultado.data))
          return { data: (resultado.data as Linha[])[0] ?? null, error: null };
        return { data: resultado.data ?? null, error: null };
      },
      // `await db.from(...).insert(...)` é usado sem `.select()` na ingestão.
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        return executar().then(resolve, reject);
      },
    };
    return api;
  }

  return {
    db: { from: (tabela: string) => consulta(tabela) } as unknown as SupabaseClient,
    tabelas: tabelas as BancoFalso["tabelas"],
    escritas,
  };
}

function canalDaCasa(extra: Linha = {}): Linha {
  return {
    id: CANAL,
    organization_id: ORG,
    archived_at: null,
    metadata: { social_platform: "googlebusiness", google_business_escopo: ESCOPO },
    ...extra,
  };
}

function avaliacaoDoGoogle(id: string, extra: Linha = {}): Linha {
  return {
    name: `${ESCOPO}/reviews/${id}`,
    reviewId: id,
    reviewer: { displayName: "Maria Souza" },
    starRating: "FOUR",
    comment: "Atendimento ótimo, voltei a comprar.",
    createTime: "2026-10-20T10:00:00Z",
    updateTime: "2026-10-20T10:00:00Z",
    ...extra,
  };
}

function respostaDoGoogle(reviews: unknown[], extra: Linha = {}) {
  return { ok: true, status: 200, json: async () => ({ reviews, ...extra }) };
}

describe("avaliações do Google na Central (#3510)", () => {
  it("a rede passa a suportar atendimento — é o que liga a conta ao canal", () => {
    expect(inboxSupported("googlebusiness")).toBe(true);
  });

  it("canal conectado: a avaliação aparece com autor, nota e texto", async () => {
    const banco = bancoFalso({ channel_sessions: [canalDaCasa()] });
    const buscar = vi.fn().mockResolvedValue(respostaDoGoogle([avaliacaoDoGoogle("r1")]));

    const resultado = await sincronizarAvaliacoes(banco.db, {
      organizationId: ORG,
      channelSessionId: CANAL,
      ambiente: AMBIENTE,
      token: "token-da-organizacao",
      buscar: buscar as unknown as typeof fetch,
    });

    expect(resultado).toEqual({
      status: "sincronizado",
      total: 1,
      novas: 1,
      repetidas: 0,
      deOutroEscopo: 0,
      invalidas: 0,
    });
    // AUTOR — o avaliador vira contato, com identidade social opaca (nunca telefone).
    expect(banco.tabelas.contacts[0]).toMatchObject({
      organization_id: ORG,
      display_name: "Maria Souza",
      social_identity: "googlebusiness:maria souza",
    });
    // VÍNCULO COM O CANAL — a conversa nasce na Inbox, no canal do Google Business.
    const conversa = banco.tabelas.conversations[0]!;
    expect(conversa).toMatchObject({
      organization_id: ORG,
      channel: "googlebusiness",
      channel_session_id: CANAL,
      contact_id: banco.tabelas.contacts[0]!.id,
      last_message_preview: "Atendimento ótimo, voltei a comprar.",
    });
    // NOTA — é o que a lista mostra ao lado da prévia.
    expect(notaDaAvaliacaoNaConversa(conversa.metadata)).toBe(4);
    // TEXTO — a mensagem que o detalhe da Central renderiza.
    expect(banco.tabelas.messages[0]).toMatchObject({
      organization_id: ORG,
      conversation_id: conversa.id,
      direction: "inbound",
      body: "Atendimento ótimo, voltei a comprar.",
      external_id: `googlebusiness:${ESCOPO}/reviews/r1`,
    });
    // E o pedido saiu no escopo do canal, com o token da organização.
    const [url, opcoes] = buscar.mock.calls[0]!;
    expect(String(url)).toContain(`${ESCOPO}/reviews`);
    expect((opcoes as RequestInit).headers).toMatchObject({
      Authorization: "Bearer token-da-organizacao",
    });
  });

  it("a segunda sincronização não duplica: o histórico é o mesmo", async () => {
    const banco = bancoFalso({ channel_sessions: [canalDaCasa()] });
    const buscar = vi
      .fn()
      .mockResolvedValue(
        respostaDoGoogle([avaliacaoDoGoogle("r1"), avaliacaoDoGoogle("r2", { starRating: "ONE" })]),
      );
    const pedido = {
      organizationId: ORG,
      channelSessionId: CANAL,
      ambiente: AMBIENTE,
      token: "tk",
      buscar: buscar as unknown as typeof fetch,
    };

    const primeira = await sincronizarAvaliacoes(banco.db, pedido);
    const segunda = await sincronizarAvaliacoes(banco.db, pedido);

    expect(primeira).toMatchObject({ novas: 2, repetidas: 0 });
    expect(segunda).toMatchObject({ novas: 0, repetidas: 2 });
    expect(banco.tabelas.messages).toHaveLength(2);
    expect(banco.tabelas.conversations).toHaveLength(1);
  });

  it("avaliação de outro projeto não entra na Central", async () => {
    const banco = bancoFalso({ channel_sessions: [canalDaCasa()] });
    const deOutroLocal = avaliacaoDoGoogle("r9", {
      name: "accounts/123456789/locations/000999/reviews/r9",
    });
    const buscar = vi.fn().mockResolvedValue(respostaDoGoogle([avaliacaoDoGoogle("r1"), deOutroLocal]));

    const resultado = await sincronizarAvaliacoes(banco.db, {
      organizationId: ORG,
      channelSessionId: CANAL,
      ambiente: AMBIENTE,
      token: "tk",
      buscar: buscar as unknown as typeof fetch,
    });

    expect(resultado).toMatchObject({ status: "sincronizado", total: 1, deOutroEscopo: 1 });
    expect(banco.tabelas.messages).toHaveLength(1);
    expect(banco.tabelas.messages[0]!.external_id).toBe(`googlebusiness:${ESCOPO}/reviews/r1`);
  });

  it("canal de outra organização não é consultado nem escrito", async () => {
    const banco = bancoFalso({
      channel_sessions: [canalDaCasa({ organization_id: OUTRA_ORG })],
    });
    const buscar = vi.fn();

    const resultado = await sincronizarAvaliacoes(banco.db, {
      organizationId: ORG,
      channelSessionId: CANAL,
      ambiente: AMBIENTE,
      token: "tk",
      buscar: buscar as unknown as typeof fetch,
    });

    expect(resultado).toEqual({ status: "canal_ausente" });
    expect(buscar).not.toHaveBeenCalled();
    expect(banco.escritas).toEqual({ contacts: 0, conversations: 0, messages: 0, updates: 0 });
  });

  it("sem credencial a tela recebe o que falta, e o Google não é chamado", async () => {
    const banco = bancoFalso({ channel_sessions: [canalDaCasa()] });
    const buscar = vi.fn();

    const resultado = await sincronizarAvaliacoes(banco.db, {
      organizationId: ORG,
      channelSessionId: CANAL,
      ambiente: {},
      token: null,
      buscar: buscar as unknown as typeof fetch,
    });

    expect(resultado.status).toBe("sem_credencial");
    if (resultado.status !== "sem_credencial") throw new Error("esperava sem_credencial");
    expect(resultado.faltando).toEqual([
      "GOOGLE_BUSINESS_OAUTH_CLIENT_ID",
      "GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET",
    ]);
    expect(resultado.explicacao).toContain("GOOGLE_BUSINESS_OAUTH_CLIENT_ID");
    expect(resultado.explicacao).toContain("business.manage");
    expect(buscar).not.toHaveBeenCalled();
    expect(banco.tabelas.messages).toHaveLength(0);
  });

  it("token recusado vira estado explicado, não exceção", async () => {
    const banco = bancoFalso({ channel_sessions: [canalDaCasa()] });
    const buscar = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
    });

    const resultado = await sincronizarAvaliacoes(banco.db, {
      organizationId: ORG,
      channelSessionId: CANAL,
      ambiente: AMBIENTE,
      token: "vencido",
      buscar: buscar as unknown as typeof fetch,
    });

    expect(resultado).toMatchObject({ status: "credencial_recusada", codigo: 403 });
    expect(banco.tabelas.messages).toHaveLength(0);
  });

  it("desligar o canal tira as avaliações da Central sem apagar o histórico", async () => {
    const banco = bancoFalso({ channel_sessions: [canalDaCasa()] });
    const buscar = vi.fn().mockResolvedValue(respostaDoGoogle([avaliacaoDoGoogle("r1")]));
    const pedido = {
      organizationId: ORG,
      channelSessionId: CANAL,
      ambiente: AMBIENTE,
      token: "tk",
      buscar: buscar as unknown as typeof fetch,
    };
    await sincronizarAvaliacoes(banco.db, pedido);
    expect(banco.tabelas.messages).toHaveLength(1);

    // O operador desliga o canal (`metadata.disabled`, migration 0545).
    await banco.db
      .from("channel_sessions")
      .update({ metadata: { ...(canalDaCasa().metadata as Linha), disabled: true } })
      .eq("organization_id", ORG)
      .eq("id", CANAL);

    // A MESMA régua que a lista e os badges da Central usam.
    expect(await idsDosCanaisDesativados(banco.db, ORG)).toEqual([CANAL]);
    // …e o histórico continua no banco: nada é apagado ao desligar.
    expect(banco.tabelas.messages).toHaveLength(1);
    expect(banco.tabelas.conversations).toHaveLength(1);

    // Religar devolve a avaliação à Central sem reimportar nada.
    await banco.db
      .from("channel_sessions")
      .update({ metadata: canalDaCasa().metadata })
      .eq("organization_id", ORG)
      .eq("id", CANAL);
    expect(await idsDosCanaisDesativados(banco.db, ORG)).toEqual([]);

    const repetida = await sincronizarAvaliacoes(banco.db, pedido);
    expect(repetida).toMatchObject({ novas: 0, repetidas: 1 });
    expect(banco.tabelas.messages).toHaveLength(1);
  });
});

describe("leitura das avaliações — forma do dado", () => {
  it("descarta o que não é avaliação legível e conta o descarte", () => {
    const leitura = lerAvaliacoes(
      [
        avaliacaoDoGoogle("r1"),
        { name: `${ESCOPO}/reviews/r2`, reviewer: { displayName: "Sem nota" } },
        { name: `${ESCOPO}/reviews/r3`, reviewer: {}, starRating: "FIVE" },
        "lixo",
        { name: `${ESCOPO}/reviews/r4`, reviewer: { displayName: "Nota torta" }, starRating: "SIX" },
      ],
      ESCOPO,
    );

    expect(leitura.avaliacoes.map((a) => a.id)).toEqual(["r1"]);
    expect(leitura.invalidas).toBe(4);
    expect(leitura.deOutroEscopo).toBe(0);
  });

  it("avaliação só com nota entra com texto vazio", () => {
    const leitura = lerAvaliacoes(
      [{ name: `${ESCOPO}/reviews/r5`, reviewer: { displayName: "João" }, starRating: "FIVE" }],
      ESCOPO,
    );
    expect(leitura.avaliacoes[0]).toMatchObject({ autor: "João", nota: 5, texto: "" });
  });

  it("o que falta é dito pelo nome, e some quando o par existe", () => {
    expect(oQueFaltaParaLerAvaliacoes({})).toMatchObject({
      pronta: false,
      faltando: ["GOOGLE_BUSINESS_OAUTH_CLIENT_ID", "GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET"],
    });
    expect(oQueFaltaParaLerAvaliacoes({ ...AMBIENTE, GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET: " " })).toMatchObject({
      pronta: false,
      faltando: ["GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET"],
    });
    expect(oQueFaltaParaLerAvaliacoes(AMBIENTE)).toEqual({
      pronta: true,
      faltando: [],
      explicacao: null,
    });
  });

  it("nota fora da faixa não vira estrela na lista", () => {
    expect(notaDaAvaliacaoNaConversa({ google_business: { nota: 0 } })).toBeNull();
    expect(notaDaAvaliacaoNaConversa({ google_business: { nota: 6 } })).toBeNull();
    expect(notaDaAvaliacaoNaConversa({})).toBeNull();
    expect(notaDaAvaliacaoNaConversa({ google_business: { nota: 5 } })).toBe(5);
  });
});
