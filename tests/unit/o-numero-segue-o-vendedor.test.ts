/**
 * #3642 — o número segue o vendedor: quem responde por esta conversa?
 *
 * O defeito medido: com um número por vendedor, a conversa continuava no
 * `channel_session_id` do vendedor ANTERIOR depois de uma transferência, e o
 * vendedor novo respondia pelo WhatsApp do colega (a mensagem saía pelo número do
 * antigo e a resposta do cliente ia para o celular dele).
 *
 * Duas peças fecham isso, e este arquivo prova a de TypeScript:
 *
 *  - `vereditoDoNumero` (pura): pode enviar? Se não, com qual frase.
 *  - `quadroDoNumero` (leitura): o que as duas tabelas do roteamento dizem sobre o
 *    número desta conversa e sobre quem está escrevendo.
 *
 * O lado do banco (o número acompanhar a troca de dono) é provado em
 * `tests/invariants/o-numero-segue-o-vendedor.test.ts` — aqui não há Postgres.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  avisoDaContinua,
  CODIGO_NUMERO_DE_OUTRO,
  MENSAGEM_DO_NUMERO,
  modeloDaContinua,
  quadroDoNumero,
  vereditoDoNumero,
  type QuadroDoNumero,
} from "@/lib/channels/numero-do-atendente";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESSAO = "22222222-2222-4222-8222-222222222222";
const ATENDENTE = "33333333-3333-4333-8333-333333333333";
const COLEGA = "44444444-4444-4444-8444-444444444444";
const POLITICA = "55555555-5555-4555-8555-555555555555";
const MINHA_POLITICA = "66666666-6666-4666-8666-666666666666";
const MINHA_SESSAO = "77777777-7777-4777-8777-777777777777";
/** A conversa NOVA do mesmo contato, no número de quem responde (#3732). */
const NOVA = "88888888-8888-4888-8888-888888888888";

// ─── Banco falso (as tabelas do roteamento e as sessões) ─────────────────────
type Linha = Record<string, unknown>;

/**
 * Duas tabelas com a cadeia exata que `quadroDoNumero` encadeia
 * (`select`/`eq`/`eq`/`maybeSingle` ou `await`). A leitura é a única coisa falsa:
 * a decisão é a de verdade, e é ela que o teste mede.
 */
function bancoFalso(opcoes: {
  policies: Linha[];
  responsibles: Linha[];
  sessions?: Linha[];
  erroEm?: "channel_routing_policies" | "channel_routing_responsibles" | "channel_sessions";
}) {
  const tabelas: Record<string, Linha[]> = {
    channel_routing_policies: opcoes.policies,
    channel_routing_responsibles: opcoes.responsibles,
    channel_sessions: opcoes.sessions ?? [],
  };

  const from = (nome: string) => {
    const linhas = tabelas[nome] ?? [];
    const filtros: Array<[string, unknown]> = [];
    const listas: Array<[string, unknown[]]> = [];
    const casa = (l: Linha) =>
      filtros.every(([c, v]) => l[c] === v) && listas.every(([c, vs]) => vs.includes(l[c]));
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => (filtros.push([c, v]), b);
    b.in = (c: string, vs: unknown[]) => (listas.push([c, vs]), b);
    const ler = () => {
      if (opcoes.erroEm === nome) return { data: null, error: { message: "indisponivel" } };
      return { data: linhas.filter(casa), error: null };
    };
    b.maybeSingle = async () => {
      const r = ler();
      if (r.error) return r;
      return { data: r.data[0] ?? null, error: null };
    };
    b.then = (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
      Promise.resolve(ler()).then(ok, erro);
    return b;
  };

  return { from } as unknown as SupabaseClient;
}

const LEITURA = { organizationId: ORG, channelSessionId: SESSAO, provider: "waha", userId: ATENDENTE };

/** O colega na lista do número da conversa; o atendente com o próprio número. */
function comNumeroProprio(sessao: Linha = {}, erroEm?: "channel_sessions") {
  return bancoFalso({
    policies: [
      { id: POLITICA, organization_id: ORG, channel_session_id: SESSAO },
      { id: MINHA_POLITICA, organization_id: ORG, channel_session_id: MINHA_SESSAO },
    ],
    responsibles: [
      { policy_id: POLITICA, user_id: COLEGA, organization_id: ORG },
      { policy_id: MINHA_POLITICA, user_id: ATENDENTE, organization_id: ORG },
    ],
    sessions: [
      { id: MINHA_SESSAO, organization_id: ORG, provider: "waha", status: "WORKING", archived_at: null, metadata: {}, ...sessao },
    ],
    erroEm,
  });
}

describe("#3642 — a decisão: quem responde por este número pode enviar?", () => {
  it("organização sem um número por vendedor: libera (controle — nada muda)", () => {
    const quadro: QuadroDoNumero = {
      roteamentoPorVendedor: false,
      atendenteRespondePelaSessao: false,
      atendenteTemNumero: false,
    };
    expect(vereditoDoNumero(quadro)).toEqual({ ok: true });
  });

  it("quem responde por este número envia (inclusive no número COMPARTILHADO)", () => {
    expect(
      vereditoDoNumero({
        roteamentoPorVendedor: true,
        atendenteRespondePelaSessao: true,
        atendenteTemNumero: true,
      }),
    ).toEqual({ ok: true });
  });

  it("vendedor com número próprio NÃO responde pela conversa que está no número do colega", () => {
    expect(
      vereditoDoNumero({
        roteamentoPorVendedor: true,
        atendenteRespondePelaSessao: false,
        atendenteTemNumero: true,
      }),
    ).toEqual({ ok: false, codigo: CODIGO_NUMERO_DE_OUTRO });
  });

  it("doc 237, 1-B: quem NÃO tem número próprio responde como hoje, mesmo fora da lista", () => {
    expect(
      vereditoDoNumero({
        roteamentoPorVendedor: true,
        atendenteRespondePelaSessao: false,
        atendenteTemNumero: false,
      }),
    ).toEqual({ ok: true });
  });

  it("a recusa diz o que fazer, sem prometer o número alheio", () => {
    expect(MENSAGEM_DO_NUMERO[CODIGO_NUMERO_DE_OUTRO]).toMatch(/número de outro atendente/);
    expect(MENSAGEM_DO_NUMERO[CODIGO_NUMERO_DE_OUTRO]).toMatch(/transferida para você/);
  });
});

describe("#3642 — a leitura do roteamento (quadroDoNumero)", () => {
  it("número sem policy: a instalação não separa números por vendedor", async () => {
    const db = bancoFalso({ policies: [], responsibles: [] });
    const r = await quadroDoNumero(db, LEITURA);
    expect(r).toEqual({
      leitura: "ok",
      quadro: { roteamentoPorVendedor: false, atendenteRespondePelaSessao: true, atendenteTemNumero: false },
    });
  });

  it("conversa sem sessão: não há número a conferir", async () => {
    const db = bancoFalso({ policies: [], responsibles: [] });
    const r = await quadroDoNumero(db, { ...LEITURA, channelSessionId: null });
    expect(r).toEqual({
      leitura: "ok",
      quadro: { roteamentoPorVendedor: false, atendenteRespondePelaSessao: true, atendenteTemNumero: false },
    });
  });

  it("policy com responsáveis: quem está na lista responde pelo número", async () => {
    const db = bancoFalso({
      policies: [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO }],
      responsibles: [
        { policy_id: POLITICA, user_id: ATENDENTE, organization_id: ORG },
        { policy_id: POLITICA, user_id: COLEGA, organization_id: ORG },
      ],
    });
    const r = await quadroDoNumero(db, LEITURA);
    expect(r).toEqual({
      leitura: "ok",
      quadro: { roteamentoPorVendedor: true, atendenteRespondePelaSessao: true, atendenteTemNumero: true },
    });
  });

  it("fora da lista, com número próprio CONECTADO do mesmo canal: o número é de OUTRO", async () => {
    const r = await quadroDoNumero(comNumeroProprio(), LEITURA);
    expect(r).toEqual({
      leitura: "ok",
      quadro: { roteamentoPorVendedor: true, atendenteRespondePelaSessao: false, atendenteTemNumero: true },
    });
  });

  it("número próprio desconectado, arquivado, desativado ou de outro canal NÃO conta como ter número", async () => {
    for (const sessao of [
      { status: "STOPPED" },
      { archived_at: "2026-10-01T00:00:00.000Z" },
      { metadata: { disabled: true } },
      { provider: "zernio_social" },
    ]) {
      const r = await quadroDoNumero(comNumeroProprio(sessao), LEITURA);
      expect(r, JSON.stringify(sessao)).toEqual({
        leitura: "ok",
        quadro: { roteamentoPorVendedor: true, atendenteRespondePelaSessao: false, atendenteTemNumero: false },
      });
    }
  });

  it("leitura das sessões que falha também não libera", async () => {
    expect(await quadroDoNumero(comNumeroProprio({}, "channel_sessions"), LEITURA)).toEqual({
      leitura: "indisponivel",
    });
  });

  it("fora da lista e sem número nenhum: SEM número conectado", async () => {
    const db = bancoFalso({
      policies: [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO }],
      responsibles: [{ policy_id: POLITICA, user_id: COLEGA, organization_id: ORG }],
    });
    const r = await quadroDoNumero(db, LEITURA);
    expect(r).toEqual({
      leitura: "ok",
      quadro: { roteamentoPorVendedor: true, atendenteRespondePelaSessao: false, atendenteTemNumero: false },
    });
  });

  it("policy sem responsáveis (número em montagem): a regra ainda não vale", async () => {
    const db = bancoFalso({
      policies: [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO }],
      responsibles: [],
    });
    const r = await quadroDoNumero(db, LEITURA);
    expect(r).toEqual({
      leitura: "ok",
      quadro: { roteamentoPorVendedor: false, atendenteRespondePelaSessao: true, atendenteTemNumero: false },
    });
  });

  it("leitura que falha NÃO libera: o caminho do envio falha fechado", async () => {
    const db = bancoFalso({
      policies: [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO }],
      responsibles: [],
      erroEm: "channel_routing_policies",
    });
    expect(await quadroDoNumero(db, LEITURA)).toEqual({ leitura: "indisponivel" });
  });

  it("leitura dos responsáveis que falha também não libera", async () => {
    const db = bancoFalso({
      policies: [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO }],
      responsibles: [],
      erroEm: "channel_routing_responsibles",
    });
    expect(await quadroDoNumero(db, LEITURA)).toEqual({ leitura: "indisponivel" });
  });
});

/**
 * #3732 — a recusa diz PARA ONDE IR.
 *
 * O caso medido na issue: a conversa antiga não pôde seguir o vendedor (o
 * contato já tem conversa no número dele), então ela fica com o dono novo num
 * número que não é dele e o envio responde 409 — mandando "transfira para você",
 * que já foi feito. A frase sozinha não levava a lugar nenhum.
 *
 * A peça é pura de propósito: o servidor manda o detalhe no corpo da recusa
 * (`details.conversa_que_continua`) e a tela decide o que mostrar a partir dele.
 */
describe("#3732 — o aviso da conversa que continua (puro, sem banco)", () => {
  it("o número é de QUEM ATENDE: a frase nomeia a pessoa", () => {
    expect(modeloDaContinua({ nome: "Ana Lima", propria: false })).toMatch(/número de \{nome\}/);
    expect(modeloDaContinua({ nome: "Ana Lima", propria: false })).toMatch(/Abra a conversa/i);
  });

  it("quando a conversa nova está no número de quem está enviando, a frase é a do próprio número", () => {
    const modelo = modeloDaContinua({ nome: "Ana Lima", propria: true });
    expect(modelo).toMatch(/seu número/);
    // Não promete o número de outra pessoa para quem já está no dele.
    expect(modelo).not.toMatch(/\{nome\}/);
  });

  it("sem nome gravado, a frase não inventa um nome", () => {
    const modelo = modeloDaContinua({ nome: null, propria: false });
    expect(modelo).not.toMatch(/\{nome\}/);
    expect(modelo).toMatch(/outro atendente/);
  });

  it("o detalhe da recusa vira o aviso da tela, com o id da conversa nova", () => {
    const aviso = avisoDaContinua(CODIGO_NUMERO_DE_OUTRO, {
      channel_session_id: SESSAO,
      conversa_que_continua: { id: NOVA, nome: "Ana Lima", propria: false },
    });
    expect(aviso).toEqual({
      conversaId: NOVA,
      modelo: modeloDaContinua({ nome: "Ana Lima", propria: false }),
      nome: "Ana Lima",
    });
  });

  it("CONTROLE: sem a conversa que continua, o detalhe não vira aviso (a frase de sempre fica)", () => {
    expect(avisoDaContinua(CODIGO_NUMERO_DE_OUTRO, { channel_session_id: SESSAO })).toBeNull();
    // E o id vazio não abre conversa nenhuma.
    expect(
      avisoDaContinua(CODIGO_NUMERO_DE_OUTRO, { conversa_que_continua: { id: "" } }),
    ).toBeNull();
  });

  it("CONTROLE: outra recusa (de outro código) não vira aviso de continuação", () => {
    expect(
      avisoDaContinua("janela_fechada", { conversa_que_continua: { id: NOVA } }),
    ).toBeNull();
  });
});
