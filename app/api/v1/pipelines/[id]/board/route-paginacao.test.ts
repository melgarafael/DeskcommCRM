/**
 * O QUADRO DO FUNIL NÃO PODE MAIS CORTAR CALADO (#4321).
 *
 * A leitura dos negócios era UMA consulta: `select("*")`, sem `organization_id`
 * e sem `.range()`. O PostgREST corta toda resposta em `max_rows`
 * (`supabase/config.toml: max_rows = 1000`) sem devolver erro — acima de mil
 * negócios o quadro chegava com um pedaço arbitrário e a tela o apresentava como
 * se fosse o funil inteiro. Sem o filtro de organização, o índice
 * `idx_crm_leads_org_pipeline_position_id` (a ordem EXATA desta consulta, mas
 * começando por `organization_id`) também não servia para nada.
 *
 * As réguas deste arquivo:
 *
 *  (a) a consulta MONTADA carrega `organization_id` e as colunas explícitas do
 *      contrato — provado por dublê que captura o builder, e não por leitura do
 *      texto da rota: um `select("*")` dentro de um comentário não consulta nada;
 *  (b) 1.200 negócios voltam TODOS, na ordem `position_in_stage, id`;
 *  (c) o funil pequeno responde EXATAMENTE o que respondia antes — nenhum campo
 *      a mais, nenhum a menos, nenhum aviso;
 *  (d) quando o fim não pode ser provado, a resposta AVISA (`truncado` no corpo
 *      e `X-Quadro-Truncado`) em vez de fingir que veio tudo;
 *  (e) negócio de OUTRA organização não aparece no quadro.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    idioma: "pt-BR",
  })),
}));

import { createClient } from "@/lib/supabase/server";
import {
  ORG_ID,
  OUTRA_ORG,
  PIPE,
  etapa,
  funilRow,
  makeDb,
  negocio,
  type DbOpts,
  type LeadRow,
} from "@/tests/helpers/stages-db-double";

/**
 * Um negócio com TODAS as colunas do contrato `Lead`.
 *
 * É de propósito completo: o caso (c) compara o corpo inteiro, e uma coluna que
 * sumisse do `select` explícito apareceria aqui como campo faltando — o teste
 * não pode passar só porque a linha de teste trazia meia dúzia de campos.
 */
function linhaCompleta(id: string, posicao: number, over: Partial<LeadRow> = {}) {
  return {
    ...negocio(id, "e1"),
    title: `Negócio ${id}`,
    description: null,
    lost_reason: null,
    status: "open" as const,
    position_in_stage: posicao,
    value_cents: 1000,
    recurring_value_cents: null,
    recurring_period: null,
    recurring_months: null,
    currency: "BRL",
    owner_user_id: null,
    owner_kind: null,
    owner_agent_id: null,
    assigned_at: null,
    last_activity_at: "2026-01-01T00:00:00.000Z",
    stage_changed_at: "2026-01-01T00:00:00.000Z",
    expected_close_date: null,
    closed_at: null,
    source: "manual",
    source_metadata: {},
    external_id: null,
    custom_fields: {},
    tags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    created_by_user_id: null,
    ...over,
  };
}

/** Banco do quadro: um funil, as etapas e os negócios declarados. */
function banco(opts: DbOpts = {}) {
  return makeDb({
    pipelines: [funilRow({ id: PIPE, name: "Pedidos", settings: { fields: [], lost_reasons: [] } })],
    stages: [etapa({ id: "e1", name: "Novo", position: 1000 })],
    ...opts,
  });
}

async function lerQuadro(): Promise<{
  status: number;
  corpo: {
    data?: {
      pipeline?: { id: string };
      stages?: unknown[];
      leads?: Array<Record<string, unknown>>;
      truncado?: true;
    };
  };
  headers: Headers;
}> {
  const { GET } = await import("./route");
  const res = await GET(new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/board`), {
    params: Promise.resolve({ id: PIPE }),
  });
  return { status: res.status, corpo: (await res.json()) as never, headers: res.headers };
}

/**
 * Dublê que CAPTURA o builder: cada método encadeado em cada `from()` fica
 * registrado com os argumentos, e a resposta é a do banco de verdade do dublê
 * (`makeDb`) — captura e comportamento no mesmo objeto.
 */
function bancoQueRegistra(opts: DbOpts = {}) {
  const db = banco(opts);
  const real = db.client as unknown as {
    from: (t: string) => Record<string, unknown>;
    rpc: unknown;
    auth: unknown;
  };
  const consultas: Array<{ tabela: string; chamadas: Array<{ metodo: string; args: unknown[] }> }> =
    [];

  const client = {
    rpc: real.rpc,
    auth: real.auth,
    from(tabela: string) {
      const alvo = real.from(tabela);
      const registro = { tabela, chamadas: [] as Array<{ metodo: string; args: unknown[] }> };
      consultas.push(registro);
      let soma: unknown;
      soma = new Proxy(alvo, {
        get(obj, prop) {
          const valor = Reflect.get(obj, prop);
          if (typeof valor !== "function") return valor;
          return (...args: unknown[]) => {
            registro.chamadas.push({ metodo: String(prop), args });
            const r = (valor as (...a: unknown[]) => unknown).apply(obj, args);
            // Os métodos do builder devolvem o PRÓPRIO builder: devolver o
            // objeto cru tiraria o proxy do encadeamento e a captura pararia no
            // primeiro `.eq()`.
            return r === obj ? soma : r;
          };
        },
      });
      return soma;
    },
  };
  vi.mocked(createClient).mockResolvedValue(client as never);
  return {
    db,
    /** A leitura paginada dos negócios: a única de `crm_leads` que usa `.range()`. */
    leituraDosNegocios() {
      const achada = consultas.find(
        (c) => c.tabela === "crm_leads" && c.chamadas.some((m) => m.metodo === "range"),
      );
      if (!achada) throw new Error("a rota não emitiu leitura paginada de crm_leads");
      return achada.chamadas;
    },
  };
}

const argDe = (chamadas: Array<{ metodo: string; args: unknown[] }>, metodo: string) =>
  chamadas.filter((c) => c.metodo === metodo).map((c) => c.args);

describe("GET /board — a leitura dos negócios não corta calado (#4321)", () => {
  it("⭐ (a) a consulta montada filtra pela organização e pede colunas EXPLÍCITAS", async () => {
    const registro = bancoQueRegistra({ leads: [linhaCompleta("n1", 10)] });

    const { status } = await lerQuadro();
    expect(status).toBe(200);

    const chamadas = registro.leituraDosNegocios();
    const selecao = String(argDe(chamadas, "select")[0]?.[0] ?? "");

    // Forma da consulta: organização da sessão (a do funil que a RLS liberou) e
    // o funil pedido. Sem o primeiro, o índice não serve para nada.
    expect(argDe(chamadas, "eq")).toContainEqual(["organization_id", ORG_ID]);
    expect(argDe(chamadas, "eq")).toContainEqual(["pipeline_id", PIPE]);
    expect(argDe(chamadas, "neq")).toContainEqual(["status", "archived"]);

    // Nada de `select("*")`: a lista é a do contrato do quadro.
    expect(selecao).not.toContain("*");
    for (const coluna of [
      "id",
      "organization_id",
      "pipeline_id",
      "stage_id",
      "position_in_stage",
      "status",
      "closed_at",
      "custom_fields",
      "tags",
    ]) {
      expect(selecao).toContain(coluna);
    }

    // A ordem do quadro e a prova do fim vêm do mesmo builder.
    const ordem = argDe(chamadas, "order").map((a) => a[0]);
    expect(ordem).toEqual(["position_in_stage", "id"]);
    expect(argDe(chamadas, "range")[0]).toEqual([0, 999]);
    // A primeira página pede o `count` exato: é ele que prova onde o quadro acaba.
    expect(argDe(chamadas, "select")[0]?.[1]).toEqual({ count: "exact" });
  });

  it("⭐ (b) 1.200 negócios voltam TODOS, na ordem position_in_stage, id", async () => {
    // Posições repetidas de propósito: o desempate por `id` é o que torna a
    // página seguinte determinística (sem ele, dois cards empatados podem
    // trocar de página entre leituras e um some).
    const linhas = Array.from({ length: 1200 }, (_, i) =>
      linhaCompleta(`n${String(i).padStart(4, "0")}`, (i % 37) * 10),
    );
    banco({ leads: linhas, maxRows: 1000 });

    const { status, corpo } = await lerQuadro();
    expect(status).toBe(200);

    const leads = corpo.data?.leads ?? [];
    const esperado = [...linhas]
      .sort(
        (a, b) =>
          a.position_in_stage - b.position_in_stage ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((l) => l.id);

    // O corte silencioso de 1.000 é exatamente o defeito: 200 negócios sumiam.
    expect(leads).toHaveLength(1200);
    expect(leads.map((l) => l.id)).toEqual(esperado);
    expect(corpo.data?.truncado).toBeUndefined();
  });

  it("⭐ (c) o funil pequeno responde EXATAMENTE o que respondia antes", async () => {
    const linhas = Array.from({ length: 10 }, (_, i) => linhaCompleta(`n${i}`, (i + 1) * 10));
    banco({ leads: linhas });

    const { status, corpo, headers } = await lerQuadro();
    expect(status).toBe(200);

    // O contrato de cima não muda: as três chaves de sempre, e mais nada.
    expect(Object.keys(corpo.data ?? {})).toEqual(["pipeline", "stages", "leads"]);
    expect(corpo.data?.pipeline?.id).toBe(PIPE);
    expect(corpo.data?.stages).toEqual([etapa({ id: "e1", name: "Novo", position: 1000 })]);
    expect(corpo.data?.leads).toEqual(linhas);
    // Sem aviso nenhum quando o fim foi provado — o corpo é o de sempre.
    expect(headers.get("X-Quadro-Truncado")).toBeNull();
  });

  it("⭐ (d) fim que não dá para provar AVISA em vez de silêncio", async () => {
    // 5.200 > 5 páginas × 1.000: o laço esgota o teto sem alcançar o `count`.
    // O dublê devolve `count` exato e corta cada página em `maxRows`, como o
    // PostgREST — é o mesmo cenário do funil grande de verdade.
    const linhas = Array.from({ length: 5200 }, (_, i) =>
      linhaCompleta(`n${String(i).padStart(4, "0")}`, i),
    );
    banco({ leads: linhas, maxRows: 1000 });

    const { status, corpo, headers } = await lerQuadro();
    expect(status).toBe(200);

    // O que veio é honesto sobre si mesmo: um recorte, não o funil inteiro.
    expect(corpo.data?.truncado).toBe(true);
    expect(headers.get("X-Quadro-Truncado")).toBe("1");
    expect(corpo.data?.leads).toHaveLength(5000);
  });

  it("⭐ (e) negócio de OUTRA organização não aparece no quadro", async () => {
    banco({
      leads: [
        linhaCompleta("da-casa-1", 10),
        linhaCompleta("da-casa-2", 20),
        linhaCompleta("de-fora", 30, { organization_id: OUTRA_ORG }),
      ],
    });

    const { status, corpo } = await lerQuadro();
    expect(status).toBe(200);

    const ids = (corpo.data?.leads ?? []).map((l) => l.id);
    expect(ids).toEqual(["da-casa-1", "da-casa-2"]);
    expect(ids).not.toContain("de-fora");
  });
});
