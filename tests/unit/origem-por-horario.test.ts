/**
 * A ORIGEM DEDUZIDA PELO HORÁRIO DO CLIQUE — quando o cliente apaga o código.
 *
 * Duas metades: a decisão pura (`escolherCliquePorHorario`) e o caminho com
 * banco (`casarOrigemPorHorario`), contra um PostgREST de mentira que registra
 * cada filtro e cada escrita. O que se mede é o que protege o resto do produto:
 * a dedução só roda com a chave da empresa ligada (vem desligada), o anúncio
 * pago nunca perde para a inferência, e o código continua podendo reivindicar
 * o clique. A sequência em que o código prova OUTRO dono está em
 * `um-clique-nao-vira-origem-de-dois-contatos.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  casarOrigemPorHorario,
  escolherCliquePorHorario,
  esquecerChaveDaOrigemPorHorario,
  JANELA_DO_CLIQUE_MINUTOS,
  origemPorHorarioLigada,
  type CliqueCandidato,
} from "@/lib/leads/origem-por-horario";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const NUMERO = "+5511988887777";

function clique(over: Partial<CliqueCandidato> = {}): CliqueCandidato {
  return {
    id: "c-1",
    utm: { utm_source: "meta", utm_campaign: "Verão", utm_content: "banner-a" },
    createdAt: "2026-10-02T13:00:00.000Z",
    numeroDoLink: NUMERO,
    ...over,
  };
}

describe("escolherCliquePorHorario — a decisão", () => {
  it("um candidato só: é dele, com todas as UTMs", () => {
    expect(escolherCliquePorHorario([clique()], NUMERO)).toEqual({
      cliqueId: "c-1",
      utm: { utm_source: "meta", utm_campaign: "Verão", utm_content: "banner-a" },
      candidatos: 1,
    });
  });

  it("vários candidatos: o mais recente, e só as UTMs em que todos concordam", () => {
    const escolha = escolherCliquePorHorario(
      [
        clique({ id: "velho", createdAt: "2026-10-02T13:00:00.000Z" }),
        clique({
          id: "novo",
          createdAt: "2026-10-02T13:05:00.000Z",
          utm: { utm_source: "meta", utm_campaign: "Lançamento", utm_content: "banner-b" },
        }),
      ],
      NUMERO,
    );
    expect(escolha?.cliqueId).toBe("novo");
    // "Veio do site, pela Meta" é certo; "de qual campanha" não é.
    expect(escolha?.utm).toEqual({ utm_source: "meta" });
    expect(escolha?.candidatos).toBe(2);
  });

  it("compara o número por dígitos: a sessão guarda com e sem `+`", () => {
    expect(escolherCliquePorHorario([clique()], "5511988887777")?.cliqueId).toBe("c-1");
  });

  it("clique para OUTRO número da organização não é de quem escreveu neste", () => {
    expect(
      escolherCliquePorHorario([clique({ numeroDoLink: "+5531977776666" })], NUMERO),
    ).toBeNull();
  });

  it("número da sessão desconhecido não filtra", () => {
    expect(escolherCliquePorHorario([clique()], null)?.cliqueId).toBe("c-1");
  });

  it("sem candidatos, nada", () => {
    expect(escolherCliquePorHorario([], NUMERO)).toBeNull();
  });
});

// ─── O caminho com banco ─────────────────────────────────────────────────────

interface Operacao {
  tabela: string;
  tipo: "select" | "update";
  payload?: Record<string, unknown>;
  filtros: Array<[string, string, unknown]>;
}

let operacoes: Operacao[] = [];
let rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
let cliquesPendentes: Array<Record<string, unknown>> = [];
let erroDosCliques: { message: string } | null = null;
let primeiraMensagemId: string | null = "msg-1";
let metadataDoContato: Record<string, unknown> | null = {};
let numeroDaSessao: string | null = NUMERO;
let reservaVolta: { id: string } | null = { id: "c-1" };
let erroDaEstampa: { message: string } | null = null;
let settingsDaEmpresa: unknown = { conversions: { site_origin_by_click_time: true } };

function construtor(tabela: string, tipo: Operacao["tipo"], payload?: Record<string, unknown>) {
  const op: Operacao = { tabela, tipo, payload, filtros: [] };
  operacoes.push(op);
  const resultado = (): unknown => {
    if (tabela === "meta_ads_click_refs" && tipo === "select") {
      return { data: cliquesPendentes, error: erroDosCliques };
    }
    if (tabela === "meta_ads_click_refs" && tipo === "update")
      return { data: reservaVolta, error: null };
    if (tabela === "messages") {
      return {
        data: primeiraMensagemId ? { id: primeiraMensagemId } : null,
        count: 1,
        error: null,
      };
    }
    if (tabela === "organizations") return { data: { settings: settingsDaEmpresa }, error: null };
    if (tabela === "contacts") {
      return {
        data: metadataDoContato ? { source: "whatsapp", source_metadata: metadataDoContato } : null,
        error: null,
      };
    }
    if (tabela === "ad_tracking_links")
      return { data: [{ id: "link-1", whatsapp_e164: NUMERO }], error: null };
    if (tabela === "channel_sessions")
      return { data: { phone_number: numeroDaSessao }, error: null };
    return { data: null, error: null };
  };
  const cadeia: Record<string, unknown> = {};
  for (const metodo of ["eq", "is", "gte", "in", "not"]) {
    cadeia[metodo] = (coluna: string, a: unknown, b?: unknown) => {
      op.filtros.push([metodo, coluna, metodo === "not" ? [a, b] : a]);
      return cadeia;
    };
  }
  for (const metodo of ["select", "order", "limit"]) cadeia[metodo] = () => cadeia;
  cadeia.maybeSingle = async () => resultado();
  cadeia.then = (resolve: (v: unknown) => void) => Promise.resolve(resultado()).then(resolve);
  return cadeia;
}

const admin = {
  from(tabela: string) {
    return {
      select: () => construtor(tabela, "select"),
      update: (payload: Record<string, unknown>) => construtor(tabela, "update", payload),
    };
  },
  async rpc(nome: string, args: Record<string, unknown>) {
    rpcs.push({ nome, args });
    return { error: erroDaEstampa };
  },
} as never;

const ENTRADA = {
  organizationId: "org-1",
  contactId: "contato-1",
  messageId: "msg-1",
  channelSessionId: "sessao-1",
};

const estampa = () => rpcs.find((r) => r.nome === "fn_estampar_atribuicao_de_anuncio");
const updatesDeClique = () =>
  operacoes.filter((o) => o.tabela === "meta_ads_click_refs" && o.tipo === "update");

beforeEach(() => {
  operacoes = [];
  rpcs = [];
  cliquesPendentes = [
    {
      id: "c-1",
      utm: { utm_source: "site", utm_campaign: "Landing · Verão", utm_content: "banner-a" },
      created_at: new Date(Date.now() - 2 * 60_000).toISOString(),
      tracking_link_id: "link-1",
    },
  ];
  erroDosCliques = null;
  primeiraMensagemId = "msg-1";
  metadataDoContato = {};
  numeroDaSessao = NUMERO;
  reservaVolta = { id: "c-1" };
  erroDaEstampa = null;
  settingsDaEmpresa = { conversions: { site_origin_by_click_time: true } };
  esquecerChaveDaOrigemPorHorario();
});

describe("a chave da empresa (doc 259): desligada de fábrica", () => {
  it("ausente, nula ou não-booleana é desligada; só `true` liga", () => {
    expect(origemPorHorarioLigada(null)).toBe(false);
    expect(origemPorHorarioLigada({})).toBe(false);
    expect(origemPorHorarioLigada({ conversions: {} })).toBe(false);
    expect(origemPorHorarioLigada({ conversions: { site_origin_by_click_time: "true" } })).toBe(false);
    expect(origemPorHorarioLigada({ conversions: { site_origin_by_click_time: true } })).toBe(true);
  });

  it("desligada, não consulta clique nenhum e não estampa", async () => {
    settingsDaEmpresa = {};
    await casarOrigemPorHorario(admin, ENTRADA);

    expect(operacoes.map((o) => o.tabela)).toEqual(["organizations"]);
    expect(estampa()).toBeUndefined();
  });

  it("a chave é lida uma vez e fica no memo: a segunda mensagem não relê", async () => {
    settingsDaEmpresa = {};
    await casarOrigemPorHorario(admin, ENTRADA);
    await casarOrigemPorHorario(admin, ENTRADA);

    expect(operacoes.filter((o) => o.tabela === "organizations")).toHaveLength(1);
    expect(operacoes.filter((o) => o.tabela === "meta_ads_click_refs")).toHaveLength(0);
  });
});

describe("casarOrigemPorHorario — com banco", () => {
  it("contato novo, sem origem, com clique pendente: estampa a origem marcada como dedução", async () => {
    await casarOrigemPorHorario(admin, ENTRADA);

    expect(estampa()?.args).toMatchObject({
      p_org: "org-1",
      p_contact: "contato-1",
      p_platform: "site",
      p_metadata: {
        ad_platform: "site",
        origem_inferida_por: "horario",
        // O `source` de antes, para a dedução desfeita devolver ao contato.
        origem_inferida_source_anterior: "whatsapp",
        utm_campaign: "Landing · Verão",
        utm_content: "banner-a",
      },
    });
  });

  it("a busca de cliques: só de link rastreável, sem dono, desta organização, dentro da janela", async () => {
    const antes = Date.now();
    await casarOrigemPorHorario(admin, ENTRADA);

    const busca = operacoes.find((o) => o.tabela === "meta_ads_click_refs" && o.tipo === "select");
    expect(busca?.filtros).toEqual(
      expect.arrayContaining([
        ["eq", "organization_id", "org-1"],
        ["not", "tracking_link_id", ["is", null]],
        ["is", "matched_at", null],
        ["is", "contact_id", null],
      ]),
    );
    const desde = busca?.filtros.find(([m, c]) => m === "gte" && c === "created_at")?.[2] as string;
    const janelaMs = antes - Date.parse(desde);
    expect(janelaMs).toBeGreaterThanOrEqual(JANELA_DO_CLIQUE_MINUTOS * 60_000 - 1000);
    expect(janelaMs).toBeLessThanOrEqual(JANELA_DO_CLIQUE_MINUTOS * 60_000 + 1000);
  });

  it("a reserva grava SÓ o contato — `matched_at` fica nulo para o código ainda poder reivindicar", async () => {
    await casarOrigemPorHorario(admin, ENTRADA);

    const [reserva] = updatesDeClique();
    expect(reserva?.payload).toEqual({ contact_id: "contato-1" });
    // A mesma trava dupla da leitura: dois contatos não levam o mesmo clique.
    expect(reserva?.filtros).toEqual(
      expect.arrayContaining([
        ["eq", "id", "c-1"],
        ["is", "matched_at", null],
        ["is", "contact_id", null],
      ]),
    );
  });

  it("ligada, o caso comum — nenhum clique pendente — custa a chave e UMA consulta de cliques", async () => {
    cliquesPendentes = [];
    await casarOrigemPorHorario(admin, ENTRADA);

    expect(operacoes.map((o) => o.tabela)).toEqual(["organizations", "meta_ads_click_refs"]);
    expect(estampa()).toBeUndefined();
  });

  it("contato que JÁ veio de anúncio nunca recebe a origem do site", async () => {
    metadataDoContato = { ad_platform: "meta_ads", ad_source_id: "ctwa-1" };
    await casarOrigemPorHorario(admin, ENTRADA);

    expect(updatesDeClique()).toHaveLength(0);
    expect(estampa()).toBeUndefined();
  });

  it("fora da primeira mensagem, nada", async () => {
    primeiraMensagemId = "msg-antiga";
    await casarOrigemPorHorario(admin, ENTRADA);

    expect(updatesDeClique()).toHaveLength(0);
    expect(estampa()).toBeUndefined();
  });

  it("reentrega (sem id de mensagem) nem consulta", async () => {
    await casarOrigemPorHorario(admin, { ...ENTRADA, messageId: null });
    expect(operacoes).toHaveLength(0);
  });

  it("clique de link para outro número: não é deste contato", async () => {
    numeroDaSessao = "+5531977776666";
    await casarOrigemPorHorario(admin, ENTRADA);

    expect(updatesDeClique()).toHaveLength(0);
    expect(estampa()).toBeUndefined();
  });

  it("outro contato levou o clique no meio do caminho: não estampa", async () => {
    reservaVolta = null;
    await casarOrigemPorHorario(admin, ENTRADA);
    expect(estampa()).toBeUndefined();
  });

  it("se a estampa falhar, o clique volta a ser órfão", async () => {
    erroDaEstampa = { message: "permission denied" };
    await casarOrigemPorHorario(admin, ENTRADA);

    const [, devolucao] = updatesDeClique();
    expect(devolucao?.payload).toEqual({ contact_id: null });
    expect(devolucao?.filtros).toEqual(
      expect.arrayContaining([
        ["eq", "id", "c-1"],
        ["eq", "contact_id", "contato-1"],
        ["is", "matched_at", null],
      ]),
    );
  });

  it("falha de banco não derruba a ingestão", async () => {
    erroDosCliques = { message: "timeout" };
    await expect(casarOrigemPorHorario(admin, ENTRADA)).resolves.toBeUndefined();
    expect(estampa()).toBeUndefined();
  });
});
