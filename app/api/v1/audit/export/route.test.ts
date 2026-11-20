/**
 * GET /api/v1/audit/export — o CSV lê as 10.000 prometidas, não 1.000 caladas (#2561).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `supabase/config.toml` tem `max_rows = 1000`: o PostgREST corta toda resposta
 * nesse teto SEM erro. O `.limit(10_000)` devolvia 1.000 linhas, e o CSV saía
 * com um décimo do que o próprio cabeçalho do arquivo promete ("up to 10k
 * rows") — sem aviso nenhum.
 *
 * ⚠️ O DUBLÊ IMPÕE O TETO EM TODA RESPOSTA (`MAX_ROWS`), como o servidor faz, e
 * registra as PÁGINAS (`range`) e a ordem. Um dublê que devolvesse as 2.500
 * linhas inteiras de um `.limit(10_000)` passaria nos dois mundos.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_A = "11111111-1111-4111-8111-111111111111";
const ACTOR_B = "33333333-3333-4333-8333-333333333333";
const URL_BASE = "http://localhost/api/v1/audit/export";

/** `max_rows = 1000` do PostgREST. */
const MAX_ROWS = 1000;
const TETO_DO_EXPORT = 10_000;

type Linha = Record<string, unknown>;

interface Consulta {
  tabela: string;
  filtros: Array<[string, unknown]>;
  ordens: string[];
  faixas: Array<[number, number]>;
  contou: boolean;
}

function fakeSupabase(
  dados: Record<string, Linha[]>,
  maxRows = MAX_ROWS,
  aposPrimeiraPagina?: () => void,
) {
  const consultas: Consulta[] = [];
  let paginasLidas = 0;

  const client = {
    from(tabela: string) {
      const registro: Consulta = { tabela, filtros: [], ordens: [], faixas: [], contou: false };
      consultas.push(registro);

      const filtros: Array<(linha: Linha) => boolean> = [];
      const ordens: Array<{ coluna: string; asc: boolean }> = [];
      let pediuCount = false;

      const executar = (faixa: [number, number] | null) => {
        const base = (dados[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        base.sort((a, b) => {
          for (const ordem of ordens) {
            const av = String(a[ordem.coluna]);
            const bv = String(b[ordem.coluna]);
            if (av === bv) continue;
            return (av < bv ? -1 : 1) * (ordem.asc ? 1 : -1);
          }
          return 0;
        });
        const fatia = faixa ? base.slice(faixa[0], faixa[1] + 1) : base;
        const resposta = {
          data: fatia.slice(0, maxRows),
          count: pediuCount ? base.length : null,
          error: null,
        } as const;
        paginasLidas++;
        if (paginasLidas === 1) aposPrimeiraPagina?.();
        return resposta;
      };

      const builder: Record<string, unknown> = {};
      builder.select = (_colunas: string, opcoes?: { count?: string }) => {
        pediuCount = opcoes?.count === "exact";
        registro.contou = pediuCount;
        return builder;
      };
      builder.eq = (coluna: string, valor: unknown) => {
        registro.filtros.push([coluna, valor]);
        filtros.push((l) => !(coluna in l) || l[coluna] === valor);
        return builder;
      };
      builder.ilike = (coluna: string, padrao: string) => {
        registro.filtros.push([`${coluna} ilike`, padrao]);
        const alvo = padrao.replace(/%/g, "").toLowerCase();
        filtros.push((l) => String(l[coluna] ?? "").toLowerCase().includes(alvo));
        return builder;
      };
      builder.gte = (coluna: string, valor: unknown) => {
        registro.filtros.push([`${coluna} >=`, valor]);
        filtros.push((l) => l[coluna] !== null && l[coluna] !== undefined && String(l[coluna]) >= String(valor));
        return builder;
      };
      builder.lte = (coluna: string, valor: unknown) => {
        registro.filtros.push([`${coluna} <=`, valor]);
        filtros.push((l) => l[coluna] !== null && l[coluna] !== undefined && String(l[coluna]) <= String(valor));
        return builder;
      };
      builder.or = (expressao: string) => {
        const chave = /^(\w+)\.lt\.(.+),and\(\1\.eq\.\2,(\w+)\.lt\.(.+)\)$/.exec(expressao);
        if (!chave) throw new Error(`Filtro não implementado no dublê: ${expressao}`);
        const [, coluna, valor, desempate, id] = chave;
        filtros.push((linha) =>
          String(linha[coluna!]) < valor! ||
          (String(linha[coluna!]) === valor && String(linha[desempate!]) < id!),
        );
        return builder;
      };
      builder.order = (coluna: string, opcoes: { ascending: boolean }) => {
        registro.ordens.push(coluna);
        ordens.push({ coluna, asc: opcoes.ascending });
        return builder;
      };
      builder.range = (inicio: number, fim: number) => {
        registro.faixas.push([inicio, fim]);
        return Promise.resolve(executar([inicio, fim]));
      };
      // O caminho de quem NÃO paginou (e o da sabotagem): também cortado.
      builder.limit = (n: number) => {
        const resposta = executar(null);
        return Promise.resolve({ ...resposta, data: (resposta.data ?? []).slice(0, Math.min(n, maxRows)) });
      };
      return builder;
    },
  };
  return { consultas, client };
}

function auditoria(i: number, parcial: Linha = {}): Linha {
  const n = String(i).padStart(6, "0");
  return {
    id: `aud-${n}`,
    created_at: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString(),
    actor_user_id: ACTOR_A,
    action: "contact.created",
    resource_type: "contact",
    resource_id: null,
    request_id: null,
    actor_ip: null,
    metadata: { n },
    ...parcial,
  };
}

function usuario(): AuthUser {
  return {
    id: ACTOR_A,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  } as AuthUser;
}

async function chamar(url = URL_BASE): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new NextRequest(url));
}

/** Linhas de DADOS do CSV (fora o cabeçalho). */
function dadosDoCsv(csv: string): string[] {
  const linhas = csv.trimEnd().split("\n");
  return linhas.slice(1);
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: usuario(),
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  } as never);
});

describe("célula que a planilha leria como fórmula", () => {
  it("texto dentro do metadata que vira célula no Excel pt-BR sai com aspa; o JSON segue legível", async () => {
    const linhas = [auditoria(1, { metadata: { nome: "x;=1+1", v: [1, -2] } })];
    const { client } = fakeSupabase({ api_audit_log: linhas });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const csv = await (await chamar()).text();
    const [linha] = dadosDoCsv(csv);

    expect(linha).toContain(`""x;'=1+1""`);
    expect(linha).toContain("[1,-2]");
  });
});

describe("o CSV de auditoria lê além de 1.000", () => {
  it("um evento novo entre páginas não repete uma linha nem exclui a mais antiga", async () => {
    const linhas = Array.from({ length: 2000 }, (_, k) => auditoria(k + 1));
    const esperados = linhas.map((linha) => linha.id).reverse();
    const { client } = fakeSupabase(
      { api_audit_log: linhas },
      MAX_ROWS,
      () => linhas.push(auditoria(2001)),
    );
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    const ids = dadosDoCsv(await res.text()).map((linha) => linha.split(",")[0]);

    expect(res.status).toBe(200);
    expect(ids).toHaveLength(2000);
    expect(new Set(ids).size).toBe(2000);
    expect(ids).toEqual(esperados);
  });

  it("o desempate por ID conserva todos os eventos com a mesma data", async () => {
    const linhas = Array.from({ length: 1500 }, (_, k) =>
      auditoria(k + 1, { created_at: "2026-11-12T10:00:00.000Z" }),
    );
    const { client } = fakeSupabase({ api_audit_log: linhas });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const ids = dadosDoCsv(await (await chamar()).text()).map((linha) => linha.split(",")[0]);

    expect(ids).toEqual(linhas.map((linha) => linha.id).reverse());
  });

  it("⭐ 2.500 registros saem inteiros (antes: 1.000 calados)", async () => {
    const linhas = Array.from({ length: 2500 }, (_, k) => auditoria(k + 1));
    const { consultas, client } = fakeSupabase({ api_audit_log: linhas });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    const csv = await res.text();

    expect(res.status).toBe(200);
    expect(dadosDoCsv(csv), "o arquivo saiu com um décimo do que o cabeçalho promete").toHaveLength(2500);
    const audit = consultas.filter((c) => c.tabela === "api_audit_log");
    expect(audit[0]!.ordens, "ordem estável: created_at e id").toEqual(["created_at", "id"]);
    expect(audit.flatMap((c) => c.faixas)).toEqual([
      [0, 999],
      [0, 999],
      [0, 999],
    ]);
    expect(audit[0]!.contou).toBe(true);
  });

  it("o teto de 10.000 continua respeitado (a leitura para lá dele)", async () => {
    const linhas = Array.from({ length: 15_000 }, (_, k) => auditoria(k + 1));
    const { client } = fakeSupabase({ api_audit_log: linhas });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const csv = await (await chamar()).text();

    expect(dadosDoCsv(csv)).toHaveLength(TETO_DO_EXPORT);
  });

  it("os filtros sobrevivem à paginação: `actor_id` traz só o ator, com mais de 1.000 linhas", async () => {
    const linhas = [
      ...Array.from({ length: 1300 }, (_, k) => auditoria(k + 1, { actor_user_id: ACTOR_A })),
      ...Array.from({ length: 1400 }, (_, k) => auditoria(10_000 + k, { actor_user_id: ACTOR_B })),
    ];
    const { client } = fakeSupabase({ api_audit_log: linhas });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const csv = await (await chamar(`${URL_BASE}?actor_id=${ACTOR_A}`)).text();

    const dados = dadosDoCsv(csv);
    expect(dados).toHaveLength(1300);
    expect(dados.every((linha) => linha.includes(ACTOR_A))).toBe(true);
    expect(dados.some((linha) => linha.includes(ACTOR_B))).toBe(false);
  });

  it("instalação com `max_rows` MENOR que a página: página curta não vira fim, e o teto fica em 10.000 exatos", async () => {
    const linhas = Array.from({ length: 15_000 }, (_, k) => auditoria(k + 1));
    const { client } = fakeSupabase({ api_audit_log: linhas }, 300);
    vi.mocked(createClient).mockResolvedValue(client as never);

    const csv = await (await chamar()).text();

    expect(dadosDoCsv(csv)).toHaveLength(TETO_DO_EXPORT);
  });
});
