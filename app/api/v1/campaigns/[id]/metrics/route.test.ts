/**
 * Resgate da regressão apontada por @Draven9 em 78664086f / a01ad94e8 (#3571).
 * O client PostgREST é real; só o transporte é uma bancada em memória, que
 * aplica filtros, ordem, cursor e max_rows a cada consulta. Não prova banco.
 */
import { createClient as criarSupabase } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import type { ContagemDaCampanha } from "@/lib/campanhas/metricas";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const CAMPANHA = "33333333-3333-4333-8333-333333333333";
const OUTRA_ORG = "44444444-4444-4444-8444-444444444444";
const OUTRA_CAMPANHA = "55555555-5555-4555-8555-555555555555";
const CARIMBO = "2026-10-20T12:00:00.000Z";

function destinatario(i: number) {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    organization_id: ORG,
    campaign_id: CAMPANHA,
    status: "pending",
    eligibility_status: "eligible",
    sent_at: null as string | null,
    delivered_at: null as string | null,
    read_at: null as string | null,
    replied_at: null as string | null,
    opted_out_at: null as string | null,
  };
}
type Linha = ReturnType<typeof destinatario>;
const lista = (n: number) => Array.from({ length: n }, (_, i) => destinatario(i + 1));

function bancada(
  linhas: Linha[],
  opcoes: {
    maxRows?: number;
    erroNaPagina?: number;
    campanhaExiste?: boolean;
    antesDaPagina?: (numero: number, linhas: Linha[]) => void;
  } = {},
) {
  const consultas: URL[] = [];
  const idsLidos: string[] = [];
  let pagina = 0;
  const transporte: typeof fetch = async (input) => {
    const url = new URL(String(input));
    consultas.push(url);
    const tabela = url.pathname.split("/").at(-1);
    let dados: Array<Record<string, unknown>>;
    if (tabela === "campaign_recipients") {
      pagina++;
      opcoes.antesDaPagina?.(pagina, linhas);
      if (pagina === opcoes.erroNaPagina) {
        return Response.json({ message: "falha na página", code: "XX000" }, { status: 500 });
      }
      dados = linhas;
    } else {
      expect(tabela).toBe("campaigns");
      dados = opcoes.campanhaExiste === false ? [] : [{ id: CAMPANHA, organization_id: ORG }];
    }
    for (const [coluna, filtro] of url.searchParams) {
      if (filtro.startsWith("eq.")) dados = dados.filter((l) => l[coluna] === filtro.slice(3));
      if (filtro.startsWith("gt."))
        dados = dados.filter((l) => String(l[coluna]) > filtro.slice(3));
    }
    const ordem = url.searchParams.get("order");
    if (ordem) {
      expect(ordem).toBe("id.asc");
      dados = [...dados].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }
    const inicio = Number(url.searchParams.get("offset") ?? 0);
    const limite = Math.min(
      Number(url.searchParams.get("limit") ?? Infinity),
      opcoes.maxRows ?? 1000,
    );
    const recebidos = dados.slice(inicio, inicio + limite);
    if (tabela === "campaign_recipients") idsLidos.push(...recebidos.map((l) => String(l.id)));
    const colunas = url.searchParams
      .get("select")!
      .split(",")
      .map((c) => c.trim());
    // Sem Content-Range/count: a ausência dele não pode significar zero/fim.
    return Response.json(recebidos.map((l) => Object.fromEntries(colunas.map((c) => [c, l[c]]))));
  };
  const client = criarSupabase("http://postgrest.invalid", "chave-sintetica", {
    global: { fetch: transporte },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  vi.mocked(createClient).mockResolvedValue(client as never);
  return { consultas, idsLidos };
}

async function chamar() {
  return GET(new NextRequest(`http://localhost/api/v1/campaigns/${CAMPANHA}/metrics`), {
    params: Promise.resolve({ id: CAMPANHA }),
  });
}

async function metricas() {
  const res = await chamar();
  expect(res.status).toBe(200);
  expect(res.headers.get("x-request-id")).toBeTruthy();
  return (await res.json()).data as {
    contagem: ContagemDaCampanha;
    parcial: boolean;
    progresso: number;
    taxas: Record<string, number | null>;
  };
}

describe("métricas da campanha acima de max_rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" } as AuthUser,
      org: { orgId: ORG, name: "Org", role: "manager" },
    } as never);
  });

  it.each([1000, 137])("conta 1.485 linhas com max_rows=%i, sem count", async (maxRows) => {
    const linhas = lista(1485);
    linhas.forEach((l, i) => {
      if (i < 225) Object.assign(l, { status: "sent", sent_at: CARIMBO });
      else if (i < 262) l.status = "failed";
    });
    const { consultas, idsLidos } = bancada(linhas.reverse(), { maxRows });
    const m = await metricas();
    expect(m.contagem).toMatchObject({
      total: 1485,
      elegiveis: 1485,
      enviados: 225,
      falharam: 37,
      pendentes: 1223,
    });
    expect(m.parcial).toBe(false);
    expect(idsLidos).toEqual(lista(1485).map((l) => l.id));
    expect(consultas).toHaveLength(Math.ceil(1485 / maxRows) + 1);
  });

  it.each([19_999, 20_000, 20_001])("teto de 20.000 com %i linhas", async (n) => {
    const { consultas, idsLidos } = bancada(lista(n));
    const m = await metricas();
    expect(m.contagem.total).toBe(Math.min(n, 20_000));
    expect(m.contagem.pendentes).toBe(Math.min(n, 20_000));
    expect(m.parcial).toBe(n > 20_000);
    expect(new Set(idsLidos).size).toBe(idsLidos.length);
    expect(consultas).toHaveLength(21);
    if (n >= 20_000) expect(consultas.at(-1)!.searchParams.get("limit")).toBe("1");
  });

  it("limita a última página e a sonda mesmo com max_rows menor que 1.000", async () => {
    const { consultas } = bancada(lista(20_001), { maxRows: 137 });
    const m = await metricas();
    expect(m.contagem.total).toBe(20_000);
    expect(m.parcial).toBe(true);
    expect(consultas.at(-2)!.searchParams.get("limit")).toBe("135");
    expect(consultas.at(-1)!.searchParams.get("limit")).toBe("1");
  });

  it("mantém o guard e não consulta dados quando negado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "Acesso negado.", 403),
    });
    expect((await chamar()).status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
    expect(requireRole).toHaveBeenCalledWith("manager", {
      requestId: expect.any(String),
      resource: "campaigns",
    });
  });

  it("filtra organização e campanha em todas as páginas e na sonda", async () => {
    const linhas = lista(20_001);
    linhas.push({ ...destinatario(30_001), organization_id: OUTRA_ORG });
    linhas.push({ ...destinatario(30_002), campaign_id: OUTRA_CAMPANHA });
    const { consultas } = bancada(linhas);
    expect((await metricas()).contagem.total).toBe(20_000);
    for (const url of consultas) {
      expect(url.searchParams.get("organization_id")).toBe(`eq.${ORG}`);
      expect(url.searchParams.get("campaign_id")).toBe(`eq.${CAMPANHA}`);
      expect(url.searchParams.get("order")).toBe("id.asc");
    }
  });

  it("não conta destinatários de outra organização ou campanha", async () => {
    bancada(
      [
        destinatario(1),
        { ...destinatario(2), organization_id: OUTRA_ORG, status: "failed" },
        { ...destinatario(3), campaign_id: OUTRA_CAMPANHA, sent_at: CARIMBO },
      ],
      { maxRows: 1 },
    );
    expect((await metricas()).contagem).toMatchObject({
      total: 1,
      pendentes: 1,
      enviados: 0,
      falharam: 0,
    });
  });

  it.each([2, 21])(
    "falha na página/sonda %i devolve erro, sem publicar contagem incompleta",
    async (erroNaPagina) => {
      bancada(lista(20_001), { erroNaPagina });
      const res = await chamar();
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({
        error: { code: "internal_error", message: "falha na página" },
      });
    },
  );

  it.each([true, false])(
    "campanha vazia existente=%s preserva consulta tenant-scoped e 404",
    async (campanhaExiste) => {
      const { consultas } = bancada([], { campanhaExiste });
      const res = await chamar();
      expect(res.status).toBe(campanhaExiste ? 200 : 404);
      const consulta = consultas.at(-1)!;
      expect(consulta.pathname).toContain("/campaigns");
      expect(consulta.searchParams.get("organization_id")).toBe(`eq.${ORG}`);
      expect(consulta.searchParams.get("id")).toBe(`eq.${CAMPANHA}`);
      if (campanhaExiste)
        expect((await res.json()).data).toMatchObject({
          contagem: { total: 0 },
          parcial: false,
          progresso: 0,
        });
      else expect((await res.json()).error.code).toBe("campanha_nao_encontrada");
    },
  );

  it("continua contando carimbos cumulativos e estados em páginas diferentes", async () => {
    const linhas = lista(8);
    linhas[0]!.status = "queued";
    linhas[1]!.status = "sending";
    Object.assign(linhas[2]!, {
      status: "replied",
      sent_at: CARIMBO,
      delivered_at: CARIMBO,
      read_at: CARIMBO,
      replied_at: CARIMBO,
    });
    Object.assign(linhas[3]!, { status: "excluded", eligibility_status: "excluded" });
    linhas[4]!.status = "failed";
    linhas[5]!.status = "cancelled";
    linhas[6]!.opted_out_at = CARIMBO;
    bancada(linhas, { maxRows: 2 });
    const m = await metricas();
    expect(m.contagem).toEqual({
      total: 8,
      elegiveis: 7,
      excluidos: 1,
      pendentes: 2,
      naFila: 1,
      enviando: 1,
      enviados: 1,
      entregues: 1,
      lidos: 1,
      responderam: 1,
      falharam: 1,
      cancelados: 1,
      optOut: 1,
    });
    expect(m.taxas).toEqual({ entrega: 1, leitura: 1, resposta: 1, falha: 0.5, optOut: 1 });
    expect(m.progresso).toBe(2 / 7);
  });

  it("exclusão antes do cursor não desloca nem pula o próximo destinatário", async () => {
    const { idsLidos } = bancada(lista(5), {
      maxRows: 2,
      antesDaPagina: (n, linhas) => {
        if (n === 2) linhas.shift();
      },
    });
    expect((await metricas()).contagem.total).toBe(5);
    expect(idsLidos).toEqual(lista(5).map((l) => l.id));
    // Leitura viva: inclui a linha observada antes da exclusão; não é snapshot.
  });

  it("inserção posterior ao cursor é observada sem confiar no total inicial", async () => {
    const { idsLidos } = bancada(lista(4), {
      maxRows: 2,
      antesDaPagina: (n, linhas) => {
        if (n === 2) linhas.push(destinatario(5));
      },
    });
    expect((await metricas()).contagem.total).toBe(5);
    expect(idsLidos).toEqual(lista(5).map((l) => l.id));
  });
});
