/**
 * UM CLIQUE NÃO VIRA ORIGEM DE DOIS CONTATOS — a sequência que a triagem do
 * PR #3906 achou lendo o código (doc de decisão 259, defeito 3):
 *
 *   1. X clica no link rastreável; o clique fica sem dono.
 *   2. Y, que nunca viu o site, escreve logo depois sem código: a dedução pelo
 *      horário reserva o clique para Y e estampa Y como "veio do site".
 *   3. X manda a mensagem COM o `[ref:]` daquele clique: o código é prova, e
 *      `casarClickRef` dá o clique a X.
 *
 * Antes do conserto, Y continuava estampado com as UTMs do clique de X — e a
 * origem, travada pelo primeiro toque, nunca mais saía. O que se mede aqui é o
 * ESTADO no fim: só X tem a origem do site; Y volta a ser o que era, no
 * contato e no card que copiou a origem ao nascer.
 *
 * O banco é um PostgREST de mentira COM ESTADO: as três peças reais
 * (`casarOrigemPorHorario`, `casarClickRef`, `estamparOrigemDaPagina`) leem e
 * escrevem as mesmas linhas, na ordem da ingestão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { estamparOrigemDaPagina } from "@/lib/leads/origem-do-site";
import {
  casarOrigemPorHorario,
  esquecerChaveDaOrigemPorHorario,
} from "@/lib/leads/origem-por-horario";
import { casarClickRef } from "@/lib/plataformas-de-anuncio/meta/captura-de-clique";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Linha = Record<string, unknown>;
type Filtro = (linha: Linha) => boolean;

const ORG = "org-1";
const NUMERO = "+5511988887777";

let tabelas: Record<string, Linha[]> = {};

/** `coluna` ou `coluna->>chave` (o caminho jsonb que o PostgREST aceita). */
function valorDe(linha: Linha, coluna: string): unknown {
  const [col, chave] = coluna.split("->>");
  const valor = linha[col!];
  if (chave === undefined) return valor;
  const dentro = (valor as Linha | null | undefined)?.[chave];
  return dentro == null ? null : String(dentro);
}

function consulta(tabela: string, tipo: "select" | "update", payload?: Linha) {
  const filtros: Filtro[] = [];
  let limite = Infinity;
  const executar = () => {
    const casadas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    if (tipo === "update") for (const l of casadas) Object.assign(l, structuredClone(payload));
    return casadas.slice(0, limite).map((l) => structuredClone(l));
  };
  const cadeia: Record<string, unknown> = {
    eq: (c: string, v: unknown) => (filtros.push((l) => valorDe(l, c) === v), cadeia),
    is: (c: string, v: unknown) => (filtros.push((l) => (valorDe(l, c) ?? null) === v), cadeia),
    not: (c: string, _op: string, v: unknown) => (
      filtros.push((l) => (valorDe(l, c) ?? null) !== v), cadeia
    ),
    gte: (c: string, v: string) => (filtros.push((l) => String(valorDe(l, c)) >= v), cadeia),
    in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(valorDe(l, c))), cadeia),
    order: () => cadeia,
    limit: (n: number) => ((limite = n), cadeia),
    select: () => cadeia,
    maybeSingle: async () => {
      const linhas = executar();
      return { data: linhas[0] ?? null, count: linhas.length, error: null };
    },
    then: (resolve: (v: unknown) => void) =>
      Promise.resolve({ data: executar(), error: null }).then(resolve),
  };
  return cadeia;
}

const admin = {
  from: (tabela: string) => ({
    select: () => consulta(tabela, "select"),
    update: (payload: Linha) => consulta(tabela, "update", payload),
  }),
  /** A `fn_estampar_atribuicao_de_anuncio` do baseline: merge, primeiro toque, organização. */
  async rpc(nome: string, args: Linha) {
    if (nome !== "fn_estampar_atribuicao_de_anuncio") return { error: { message: nome } };
    for (const c of tabelas.contacts ?? []) {
      const meta = c.source_metadata as Linha;
      if (c.id !== args.p_contact || c.organization_id !== args.p_org || meta.ad_platform != null)
        continue;
      c.source = args.p_platform;
      c.source_metadata = { ...meta, ...(args.p_metadata as Linha) };
    }
    return { error: null };
  },
} as never;

const contato = (id: string) => tabelas.contacts!.find((c) => c.id === id)!;
const clique = () => tabelas.meta_ads_click_refs![0]!;

beforeEach(() => {
  esquecerChaveDaOrigemPorHorario();
  const UTM = { utm_source: "site", utm_campaign: "Landing · Verão" };
  tabelas = {
    organizations: [{ id: ORG, settings: { conversions: { site_origin_by_click_time: true } } }],
    meta_ads_click_refs: [
      {
        id: "clique-de-x",
        organization_id: ORG,
        token: "K7M2P9",
        tracking_link_id: "link-1",
        utm: UTM,
        created_at: new Date(Date.now() - 60_000).toISOString(),
        matched_at: null,
        contact_id: null,
      },
    ],
    ad_tracking_links: [{ id: "link-1", organization_id: ORG, whatsapp_e164: NUMERO }],
    channel_sessions: [{ id: "sessao-1", organization_id: ORG, phone_number: NUMERO }],
    messages: [
      { id: "msg-y", organization_id: ORG, contact_id: "y", direction: "inbound" },
      { id: "msg-x", organization_id: ORG, contact_id: "x", direction: "inbound" },
    ],
    contacts: ["x", "y"].map((id) => ({
      id,
      organization_id: ORG,
      source: "whatsapp",
      source_metadata: { waha_chat_id: `${id}@c.us` },
    })),
    crm_leads: [],
  };
});

/** O passo 2: Y escreve sem código, e o card dele nasce copiando a origem. */
async function yDeduzOClique() {
  await casarOrigemPorHorario(admin, {
    organizationId: ORG,
    contactId: "y",
    messageId: "msg-y",
    channelSessionId: "sessao-1",
  });
  // O que `garantirLeadDaConversa` faz com contato `source = "site"`.
  const y = contato("y");
  tabelas.crm_leads!.push({
    id: "card-y",
    organization_id: ORG,
    contact_id: "y",
    source: y.source,
    source_metadata: structuredClone(y.source_metadata),
    tags: ["Site"],
  });
}

/** O passo 3: X chega com o `[ref:]` — o mesmo caminho de `guardarOrigemDaPagina`. */
async function xProvaOClique() {
  const casado = await casarClickRef(admin, ORG, "K7M2P9", "x");
  expect(casado, "o código de X não casou").not.toBeNull();
  await estamparOrigemDaPagina(admin, ORG, "x", {
    utm: casado!.utm,
    capturadaEm: new Date().toISOString(),
  });
}

describe("Y deduz o clique pelo horário, depois X o prova com o [ref:]", () => {
  it("a premissa: a dedução deu o clique e a origem do site a Y", async () => {
    await yDeduzOClique();

    expect(clique().contact_id).toBe("y");
    expect(clique().matched_at).toBeNull();
    expect(contato("y").source).toBe("site");
    expect(contato("y").source_metadata).toMatchObject({
      origem_inferida_por: "horario",
      utm_campaign: "Landing · Verão",
    });
  });

  it("no fim, só X tem a origem daquele clique", async () => {
    await yDeduzOClique();
    await xProvaOClique();

    expect(clique().contact_id).toBe("x");
    expect(clique().matched_at).not.toBeNull();
    expect(contato("x").source).toBe("site");
    expect(contato("x").source_metadata).toMatchObject({ utm_campaign: "Landing · Verão" });

    // Y volta a ser o que era: sem origem, sem UTM, com o que já tinha antes.
    expect(contato("y").source).toBe("whatsapp");
    expect(contato("y").source_metadata).toEqual({ waha_chat_id: "y@c.us" });
  });

  it("o card de Y, que copiou a origem ao nascer, também a perde", async () => {
    await yDeduzOClique();
    await xProvaOClique();

    const card = tabelas.crm_leads!.find((l) => l.id === "card-y")!;
    expect(card.source).toBe("whatsapp");
    expect(card.source_metadata).toEqual({ waha_chat_id: "y@c.us" });
    expect(card.tags).toEqual([]);
  });

  it("origem PROVADA de outro contato nunca é desfeita por este caminho", async () => {
    // Y tem origem do site por código (sem `origem_inferida_por`) e, por
    // qualquer razão, aparece como dono do clique: nada dele é tocado.
    const y = contato("y");
    y.source = "site";
    y.source_metadata = { ad_platform: "site", origem: "site", utm_campaign: "Outra" };
    clique().contact_id = "y";

    await xProvaOClique();

    expect(contato("y").source).toBe("site");
    expect(contato("y").source_metadata).toEqual({
      ad_platform: "site",
      origem: "site",
      utm_campaign: "Outra",
    });
  });
});
