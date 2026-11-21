import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { type RespostaDoRelatorioComercial } from "@/lib/relatorios/comercial";

const ORG = "11111111-1111-1111-1111-111111111111";
const FUNIL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FUNIL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/**
 * O dublê do banco: registra CADA consulta montada, na ordem, com a tabela e os
 * filtros. É o que permite contar as consultas da tela (caso f) e provar que o
 * recorte foi para o SQL (caso do filtro).
 *
 * `then` responde o que a consulta pediu: `head` devolve só `count`; com
 * `range`, a fatia pedida (a paginação de `lerPaginado`).
 */
interface Consulta {
  tabela: string;
  ops: string[];
}

function makeDb(linhas: Record<string, unknown>[], opts: { semData?: number } = {}) {
  const consultas: Consulta[] = [];

  function builder(tabela: string) {
    const registro: Consulta = { tabela, ops: [] };
    consultas.push(registro);
    let head = false;
    let faixa: [number, number] | null = null;

    const b: Record<string, unknown> = {
      select(_colunas: string, cfg?: { count?: string; head?: boolean }) {
        if (cfg?.head) head = true;
        registro.ops.push("select");
        return b;
      },
      eq(coluna: string, valor: unknown) {
        registro.ops.push(`eq:${coluna}=${String(valor)}`);
        return b;
      },
      gte(coluna: string, valor: unknown) {
        registro.ops.push(`gte:${coluna}=${String(valor)}`);
        return b;
      },
      lt(coluna: string, valor: unknown) {
        registro.ops.push(`lt:${coluna}=${String(valor)}`);
        return b;
      },
      is(coluna: string, valor: unknown) {
        registro.ops.push(`is:${coluna}=${String(valor)}`);
        return b;
      },
      order(coluna: string) {
        registro.ops.push(`order:${coluna}`);
        return b;
      },
      range(inicio: number, fim: number) {
        faixa = [inicio, fim];
        registro.ops.push(`range:${inicio}-${fim}`);
        return b;
      },
      then(ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) {
        const resposta = head
          ? { data: null, error: null, count: opts.semData ?? 0 }
          : {
              data: faixa ? linhas.slice(faixa[0], faixa[1] + 1) : linhas,
              error: null,
              count: linhas.length,
            };
        return Promise.resolve(resposta).then(ok, falha);
      },
    };
    return b;
  }

  const db = { from: vi.fn(builder) };
  vi.mocked(createClient).mockResolvedValue(db as never);
  return { db, consultas };
}

function authOk(timezone = "America/Sao_Paulo") {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR", is_platform_admin: false, support: false },
    org: {
      orgId: ORG,
      name: "Empresa",
      role: "viewer",
      timezone,
      currency: "BRL",
    },
  } as never);
}

function pedir(query = "?de=2026-09-01&ate=2026-09-30") {
  return new NextRequest(`http://localhost/api/v1/reports/comercial${query}`);
}

function ganho(patch: Record<string, unknown> = {}) {
  return {
    id: "lead-1",
    status: "won",
    value_cents: 50_000,
    currency: "BRL",
    contact_id: "c1",
    tags: ["plano"],
    closed_at: "2026-09-10T15:00:00.000Z",
    contacts: { id: "c1", display_name: "Ana", name: "Ana", phone_number: "+55 11 9" },
    pipeline_id: FUNIL_A,
    title: "Plano anual",
    crm_pipelines: { id: FUNIL_A, name: "Vendas" },
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/reports/comercial", () => {
  it("(e) 200 com X-Request-Id e o período no fuso da ORGANIZAÇÃO", async () => {
    authOk();
    makeDb([ganho()]);

    const { GET } = await import("./route");
    const res = await GET(pedir());

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();

    const corpo = (await res.json()) as { data: RespostaDoRelatorioComercial };
    expect(corpo.data.clientes).toEqual([{ contact_id: "c1", centavos: 50_000, negocios: 1 }]);
    expect(corpo.data.tags).toEqual([{ tag: "plano", centavos: 50_000, negocios: 1 }]);
    // São Paulo: o dia começa às 03:00Z.
    expect(corpo.data.janela.tz).toBe("America/Sao_Paulo");
    expect(corpo.data.janela.from).toBe("2026-09-01T03:00:00.000Z");
    expect(corpo.data.janela.to).toBe("2026-10-01T03:00:00.000Z");
    // O nome do contato chega junto, do recurso embutido.
    expect(corpo.data.contatos.c1?.display_name).toBe("Ana");
  });

  it("o recorte vai para o SQL: organização, status ganho e a janela semiaberta", async () => {
    authOk();
    const { consultas } = makeDb([ganho()]);

    const { GET } = await import("./route");
    await GET(pedir());

    const leads = consultas.filter((c) => c.tabela === "crm_leads" && c.ops.includes("select"));
    const primeira = leads[0]?.ops.join(" ") ?? "";
    expect(primeira).toContain(`eq:organization_id=${ORG}`);
    expect(primeira).toContain("eq:status=won");
    expect(primeira).toContain("gte:closed_at=2026-09-01T03:00:00.000Z");
    expect(primeira).toContain("lt:closed_at=2026-10-01T03:00:00.000Z");
  });

  it("starts the sales query at the first local hour when midnight is skipped", async () => {
    authOk("America/Santiago");
    const { consultas } = makeDb([]);

    const { GET } = await import("./route");
    const res = await GET(pedir("?de=2026-09-06&ate=2026-09-06"));

    expect(res.status).toBe(200);
    // In Santiago, September 6 started at 01:00 local time (04:00 UTC).
    expect(consultas[0]?.ops).toContain("gte:closed_at=2026-09-06T04:00:00.000Z");
    expect(consultas[0]?.ops).toContain("lt:closed_at=2026-09-07T03:00:00.000Z");
  });

  it("(c) período vazio devolve ZEROS explícitos e 200 — não erro", async () => {
    authOk();
    makeDb([]);

    const { GET } = await import("./route");
    const res = await GET(pedir("?de=2026-09-01&ate=2026-09-02"));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: RespostaDoRelatorioComercial };
    // Sem total próprio de vendas: o número de faturamento é o da tela de Faturamento.
    expect(corpo.data).not.toHaveProperty("faturamento_centavos");
    expect(corpo.data.negocios_ganhos).toBe(0);
    expect(corpo.data.tags).toEqual([]);
    expect(corpo.data.clientes).toEqual([]);
    expect(corpo.data.sem_dados).toBe(true);
    expect(corpo.data.motivo).toBe("nenhum_negocio_ganho_no_periodo");
  });

  it("(f) a tela faz DUAS consultas, e o número não cresce com tags nem com clientes", async () => {
    authOk();
    const poucos = makeDb([ganho()]);
    const { GET } = await import("./route");
    await GET(pedir());
    const comPoucos = poucos.consultas.length;

    vi.clearAllMocks();
    authOk();
    const muitos = makeDb(
      Array.from({ length: 40 }, (_, i) =>
        ganho({
          id: `lead-${i}`,
          contact_id: `contato-${i}`,
          tags: [`tag-${i}`, "plano"],
          value_cents: 1_000 * (i + 1),
        }),
      ),
    );
    await GET(pedir());
    const comMuitos = muitos.consultas.length;

    expect(comPoucos).toBe(2);
    expect(comMuitos).toBe(2);
    // Nenhuma consulta por tag/cliente: o contato vem embutido nos negócios.
    expect(muitos.consultas.filter((c) => c.tabela === "contacts")).toHaveLength(0);
  });

  it("conta o ganho SEM data de fechamento em vez de escondê-lo", async () => {
    authOk();
    makeDb([ganho()], { semData: 3 });

    const { GET } = await import("./route");
    const res = await GET(pedir());

    const corpo = (await res.json()) as { data: RespostaDoRelatorioComercial };
    expect(corpo.data.excluidos.sem_data_de_ganho).toBe(3);
  });

  it("período invertido → 422, porque zero leria como 'não vendemos nada'", async () => {
    authOk();
    makeDb([]);

    const { GET } = await import("./route");
    const res = await GET(pedir("?de=2026-09-30&ate=2026-09-01"));

    expect(res.status).toBe(422);
  });

  it("período acima do teto → 422", async () => {
    authOk();
    makeDb([]);

    const { GET } = await import("./route");
    const res = await GET(pedir("?de=2024-01-01&ate=2026-01-01"));

    expect(res.status).toBe(422);
  });

  // O teto é o MESMO da rota de faturamento (400 dias entre `de` e `ate`): a tela
  // chama as duas com o mesmo período, e os rankings não podem responder erro
  // num período em que os cartões aparecem. Antes eram 366 aqui e 400 lá.
  it("400 dias entre as datas é aceito — o mesmo teto da tela de Faturamento", async () => {
    authOk();
    makeDb([]);

    const { GET } = await import("./route");
    const res = await GET(pedir("?de=2025-01-01&ate=2026-02-05"));

    expect(res.status).toBe(200);
  });

  it("401 dias entre as datas é recusado, e o teto vai dito em details", async () => {
    authOk();
    makeDb([]);

    const { GET } = await import("./route");
    const res = await GET(pedir("?de=2025-01-01&ate=2026-02-06"));

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { details?: { maximo_dias?: number } } };
    expect(corpo.error.details?.maximo_dias).toBe(400);
  });

  // ─── O recorte por funil e tag (#4802, item 4) ─────────────────────────────

  it("recorta por funil e por tag, e devolve o nome do funil do mesmo pedido", async () => {
    authOk();
    makeDb([
      ganho({ id: "a", tags: ["Cliente "] }),
      ganho({ id: "b", tags: ["revenda"] }),
      ganho({
        id: "c",
        pipeline_id: FUNIL_B,
        tags: ["cliente"],
        crm_pipelines: [{ id: FUNIL_B, name: "Recompra" }],
      }),
    ]);

    const { GET } = await import("./route");
    const res = await GET(pedir(`?de=2026-09-01&ate=2026-09-30&pipeline_id=${FUNIL_A}&tag=CLIENTE`));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: RespostaDoRelatorioComercial };
    // A tag do filtro sai normalizada, e acha "Cliente " gravado com espaço.
    expect(corpo.data.filtro).toEqual({ pipeline_id: FUNIL_A, tag: "cliente" });
    expect(corpo.data.vendas.map((v) => v.id)).toEqual(["a"]);
    // As opções são do período inteiro, não do recorte.
    expect(corpo.data.opcoes.pipeline_ids).toEqual([FUNIL_A, FUNIL_B]);
    // O nome vem do recurso embutido, nas duas formas que o PostgREST devolve.
    expect(corpo.data.nomes_dos_funis).toEqual({ [FUNIL_A]: "Vendas", [FUNIL_B]: "Recompra" });
  });

  it("com recorte continuam DUAS consultas, e a contagem sem data respeita o funil", async () => {
    authOk();
    const { consultas } = makeDb([ganho()], { semData: 1 });

    const { GET } = await import("./route");
    await GET(pedir(`?de=2026-09-01&ate=2026-09-30&pipeline_id=${FUNIL_A}&tag=plano`));

    expect(consultas).toHaveLength(2);
    // A leitura do período NÃO leva o recorte: as opções precisam do período inteiro.
    expect(consultas[0]?.ops.join(" ")).not.toContain("eq:pipeline_id");
    // A contagem de ganhos sem data leva o funil escolhido.
    expect(consultas[1]?.ops).toContain(`eq:pipeline_id=${FUNIL_A}`);
    expect(consultas[1]?.ops).toContain("is:closed_at=null");
  });

  it("funil que não é uuid → 422, sem ler o banco", async () => {
    authOk();
    const { db } = makeDb([ganho()]);

    const { GET } = await import("./route");
    const res = await GET(pedir("?de=2026-09-01&ate=2026-09-30&pipeline_id=nao-e-uuid"));

    expect(res.status).toBe(422);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("parâmetros de recorte vazios contam como sem recorte", async () => {
    authOk();
    makeDb([ganho()]);

    const { GET } = await import("./route");
    const res = await GET(pedir("?de=2026-09-01&ate=2026-09-30&pipeline_id=&tag="));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: RespostaDoRelatorioComercial };
    expect(corpo.data.filtro).toEqual({ pipeline_id: null, tag: null });
  });

  it("sem auth repassa a resposta do requireRole e não lê o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    } as never);
    const { db } = makeDb([ganho()]);

    const { GET } = await import("./route");
    const res = await GET(pedir());

    expect(res.status).toBe(401);
    expect(db.from).not.toHaveBeenCalled();
  });
});
