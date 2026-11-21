/**
 * O RELATÓRIO POR ETIQUETA — os três cortes que a F1 da #1833 tem de acertar.
 *
 * ## Por que a fixture é uma tabelinha que APLICA os predicados
 *
 * O jeito barato de "provar" escopo é gravar os `.eq()` e conferir que
 * `organization_id` apareceu na chamada. Isso guarda a CHAMADA, não o efeito: um
 * predicado escrito no lugar errado satisfaz a asserção e o relatório do vizinho
 * continua saindo no número de quem chamou. Aqui o dublê filtra de verdade — é
 * o que sobrou na tabela que se mede (mesma régua de
 * `tests/unit/central-avisos-resolver-em-lote.test.ts`).
 *
 * Ele também emula o `max_rows = 1000` do PostgREST: `range(a, b)` nunca devolve
 * mais que o teto do servidor, mesmo que o código peça tudo. Um dublê que
 * entregasse a tabela inteira aprovaria uma rota que soma página parcial com
 * cara de total — o defeito que o `/reports/financeiro` mediu em dinheiro.
 *
 * ## Os três casos (seed da entrega)
 *
 * 1. Etiqueta em uso SEM conversa no período devolve `0` e NÃO some da lista —
 *    sumir seria a armadilha 1 da issue (etiqueta que aparece e não vira número)
 *    com outra roupa.
 * 2. Período vazio devolve lista vazia com `sem_dados` — nunca uma tabela de
 *    zeros fingindo que houve relatório.
 * 3. A rota não vaza conversa de outra organização — pela TABELA, não pela chamada.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/reports/tags/route";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const USUARIO = "22222222-2222-4222-8222-222222222222";

interface Conversa {
  id: string;
  organization_id: string;
  tags: string[];
  status: string;
  created_at: string;
  service_started_at?: string | null;
  service_closed_at?: string | null;
  awaiting_since: string | null;
  last_outbound_at: string | null;
}

type Filtro = { col: string; op: "eq" | "gte" | "lt" | "is"; valor: unknown };

let tabela: Conversa[];
let leituras: Array<{
  filtros: Filtro[];
  alternativas: Filtro[][];
  ordens: string[];
  de: number;
  ate: number;
}>;
let chamadasDeRpc: Array<{ nome: string; p_org: string | undefined }>;

/** Compara como o Postgres: instante, quando a coluna é data; senão texto. */
function casada(valor: unknown, alvo: unknown, op: Filtro["op"]): boolean {
  if (op === "is") return (valor ?? null) === alvo;
  const a = Date.parse(String(valor));
  const b = Date.parse(String(alvo));
  const ehData = !Number.isNaN(a) && !Number.isNaN(b);
  if (ehData) {
    if (op === "eq") return a === b;
    if (op === "gte") return a >= b;
    return a < b;
  }
  if (op === "eq") return valor === alvo;
  if (op === "gte") return String(valor) >= String(alvo);
  return String(valor) < String(alvo);
}

/**
 * `.or("and(a.gte.X,a.lt.Y),and(a.is.null,b.gte.X)")` do PostgREST: cada `and(…)`
 * é uma alternativa, e o valor pode ter `.` (o `.000Z` do ISO) — por isso só os
 * dois primeiros pontos separam coluna, operador e valor.
 */
function alternativasDe(expr: string): Filtro[][] {
  return [...expr.matchAll(/and\(([^)]*)\)/g)].map(([, dentro]) =>
    dentro!.split(",").map((termo) => {
      const [col, op, ...resto] = termo.split(".");
      const bruto = resto.join(".");
      return { col: col!, op: op as Filtro["op"], valor: bruto === "null" ? null : bruto };
    }),
  );
}

const linhaCasa = (linha: Conversa, filtros: Filtro[]) =>
  filtros.every((f) => casada(linha[f.col as keyof Conversa], f.valor, f.op));

function clientFalso(maxRows = 1_000) {
  return {
    async rpc(nome: string, args: { p_org?: string }) {
      chamadasDeRpc.push({ nome, p_org: args.p_org });
      // `fn_tags_de_conversa_em_uso` é INVOKER: a RLS de `conversations` decide
      // o que a função enxerga, e `p_org` errado devolve ZERO etiquetas.
      const usadas = new Set<string>();
      for (const conversa of tabela) {
        if (conversa.organization_id !== args.p_org) continue;
        for (const tag of conversa.tags) usadas.add(tag);
      }
      return { data: [...usadas].sort().map((tag) => ({ tag })), error: null };
    },
    from(nome: string) {
      expect(nome).toBe("conversations");
      const filtros: Filtro[] = [];
      const ordens: string[] = [];
      let alternativas: Filtro[][] = [];
      let de = 0;
      let ate = Number.MAX_SAFE_INTEGER;
      let contar = false;
      const cadeia = {
        select(_colunas: string, opcoes?: { count?: string }) {
          contar = opcoes?.count === "exact";
          return cadeia;
        },
        eq(col: string, valor: unknown) {
          filtros.push({ col, op: "eq", valor });
          return cadeia;
        },
        gte(col: string, valor: unknown) {
          filtros.push({ col, op: "gte", valor });
          return cadeia;
        },
        lt(col: string, valor: unknown) {
          filtros.push({ col, op: "lt", valor });
          return cadeia;
        },
        or(expr: string) {
          alternativas = alternativasDe(expr);
          return cadeia;
        },
        order(col: string) {
          ordens.push(col);
          return cadeia;
        },
        range(inicio: number, fim: number) {
          de = inicio;
          ate = fim;
          return cadeia;
        },
        then(resolver: (v: unknown) => unknown): Promise<unknown> {
          const alvo = tabela.filter(
            (linha) =>
              linhaCasa(linha, filtros) &&
              (alternativas.length === 0 || alternativas.some((alt) => linhaCasa(linha, alt))),
          );
          // ORDER BY com a prioridade da CHAMADA (a PRIMEIRA coluna manda), como
          // o PostgREST faz com os `.order()` encadeados — e descendo, que é o
          // que a rota pede. Sem ordem nenhuma o `range` paginaria lotes
          // arbitrários, que mudam com o plano.
          const ordenado = [...alvo].sort((a, b) => {
            for (const coluna of ordens) {
              const col = coluna as keyof Conversa;
              const x = a[col] ?? null;
              const y = b[col] ?? null;
              if (x === y) continue;
              return String(x) < String(y) ? 1 : -1;
            }
            return 0;
          });
          const pagina = ordenado.slice(de, Math.min(ate + 1, de + maxRows));
          leituras.push({ filtros: [...filtros], alternativas, ordens: [...ordens], de, ate });
          return Promise.resolve(resolver({ data: pagina, error: null, count: contar ? alvo.length : null }));
        },
      };
      return cadeia;
    },
  };
}

async function relatorio(query: string) {
  const resposta = await GET(new NextRequest(`http://localhost/api/v1/reports/tags${query}`));
  const corpo = await resposta.json();
  return { status: resposta.status, corpo, data: corpo.data as Payload };
}

interface Payload {
  janela: { de: string; ate: string; tz: string };
  linhas: Array<{
    etiqueta: string;
    conversas: number;
    abertas: number;
    resolvidas: number;
    espera_media_segundos: number | null;
    fatia: number;
  }>;
  total_etiquetagens: number;
  sem_dados: boolean;
  motivo: string | null;
  truncado: boolean;
}

const linhaDe = (d: Payload, etiqueta: string) => d.linhas.find((l) => l.etiqueta === etiqueta);

beforeEach(() => {
  vi.clearAllMocks();
  leituras = [];
  chamadasDeRpc = [];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG, role: "manager", name: "Org" },
    user: { id: USUARIO, idioma: "pt-BR" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createClient).mockResolvedValue(clientFalso() as never);
  tabela = [];
});

describe("1) etiqueta sem conversa no período devolve 0 — e não some da lista", () => {
  beforeEach(() => {
    tabela = [
      {
        id: "c1",
        organization_id: ORG,
        tags: ["dúvida"],
        status: "open",
        created_at: "2026-09-10T12:00:00Z",
        service_started_at: "2026-09-10T12:00:00Z",
        awaiting_since: "2026-09-10T12:00:00Z",
        last_outbound_at: null,
      },
      {
        id: "c2",
        organization_id: ORG,
        tags: ["dúvida", "urgente"],
        status: "closed",
        created_at: "2026-09-12T09:00:00Z",
        service_started_at: "2026-09-12T09:00:00Z",
        // Respondeu 30 min depois da mensagem do cliente.
        awaiting_since: "2026-09-12T09:00:00Z",
        last_outbound_at: "2026-09-12T09:30:00Z",
      },
      // Fora da janela, mas EM USO na organização: é ela que não pode sumir.
      {
        id: "c0",
        organization_id: ORG,
        tags: ["reclamação"],
        status: "closed",
        created_at: "2026-08-01T10:00:00Z",
        service_started_at: "2026-08-01T10:00:00Z",
        awaiting_since: "2026-08-01T10:00:00Z",
        last_outbound_at: "2026-08-01T10:05:00Z",
      },
    ];
  });

  it("⭐ a etiqueta em uso aparece com conversas 0, não é omitida", async () => {
    const { status, data } = await relatorio("?de=2026-09-01&ate=2026-09-30");

    expect(status).toBe(200);
    expect(data.sem_dados).toBe(false);
    const reclamacao = linhaDe(data, "reclamação");
    expect(
      reclamacao,
      "etiqueta em uso sumiu da lista quando não teve conversa no período — o gestor leria 'nunca reclamam' onde a resposta certa é 'zero neste período'",
    ).toBeDefined();
    expect(reclamacao!.conversas).toBe(0);
    expect(reclamacao!.abertas).toBe(0);
    expect(reclamacao!.resolvidas).toBe(0);
    expect(reclamacao!.fatia).toBe(0);
    // Sem conversa não há o que medir: `null` é 'não medido', `0` seria
    // 'esperou zero' — a distinção que o /metrics/atrito já defende.
    expect(reclamacao!.espera_media_segundos).toBeNull();
  });

  it("a etiqueta com conversa no período aparece com o volume delas", async () => {
    const { data } = await relatorio("?de=2026-09-01&ate=2026-09-30");

    expect(linhaDe(data, "dúvida")!.conversas).toBe(2);
    expect(linhaDe(data, "urgente")!.conversas).toBe(1);
    expect(data.total_etiquetagens).toBe(3);
  });

  it("⭐ as fatias somam 100 no máximo, mesmo com conversa de duas etiquetas", async () => {
    const { data } = await relatorio("?de=2026-09-01&ate=2026-09-30");

    const soma = data.linhas.reduce((s, l) => s + l.fatia, 0);
    expect(soma, "a barra fechou acima de 100% — arredondamento criou porcentagem").toBeLessThanOrEqual(100);
    expect(soma).toBeGreaterThan(0);
    // Ordem decrescente: a pergunta é qual assunto ocupou mais.
    expect(data.linhas[0]!.etiqueta).toBe("dúvida");
  });

  it("o desfecho é o estado da conversa, e abertas + resolvidas = volume", async () => {
    const { data } = await relatorio("?de=2026-09-01&ate=2026-09-30");

    const duvida = linhaDe(data, "dúvida")!;
    expect(duvida.resolvidas).toBe(1); // c2 está `closed`
    expect(duvida.abertas).toBe(1); // c1 está `open`
    for (const l of data.linhas) {
      expect(l.abertas + l.resolvidas, `${l.etiqueta}: desfecho não fecha o volume`).toBe(l.conversas);
    }
  });

  it("a espera conta o que o cliente esperou da nossa resposta", async () => {
    const { data } = await relatorio("?de=2026-09-01&ate=2026-09-30");

    // `dúvida`: c1 ainda sem resposta (conta a espera até AGORA — só não conta
    // se não houvesse `awaiting_since`), c2 esperou 30 min. A média é ≥ 30 min.
    expect(linhaDe(data, "dúvida")!.espera_media_segundos).toBeGreaterThanOrEqual(1800);
    expect(linhaDe(data, "urgente")!.espera_media_segundos).toBe(1800);
  });
});

describe("2) período vazio devolve lista vazia", () => {
  beforeEach(() => {
    tabela = [
      {
        id: "c0",
        organization_id: ORG,
        tags: ["dúvida"],
        status: "closed",
        created_at: "2026-08-01T10:00:00Z",
        service_started_at: "2026-08-01T10:00:00Z",
        awaiting_since: "2026-08-01T10:00:00Z",
        last_outbound_at: "2026-08-01T10:05:00Z",
      },
    ];
  });

  it("⭐ sem nenhuma conversa com etiqueta no período: lista vazia + sem_dados", async () => {
    const { status, data } = await relatorio("?de=2026-06-01&ate=2026-06-30");

    expect(status).toBe(200);
    expect(data.linhas, "período vazio devolveu linha de zeros com cara de relatório").toEqual([]);
    expect(data.sem_dados).toBe(true);
    expect(data.motivo).toBe("nenhuma_conversa_com_etiqueta_no_periodo");
    expect(data.total_etiquetagens).toBe(0);
  });

  it("organização sem nenhuma etiqueta em uso também diz que não há dados", async () => {
    tabela = [];

    const { data } = await relatorio("?de=2026-06-01&ate=2026-06-30");

    expect(data.linhas).toEqual([]);
    expect(data.sem_dados).toBe(true);
    expect(data.motivo).toBe("nenhuma_etiqueta_em_uso");
  });

  it("a lista de etiquetas pedidas que não existe NENHUMA também é sem dados", async () => {
    const { data } = await relatorio("?de=2026-06-01&ate=2026-06-30&tags=que-nao-existe");

    expect(data.linhas).toEqual([]);
    expect(data.sem_dados).toBe(true);
  });
});

describe("3) a rota não vaza conversa de outra organização", () => {
  beforeEach(() => {
    tabela = [
      {
        id: "a1",
        organization_id: ORG,
        tags: ["dúvida"],
        status: "open",
        created_at: "2026-09-10T12:00:00Z",
        service_started_at: "2026-09-10T12:00:00Z",
        awaiting_since: "2026-09-10T12:00:00Z",
        last_outbound_at: null,
      },
      {
        id: "b1",
        organization_id: OUTRA_ORG,
        tags: ["sigilosa"],
        status: "open",
        created_at: "2026-09-11T12:00:00Z",
        service_started_at: "2026-09-11T12:00:00Z",
        awaiting_since: "2026-09-11T12:00:00Z",
        last_outbound_at: null,
      },
      {
        id: "b2",
        organization_id: OUTRA_ORG,
        tags: ["dúvida"],
        status: "open",
        created_at: "2026-09-13T12:00:00Z",
        service_started_at: "2026-09-13T12:00:00Z",
        awaiting_since: "2026-09-13T12:00:00Z",
        last_outbound_at: null,
      },
    ];
  });

  it("⭐ nenhuma etiqueta nem volume da organização vizinha chega à resposta", async () => {
    const { data } = await relatorio("?de=2026-09-01&ate=2026-09-30");

    expect(
      data.linhas.map((l) => l.etiqueta),
      "etiqueta de outra organização apareceu no relatório",
    ).not.toContain("sigilosa");
    expect(linhaDe(data, "dúvida")!.conversas, "contou conversa do vizinho").toBe(1);
    expect(data.total_etiquetagens).toBe(1);
    expect(data.linhas).toHaveLength(1);
  });

  it("a dimensão também vem recortada: a função é chamada com a org de Quem chamou", async () => {
    await relatorio("?de=2026-09-01&ate=2026-09-30");

    expect(chamadasDeRpc).toEqual([{ nome: "fn_tags_de_conversa_em_uso", p_org: ORG }]);
    const orgFilter = leituras[0]!.filtros.find((f) => f.col === "organization_id");
    expect(orgFilter, "a leitura não declarou o inquilino em voz alta").toEqual({
      col: "organization_id",
      op: "eq",
      valor: ORG,
    });
  });
});

describe("a janela é do fuso de quem lê, e o pedido é validado", () => {
  beforeEach(() => {
    tabela = [
      {
        id: "c1",
        organization_id: ORG,
        tags: ["dúvida"],
        status: "open",
        created_at: "2026-09-10T12:00:00Z",
        service_started_at: "2026-09-10T12:00:00Z",
        awaiting_since: "2026-09-10T12:00:00Z",
        last_outbound_at: null,
      },
    ];
  });

  it("⭐ com `tz` a janela anda — é a prova de que o fuso é honrado", async () => {
    await relatorio("?de=2026-09-01&ate=2026-09-30&tz=UTC");
    const inicioDe = (i: number) =>
      leituras[i]!.alternativas[0]!.find((f) => f.col === "service_started_at" && f.op === "gte")!;
    const utc = inicioDe(0);

    await relatorio("?de=2026-09-01&ate=2026-09-30&tz=America/Sao_Paulo");
    const brasil = inicioDe(1);

    // São Paulo é UTC−3: o mesmo dia começa 3 horas depois em UTC.
    expect(Date.parse(String(brasil.valor)) - Date.parse(String(utc.valor))).toBe(3 * 3600_000);
  });

  it("a resposta declara a régua junto do número (janela + fuso)", async () => {
    const { data } = await relatorio("?de=2026-09-01&ate=2026-09-30&tz=America/Sao_Paulo");

    expect(data.janela).toEqual({
      de: "2026-09-01T03:00:00.000Z",
      ate: "2026-10-01T03:00:00.000Z",
      tz: "America/Sao_Paulo",
    });
  });

  it("counts conversations on their local dates across a skipped midnight", async () => {
    // These are 23:30 on September 5 and 01:30 on September 6 in Santiago.
    tabela = ["2026-09-06T03:30:00Z", "2026-09-06T04:30:00Z"].map((inicio, index) => ({
      id: `c${index}`,
      organization_id: ORG,
      tags: ["dúvida"],
      status: "open",
      created_at: inicio,
      service_started_at: inicio,
      awaiting_since: null,
      last_outbound_at: null,
    }));

    const anterior = await relatorio("?de=2026-09-05&ate=2026-09-05&tz=America/Santiago");
    const seguinte = await relatorio("?de=2026-09-06&ate=2026-09-06&tz=America/Santiago");

    expect([anterior.status, seguinte.status]).toEqual([200, 200]);
    expect([anterior.data.total_etiquetagens, seguinte.data.total_etiquetagens]).toEqual([1, 1]);
    expect([anterior.data.janela.ate, seguinte.data.janela.de]).toEqual([
      "2026-09-06T04:00:00.000Z",
      "2026-09-06T04:00:00.000Z",
    ]);
  });

  it.each([
    ["?de=2026-09-30&ate=2026-09-01", 422, "A data inicial é depois da final."],
    ["?de=2026-01-01&ate=2026-09-30", 422, "no máximo 90"],
    ["?de=01/09/2026&ate=2026-09-30", 422, "Query inválida."],
    ["?tz=Marte/Cratera", 422, "Query inválida."],
    // Formato certo, calendário impossível: o regex deixava passar, `diasDeJanela`
    // dava NaN, o teto de 90 não disparava e a janela ia até 2034.
    ["?de=2026-09-01&ate=2026-99-99", 422, "Data final inválida."],
    // …e aqui `inicioDoDia` lançava RangeError: 500 em vez de 422.
    ["?de=2026-13-01&ate=2026-13-05", 422, "Data inicial inválida."],
  ])("%s é recusado (%i)", async (query, status, trecho) => {
    const r = await relatorio(query);

    expect(r.status).toBe(status);
    expect(JSON.stringify(r.corpo)).toContain(trecho);
  });

  it("pedido sem período nenhum usa o mês corrente (padrão de /reports/financeiro)", async () => {
    const { status, data } = await relatorio("");

    const hoje = new Date().toISOString().slice(0, 10);
    expect(status).toBe(200);
    expect(data.janela.de, "o padrão não é o mês corrente").toBe(`${hoje.slice(0, 7)}-01T00:00:00.000Z`);
    // Janela semiaberta: o fim é o começo do dia SEGUINTE, para `ate=hoje`
    // incluir as conversas de hoje inteiras.
    expect(data.janela.ate.slice(0, 10)).toBe(
      new Date(Date.parse(`${hoje}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
    );
  });
});

describe("a leitura não soma página parcial como se fosse o total", () => {
  it("includes every conversation when PostgREST returns pages below the requested size", async () => {
    tabela = Array.from({ length: 235 }, (_, index) => ({
      id: `short-page-${index}`,
      organization_id: ORG,
      tags: ["dúvida"],
      status: "open",
      created_at: "2026-09-10T12:00:00Z",
      service_started_at: "2026-09-10T12:00:00Z",
      awaiting_since: null,
      last_outbound_at: null,
    }));
    vi.mocked(createClient).mockResolvedValue(clientFalso(100) as never);

    const { status, data } = await relatorio("?de=2026-09-01&ate=2026-09-30");

    expect(status).toBe(200);
    expect({ total: data.total_etiquetagens, truncado: data.truncado }).toEqual({
      total: 235,
      truncado: false,
    });
    expect(leituras.map((l) => l.de)).toEqual([0, 100, 200]);
  });

  it("⭐ o corte da leitura chega à tela como `truncado`, nunca como número exato", async () => {
    // 10.500 conversas na janela: o `max_rows = 1000` corta cada página e a rota
    // só páginas PAGINAS_MAXIMAS (10) vezes — 10.000 de 10.500 lidas, e isso
    // tem de ir à tela, nunca virar "foram 10.000".
    tabela = Array.from({ length: 10_500 }, (_, i) => ({
      id: `x${String(i).padStart(5, "0")}`,
      organization_id: ORG,
      tags: ["dúvida"],
      status: "open",
      created_at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`,
      service_started_at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`,
      awaiting_since: "2026-09-01T10:00:00Z",
      last_outbound_at: null,
    }));

    const { data } = await relatorio("?de=2026-09-01&ate=2026-09-30");

    expect(data.truncado, "a rota varreu tudo e não declarou corte").toBe(true);
    expect(data.linhas[0]!.conversas).toBe(10_000);
    expect(leituras.length, "não paginou: leu uma página só e parou").toBe(10);
    expect(
      leituras.every((l) => l.de >= 0 && l.ate - l.de + 1 <= 1000),
      "pediu além do teto que o servidor devolve",
    ).toBe(true);
  });
});

it("rounds equally frequent tags without a negative share", async () => {
  tabela = Array.from({ length: 60 }, (_, index) => ({
    id: `conversation-${index}`,
    organization_id: ORG,
    tags: [`topic-${index}`],
    status: "open",
    created_at: "2026-09-10T12:00:00Z",
    service_started_at: "2026-09-10T12:00:00Z",
    awaiting_since: null,
    last_outbound_at: null,
  }));

  const { status, data } = await relatorio("?de=2026-09-01&ate=2026-09-30");

  expect(status).toBe(200);
  const fatias = data.linhas.map((l) => l.fatia);
  expect(fatias).toHaveLength(60);
  expect(Math.min(...fatias)).toBe(1);
  expect(Math.max(...fatias)).toBe(2);
  expect(fatias.reduce((total, fatia) => total + fatia, 0)).toBe(100);
});

describe("a régua de volume é o ATENDIMENTO, e a espera não cresce depois de encerrada", () => {
  it("⭐ o cliente que volta conta no período em que voltou, não no da primeira conversa", async () => {
    // Um fio por contato: ele falou em junho, voltou em setembro — o mesmo fio
    // reaberto, com `service_started_at` novo e o `created_at` de junho.
    tabela = [
      {
        id: "volta",
        organization_id: ORG,
        tags: ["reclamação"],
        status: "open",
        created_at: "2026-06-01T10:00:00Z",
        service_started_at: "2026-09-10T10:00:00Z",
        awaiting_since: "2026-09-10T10:00:00Z",
        last_outbound_at: "2026-09-10T10:10:00Z",
      },
    ];

    const setembro = await relatorio("?de=2026-09-01&ate=2026-09-30");
    const junho = await relatorio("?de=2026-06-01&ate=2026-06-30");

    expect(
      linhaDe(setembro.data, "reclamação")!.conversas,
      "o atendimento de setembro de um contato antigo sumiu do volume de setembro",
    ).toBe(1);
    // Junho não tem atendimento nenhum: é período vazio, não "1 de junho".
    expect(junho.data.total_etiquetagens).toBe(0);
  });

  it("fio sem atendimento carimbado (grupo) cai em created_at, não some", async () => {
    tabela = [
      {
        id: "grupo",
        organization_id: ORG,
        tags: ["evento"],
        status: "open",
        created_at: "2026-09-05T10:00:00Z",
        service_started_at: null,
        awaiting_since: null,
        last_outbound_at: null,
      },
    ];

    const { data } = await relatorio("?de=2026-09-01&ate=2026-09-30");

    expect(linhaDe(data, "evento")!.conversas).toBe(1);
  });

  it("⭐ encerrada com o 'obrigado' sem resposta termina a espera no encerramento", async () => {
    tabela = [
      {
        id: "fechada",
        organization_id: ORG,
        tags: ["dúvida"],
        status: "closed",
        created_at: "2026-09-12T08:00:00Z",
        service_started_at: "2026-09-12T08:00:00Z",
        last_outbound_at: "2026-09-12T09:00:00Z",
        // O cliente escreveu depois da nossa última resposta, e fecharam 1h depois.
        awaiting_since: "2026-09-12T09:05:00Z",
        service_closed_at: "2026-09-12T10:05:00Z",
      },
      {
        id: "fechada-sem-carimbo",
        organization_id: ORG,
        tags: ["dúvida"],
        status: "closed",
        created_at: "2026-09-13T08:00:00Z",
        service_started_at: "2026-09-13T08:00:00Z",
        last_outbound_at: null,
        awaiting_since: "2026-09-13T08:00:00Z",
        service_closed_at: null,
      },
    ];

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
      const hoje = await relatorio("?de=2026-09-01&ate=2026-09-30");
      vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
      const amanha = await relatorio("?de=2026-09-01&ate=2026-09-30");

      // 3600 s, só a encerrada com carimbo: a sem carimbo é "não medido".
      expect(linhaDe(hoje.data, "dúvida")!.espera_media_segundos).toBe(3600);
      expect(
        linhaDe(amanha.data, "dúvida")!.espera_media_segundos,
        "a espera de uma conversa já encerrada cresceu com o relógio",
      ).toBe(3600);
    } finally {
      vi.useRealTimers();
    }
  });
});
