/**
 * GET /api/v1/agenda/datas-dos-negocios — a leitura da camada "Datas dos
 * negócios" (#3221).
 *
 * ─── O que este teste protege ──────────────────────────────────────────────
 *
 * A camada mostra NEGÓCIO na Agenda, e negócio é dado de CRM: quem não vê o
 * funil não pode ver a data. A prova de permissão tem duas metades, e as duas
 * estão aqui:
 *
 *   1. **Piso de papel** — a rota exige `viewer` em `crm_leads`, o MESMO piso da
 *      leitura do quadro do funil. Se `requireRole` recusa, a resposta dele é o
 *      que sai: a rota não inventa uma segunda régua nem "só esconde campos".
 *   2. **Escopo de organização** — toda consulta leva `organization_id` do
 *      cookie validado ALÉM da RLS (que é piso, não escopo). O funil de outro
 *      tenant responde 404 e não uma lista vazia: "não existe" e "não tem
 *      negócio" são respostas diferentes, e a segunda mente.
 *
 * A visibilidade por pessoa (own / own_and_unassigned / all) é da policy
 * `crm_leads_select` → `fn_can_view_lead`, e não se reimplementa aqui: o que
 * este teste cobra é que a consulta saia pelo cliente de SESSÃO (com RLS) e não
 * por admin. É por isso que o `createClient` é mockado e conferido.
 *
 * O último caso é a decisão (c) da issue: campo de data que deixou de existir no
 * funil responde `campo_nao_e_data` (422), para a tela esquecer a escolha em vez
 * de mostrar grade vazia sem motivo.
 */
// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Linha = Record<string, unknown> & { id: string };

/**
 * Supabase de mentira que aplica os filtros recebidos, como o PostgREST.
 *
 * Ele entende UM formato de coluna que o PostgREST também entende:
 * `custom_fields->>chave` — o caminho jsonb que a rota usa para filtrar por
 * data. Sem isso o dublê aceitaria qualquer string e o teste não provaria que o
 * filtro de data existe.
 */
function fakeDb({
  pipelines,
  stages = [],
  leads = [],
}: {
  pipelines: Linha[];
  stages?: Linha[];
  leads?: Linha[];
}) {
  type Filtro = { op: string; coluna: string; valor: unknown };
  const consultas: Array<{ tabela: string; filtros: Filtro[] }> = [];

  function valorDe(linha: Linha, coluna: string): unknown {
    const caminho = /^([a-z_]+)->>([a-z0-9_]+)$/i.exec(coluna);
    if (caminho) {
      const objeto = linha[caminho[1]!];
      return objeto && typeof objeto === "object"
        ? (objeto as Record<string, unknown>)[caminho[2]!]
        : undefined;
    }
    return linha[coluna];
  }

  function casa(linha: Linha, { op, coluna, valor }: Filtro): boolean {
    if (op === "or") return partesDoOr(String(valor)).some((parte) => condicao(linha, parte));
    const atual = valorDe(linha, coluna);
    if (op === "eq") return atual === valor;
    if (op === "neq") return atual !== valor;
    if (op === "not") return atual !== null && atual !== undefined;
    // Como no SQL, comparar com NULL não é verdadeiro.
    if (atual === null || atual === undefined) return false;
    if (op === "gte") return String(atual) >= String(valor);
    if (op === "lte") return String(atual) <= String(valor);
    if (op === "lt") return String(atual) < String(valor);
    throw new Error(`filtro desconhecido: ${op}`);
  }

  /** `a.gte.x,and(b.gte.x,b.lt.y)`: o pedaço da sintaxe do `or` que a rota usa. */
  function partesDoOr(texto: string): string[] {
    return texto.match(/and\([^)]*\)|[^,]+/g) ?? [];
  }

  function condicao(linha: Linha, texto: string): boolean {
    const todas = /^and\((.*)\)$/.exec(texto);
    if (todas) return partesDoOr(todas[1]!).every((parte) => condicao(linha, parte));
    const simples = /^(.+?)\.(gte|lt)\.(.+)$/.exec(texto);
    if (!simples) throw new Error(`or não entendido: ${texto}`);
    return casa(linha, { op: simples[2]!, coluna: simples[1]!, valor: simples[3]! });
  }

  function tabela(nome: string) {
    const linhas = nome === "crm_pipelines" ? pipelines : nome === "crm_stages" ? stages : leads;
    const filtros: Filtro[] = [];
    const ordem: string[] = [];
    let limite = Number.POSITIVE_INFINITY;
    consultas.push({ tabela: nome, filtros });

    // Filtro, ordem e `limit` valem de verdade e nessa sequência: sem isso, o
    // dublê não enxerga a fatia que o banco devolve, que foi onde a semana
    // visível se perdeu.
    const resultado = () => {
      const achadas = linhas.filter((linha) => filtros.every((filtro) => casa(linha, filtro)));
      const ordenadas = ordem.length
        ? [...achadas].sort((x, y) => {
            for (const coluna of ordem) {
              const [a, b] = [String(valorDe(x, coluna)), String(valorDe(y, coluna))];
              if (a !== b) return a < b ? -1 : 1;
            }
            return 0;
          })
        : achadas;
      return { data: ordenadas.slice(0, limite), error: null };
    };

    const q = {
      select: () => q,
      eq: (coluna: string, valor: unknown) => {
        filtros.push({ op: "eq", coluna, valor });
        return q;
      },
      neq: (coluna: string, valor: unknown) => {
        filtros.push({ op: "neq", coluna, valor });
        return q;
      },
      not: (coluna: string, _operador: string, valor: unknown) => {
        filtros.push({ op: "not", coluna, valor });
        return q;
      },
      gte: (coluna: string, valor: unknown) => {
        filtros.push({ op: "gte", coluna, valor });
        return q;
      },
      lte: (coluna: string, valor: unknown) => {
        filtros.push({ op: "lte", coluna, valor });
        return q;
      },
      lt: (coluna: string, valor: unknown) => {
        filtros.push({ op: "lt", coluna, valor });
        return q;
      },
      or: (valor: string) => {
        filtros.push({ op: "or", coluna: "", valor });
        return q;
      },
      order: (coluna: string) => {
        ordem.push(coluna);
        return q;
      },
      limit: (n: number) => {
        limite = n;
        return q;
      },
      maybeSingle: async () => {
        const { data } = resultado();
        return { data: data[0] ?? null, error: null };
      },
      then: (resolver: (valor: unknown) => unknown) => Promise.resolve(resultado()).then(resolver),
    };
    return q;
  }

  return { cliente: { from: tabela } as never, consultas };
}

function funilComDatas() {
  return {
    id: FUNIL,
    // A consulta filtra por organização ALÉM do id: sem esta coluna o dublê
    // devolveria 404 e o caso passaria a medir a coisa errada.
    organization_id: ORG,
    name: "Viagens",
    settings: {
      fields: [
        { key: "data_inicio", label: "Embarque", type: "date" },
        { key: "data_fim", label: "Retorno", type: "date" },
        { key: "observacoes", label: "Observações", type: "textarea" },
      ],
    },
  } as Linha;
}

function req(query: Record<string, string>) {
  const url = new URL("http://localhost/api/v1/agenda/datas-dos-negocios");
  for (const [chave, valor] of Object.entries(query)) url.searchParams.set(chave, valor);
  return new NextRequest(url);
}

const CONSULTA_BASE = {
  pipeline_id: FUNIL,
  campo: "data_inicio",
  de: "2026-03-09",
  ate: "2026-03-15",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
});

describe("GET /api/v1/agenda/datas-dos-negocios", () => {
  it("usa o MESMO piso de papel da leitura do funil: viewer em crm_leads", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeDb({ pipelines: [funilComDatas()] }).cliente);

    await GET(req(CONSULTA_BASE));

    expect(requireRole).toHaveBeenCalledWith("viewer", expect.objectContaining({ resource: "crm_leads" }));
  });

  it("sem permissão, a resposta é a do requireRole — a rota não abre porta paralela", async () => {
    const recusa = new Response("negado", { status: 403 });
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: recusa } as never);

    const res = await GET(req(CONSULTA_BASE));

    expect(res.status).toBe(403);
    // Nada de banco: consulta recusada não chega a rodar.
    expect(createClient).not.toHaveBeenCalled();
  });

  it("o negócio aparece no dia do campo, com o rótulo do campo", async () => {
    const { cliente } = fakeDb({
      pipelines: [funilComDatas()],
      stages: [{ id: ETAPA, name: "Reservado", organization_id: ORG, pipeline_id: FUNIL }],
      leads: [
        {
          id: "lead-1",
          title: "Família Prado — Gramado",
          organization_id: ORG,
          pipeline_id: FUNIL,
          stage_id: ETAPA,
          status: "open",
          custom_fields: { data_inicio: "2026-03-10", data_fim: "2026-03-15" },
        },
      ],
    });
    vi.mocked(createClient).mockResolvedValue(cliente);

    const res = await GET(req(CONSULTA_BASE));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.itens).toHaveLength(1);
    expect(corpo.data.itens[0]).toMatchObject({
      dia: "2026-03-10",
      rotulos: ["Embarque"],
      negocio: { id: "lead-1", titulo: "Família Prado — Gramado", etapaNome: "Reservado" },
    });
    expect(corpo.data.truncado).toBe(false);
  });

  it("negócio SEM data não volta — nem quando o banco o entrega", async () => {
    const { cliente } = fakeDb({
      pipelines: [funilComDatas()],
      stages: [{ id: ETAPA, name: "Reservado", organization_id: ORG, pipeline_id: FUNIL }],
      leads: [
        {
          id: "lead-sem-data",
          title: "Sem data",
          organization_id: ORG,
          pipeline_id: FUNIL,
          stage_id: ETAPA,
          status: "open",
          custom_fields: {},
        },
      ],
    });
    vi.mocked(createClient).mockResolvedValue(cliente);

    const corpo = await (await GET(req(CONSULTA_BASE))).json();

    // Defesa em profundidade: o `where` já filtra, e o módulo puro joga fora de
    // novo — quem responde a issue é a régua de dia, não o banco.
    expect(corpo.data.itens).toEqual([]);
  });

  it("a consulta é desta organização E deste funil — RLS é piso, não escopo", async () => {
    const { cliente, consultas } = fakeDb({
      pipelines: [funilComDatas()],
      stages: [{ id: ETAPA, name: "Reservado", organization_id: ORG, pipeline_id: FUNIL }],
      leads: [],
    });
    vi.mocked(createClient).mockResolvedValue(cliente);

    await GET(req(CONSULTA_BASE));

    const leads = consultas.find((c) => c.tabela === "crm_leads")!;
    expect(leads.filtros).toContainEqual({ op: "eq", coluna: "organization_id", valor: ORG });
    expect(leads.filtros).toContainEqual({ op: "eq", coluna: "pipeline_id", valor: FUNIL });
    // E o filtro de data vai no WHERE: varrer o funil inteiro para desenhar uma
    // semana é o que a #3172 mediu em 19 s.
    const filtrosDeData = leads.filtros.filter((f) => f.coluna === "custom_fields->>data_inicio");
    expect(filtrosDeData.map((f) => f.op).sort()).toEqual(["gte", "lt", "not"]);
  });

  it("funil de OUTRA organização: 404, e não lista vazia", async () => {
    const { cliente } = fakeDb({ pipelines: [{ ...funilComDatas(), organization_id: "outra" }] });
    vi.mocked(createClient).mockResolvedValue(cliente);

    const res = await GET(req(CONSULTA_BASE));

    expect(res.status).toBe(404);
  });

  it("campo que não é data do negócio: 422 campo_nao_e_data (decisão (c))", async () => {
    const { cliente } = fakeDb({ pipelines: [funilComDatas()] });
    vi.mocked(createClient).mockResolvedValue(cliente);

    const res = await GET(req({ ...CONSULTA_BASE, campo: "observacoes" }));
    const corpo = await res.json();

    expect(res.status).toBe(422);
    expect(corpo.error.code).toBe("campo_nao_e_data");
  });

  it("campo de data que sumiu do funil: 422, para a tela esquecer a escolha", async () => {
    const semOcampo = funilComDatas();
    semOcampo.settings = { fields: [{ key: "data_fim", label: "Retorno", type: "date" }] };
    const { cliente } = fakeDb({ pipelines: [semOcampo] });
    vi.mocked(createClient).mockResolvedValue(cliente);

    const res = await GET(req(CONSULTA_BASE));
    const corpo = await res.json();

    expect(res.status).toBe(422);
    expect(corpo.error.code).toBe("campo_nao_e_data");
  });

  it("período inválido não chega ao banco", async () => {
    const res = await GET(req({ ...CONSULTA_BASE, de: "2026-03-15", ate: "2026-03-09" }));
    const corpo = await res.json();

    expect(res.status).toBe(422);
    expect(corpo.error.code).toBe("validation_error");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("data de calendário impossível: 422 data_de_calendario_invalida, sem tocar o banco", async () => {
    for (const de of ["2026-02-31", "2026-13-01"]) {
      const res = await GET(req({ ...CONSULTA_BASE, de, ate: "2026-03-05" }));
      const corpo = await res.json();

      expect(res.status, `de=${de}`).toBe(422);
      expect(corpo.error.code, `de=${de}`).toBe("data_de_calendario_invalida");
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it("data de calendário impossível no FIM do período também é recusada", async () => {
    const res = await GET(req({ ...CONSULTA_BASE, de: "2026-03-01", ate: "2026-04-31" }));
    const corpo = await res.json();

    expect(res.status).toBe(422);
    expect(corpo.error.code).toBe("data_de_calendario_invalida");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("2026-02-28 é data de calendário válida: 200", async () => {
    const { cliente } = fakeDb({ pipelines: [funilComDatas()], leads: [] });
    vi.mocked(createClient).mockResolvedValue(cliente);

    const res = await GET(req({ ...CONSULTA_BASE, de: "2026-02-28", ate: "2026-03-05" }));

    expect(res.status).toBe(200);
  });

  it("pipeline_id que não é UUID: 422 validation_error, sem chegar ao PostgREST", async () => {
    const res = await GET(req({ ...CONSULTA_BASE, pipeline_id: "nao-e-uuid" }));
    const corpo = await res.json();

    expect(res.status).toBe(422);
    expect(corpo.error.code).toBe("validation_error");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("campo_fim vazio vale ausente: a camada é de PONTO, e não erro", async () => {
    const { cliente } = fakeDb({ pipelines: [funilComDatas()], leads: [] });
    vi.mocked(createClient).mockResolvedValue(cliente);

    const res = await GET(req({ ...CONSULTA_BASE, campo_fim: "" }));

    expect(res.status).toBe(200);
  });

  it("campo com sintaxe de filtro do PostgREST é recusado ANTES de virar consulta", async () => {
    // `campo` é interpolado em `custom_fields->>campo`: uma vírgula ali seria
    // sintaxe de filtro, não nome de campo — a régua da escrita do funil fecha
    // essa porta, e nada chega ao banco.
    const res = await GET(req({ ...CONSULTA_BASE, campo: "data_inicio,status" }));
    const corpo = await res.json();

    expect(res.status).toBe(422);
    expect(corpo.error.code).toBe("validation_error");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("com segundo campo, o retorno vem no dia do retorno", async () => {
    const { cliente } = fakeDb({
      pipelines: [funilComDatas()],
      stages: [{ id: ETAPA, name: "Reservado", organization_id: ORG, pipeline_id: FUNIL }],
      leads: [
        {
          id: "lead-1",
          title: "Família Prado — Gramado",
          organization_id: ORG,
          pipeline_id: FUNIL,
          stage_id: ETAPA,
          status: "open",
          custom_fields: { data_inicio: "2026-03-10", data_fim: "2026-03-12" },
        },
      ],
    });
    vi.mocked(createClient).mockResolvedValue(cliente);

    const corpo = await (await GET(req({ ...CONSULTA_BASE, campo_fim: "data_fim" }))).json();

    expect(corpo.data.itens.map((i: { dia: string; rotulos: string[] }) => [i.dia, i.rotulos[0]])).toEqual([
      ["2026-03-10", "Embarque"],
      ["2026-03-12", "Retorno"],
    ]);
  });

  /** Um negócio deste funil, com as datas do caso. */
  function negocio(id: string, campos: Record<string, unknown>): Linha {
    return {
      id,
      title: id,
      organization_id: ORG,
      pipeline_id: FUNIL,
      stage_id: ETAPA,
      status: "open",
      custom_fields: campos,
    };
  }

  /** Muitos negócios com data no ano anterior, vindos ANTES na ordem física. */
  function antigos(quantos: number, campos: Record<string, unknown>): Linha[] {
    return Array.from({ length: quantos }, (_, i) =>
      negocio(`antigo-${String(i).padStart(3, "0")}`, campos),
    );
  }

  describe("funil com volume: o teto de leitura não pode engolir a janela", () => {
    it("um campo: 600 antigos não tiram da tela o negócio da semana", async () => {
      const { cliente } = fakeDb({
        pipelines: [funilComDatas()],
        leads: [
          ...antigos(600, { data_inicio: "2025-06-15" }),
          negocio("da-semana", { data_inicio: "2026-03-10" }),
        ],
      });
      vi.mocked(createClient).mockResolvedValue(cliente);

      const corpo = await (await GET(req(CONSULTA_BASE))).json();

      expect(corpo.data.itens.map((i: { negocio: { id: string } }) => i.negocio.id)).toEqual([
        "da-semana",
      ]);
      expect(corpo.data.truncado).toBe(false);
    });

    it("dois campos: a ida e a volta da semana aparecem, e os antigos ficam de fora", async () => {
      const { cliente } = fakeDb({
        pipelines: [funilComDatas()],
        leads: [
          ...antigos(600, { data_inicio: "2025-06-15", data_fim: "2025-06-20" }),
          negocio("so-a-volta", { data_inicio: "2026-02-20", data_fim: "2026-03-12" }),
          negocio("so-a-ida", { data_inicio: "2026-03-10", data_fim: "2026-03-20" }),
        ],
      });
      vi.mocked(createClient).mockResolvedValue(cliente);

      const corpo = await (await GET(req({ ...CONSULTA_BASE, campo_fim: "data_fim" }))).json();

      expect(
        corpo.data.itens.map((i: { dia: string; negocio: { id: string } }) => [i.dia, i.negocio.id]),
      ).toEqual([
        ["2026-03-10", "so-a-ida"],
        ["2026-03-12", "so-a-volta"],
      ]);
      expect(corpo.data.truncado).toBe(false);
    });

    it("data com hora no último dia da janela entra", async () => {
      const { cliente } = fakeDb({
        pipelines: [funilComDatas()],
        leads: [negocio("com-hora", { data_inicio: "2026-03-15T12:00:00Z" })],
      });
      vi.mocked(createClient).mockResolvedValue(cliente);

      const corpo = await (await GET(req(CONSULTA_BASE))).json();

      expect(corpo.data.itens.map((i: { dia: string }) => i.dia)).toEqual(["2026-03-15"]);
    });

    it("mais negócios que o teto dentro da janela: truncado, e a fatia não depende da ordem física", async () => {
      const naJanela = Array.from({ length: 510 }, (_, i) =>
        negocio(`lead-${String(i).padStart(3, "0")}`, { data_inicio: "2026-03-10" }),
      ).reverse();
      const { cliente } = fakeDb({ pipelines: [funilComDatas()], leads: naJanela });
      vi.mocked(createClient).mockResolvedValue(cliente);

      const corpo = await (await GET(req(CONSULTA_BASE))).json();
      const ids = corpo.data.itens.map((i: { negocio: { id: string } }) => i.negocio.id);

      expect(corpo.data.truncado).toBe(true);
      expect(ids).toHaveLength(500);
      expect(ids[0]).toBe("lead-000");
      expect(ids[499]).toBe("lead-499");
    });
  });
});
