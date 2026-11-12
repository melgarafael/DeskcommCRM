/**
 * CERCA: os eventos do módulo conectado só saem por prova e só por um caminho (Spec 33, F5, tarefa 4).
 *
 * A tabela `extension_module_events` guarda fatos de TODAS as organizações. Quem a lê por fora do banco
 * decide o que um módulo enxerga, então ela só tem uma porta: `lib/extensions/eventos-do-modulo.ts`, que
 * chama as funções do banco (`fn_extensions_events_*`) depois de provar o módulo. Esta varredura quebra quando:
 *
 *  - outro arquivo de código (`app`, `lib`, `components`, `workers`, `scripts`) cita `extension_module_events`
 *    ou `extension_module_cursors`, que não seja o `eventos-do-modulo.ts`;
 *  - a rota `/api/v1/extensions/events` sai de `lib/auth/public-paths.ts` ou entra por padrão que cubra
 *    irmãos (precisa ser o caminho EXATO, como a busca de token);
 *  - algum arquivo desta fase (migrations 9120 e 9121 e o apêndice no baseline) chama `net.http_*`,
 *    `pg_net` ou `http_post/http_get` (gatilho nunca faz HTTP);
 *  - alguma função `fn_extensions_event*` criada nesta fase não tem `revoke execute ... from public, anon,
 *    authenticated`.
 *
 * Lê arquivos, sem banco. A varredura ignora comentários.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const PORTA = "lib/extensions/eventos-do-modulo.ts";
const ROTA = "app/api/v1/extensions/events/route.ts";
const MIGRATIONS = [
  "supabase/migrations/20261105130100_9120_modulo_conectado_eventos.sql",
  "supabase/migrations/20261105220000_9121_modulo_conectado_atraso.sql",
];
const INICIO_DO_APENDICE = "-- ---- modulo conectado: eventos que o módulo busca (migration 9120) ----";
const FIM_DO_APENDICE = "-- Integridade de organização, funil e etapa (9111)";

const PASTAS_DE_CODIGO = ["app", "lib", "components", "workers", "scripts"];
const PASTAS_IGNORADAS = new Set(["node_modules", ".next", ".git", ".claude", "coverage", "dist", "build"]);

function arquivos(pasta: string, saida: string[] = []): string[] {
  let entradas;
  try {
    entradas = readdirSync(pasta, { withFileTypes: true });
  } catch {
    return saida;
  }
  for (const d of entradas) {
    if (d.isDirectory()) {
      if (!PASTAS_IGNORADAS.has(d.name)) arquivos(join(pasta, d.name), saida);
    } else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(d.name)) {
      saida.push(join(pasta, d.name));
    }
  }
  return saida;
}

const ehTeste = (rel: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || rel.includes("/__tests__/");

function semComentariosTs(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");
}

function semComentariosSql(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

function apendiceDoBaseline(): string {
  const baseline = readFileSync(join(RAIZ, "supabase/baseline.sql"), "utf8");
  const ini = baseline.indexOf(INICIO_DO_APENDICE);
  expect(ini, "o apêndice da 9120 sumiu do baseline").toBeGreaterThan(-1);
  const fim = baseline.indexOf(FIM_DO_APENDICE, ini);
  expect(fim, "o fim do apêndice (migration 9111) não foi achado depois do início").toBeGreaterThan(ini);
  return baseline.slice(ini, fim);
}

function textosDaFase(): { nome: string; sql: string }[] {
  return [
    ...MIGRATIONS.map((m) => ({ nome: m, sql: readFileSync(join(RAIZ, m), "utf8") })),
    { nome: "supabase/baseline.sql (apêndice 9120 e 9121)", sql: apendiceDoBaseline() },
  ];
}

describe("os eventos do módulo só têm uma porta de leitura", () => {
  const codigo = PASTAS_DE_CODIGO.flatMap((p) => arquivos(join(RAIZ, p)))
    .map((abs) => ({ rel: relative(RAIZ, abs).split(sep).join("/"), abs }))
    .filter((a) => !ehTeste(a.rel));

  it("a varredura enxerga a porta e a rota (um conjunto vazio passaria por vacuidade)", () => {
    const rels = codigo.map((a) => a.rel);
    expect(rels).toContain(PORTA);
    expect(rels).toContain(ROTA);
    expect(codigo.length).toBeGreaterThan(500);
  });

  it("nenhum arquivo de código além de eventos-do-modulo.ts cita as tabelas de eventos", () => {
    const fora = codigo
      .filter((a) => a.rel !== PORTA)
      .filter((a) => /extension_module_(events|cursors)/.test(semComentariosTs(readFileSync(a.abs, "utf8"))))
      .map((a) => a.rel);
    expect(
      fora,
      "só lib/extensions/eventos-do-modulo.ts pode tocar as tabelas de eventos; os outros chamam as funções fn_extensions_events_*",
    ).toEqual([]);
  });

  it("a rota não toca as tabelas: chama a porta", () => {
    const rota = semComentariosTs(readFileSync(join(RAIZ, ROTA), "utf8"));
    expect(rota).not.toMatch(/extension_module_(events|cursors)/);
    expect(rota).toContain("lerEventosDoModulo");
  });

  it("a porta chama o banco só pelas funções, nunca por .from() nas tabelas", () => {
    const porta = semComentariosTs(readFileSync(join(RAIZ, PORTA), "utf8"));
    expect(porta).not.toMatch(/\.from\(\s*["'`]extension_module_/);
    expect(porta).toContain("fn_extensions_events_allowed");
    expect(porta).toContain("fn_extensions_events_read");
    expect(porta).toContain("fn_extensions_events_ack");
  });
});

describe("a rota de eventos é pública só pelo caminho exato", () => {
  const publicPaths = readFileSync(join(RAIZ, "lib/auth/public-paths.ts"), "utf8");
  const semProsa = semComentariosTs(publicPaths);

  it("tem a entrada /^\\/api\\/v1\\/extensions\\/events$/", () => {
    expect(semProsa).toContain("/^\\/api\\/v1\\/extensions\\/events$/");
  });

  it("não há padrão mais largo que cubra os irmãos de /api/v1/extensions/", () => {
    const linhas = semProsa.split("\n").filter((l) => l.includes("api\\/v1\\/extensions"));
    for (const l of linhas) {
      const t = l.trim();
      expect(t, `padrão amplo demais: ${t}`).toMatch(/\$\/,?$/);
      expect(t, `padrão com curinga: ${t}`).not.toMatch(/\.\*|\[\^\/\]|\\S|\\w/);
    }
    expect(linhas.length).toBeGreaterThanOrEqual(2); // token e events
  });
});

describe("os gatilhos e as funções desta fase", () => {
  it("a varredura enxerga os três textos (apêndice incluso)", () => {
    const textos = textosDaFase();
    expect(textos).toHaveLength(3);
    for (const t of textos) expect(t.sql.length, t.nome).toBeGreaterThan(200);
    expect(textos.some((t) => /create trigger trg_extensions_evento_/.test(t.sql))).toBe(true);
  });

  it("nenhum deles faz HTTP (net.http_*, pg_net, http_post, http_get)", () => {
    for (const t of textosDaFase()) {
      expect(semComentariosSql(t.sql), t.nome).not.toMatch(/net\.http_|pg_net|http_post|http_get|\bhttp_request\b/i);
    }
  });

  it("toda função fn_extensions_event* criada tem revoke de public, anon e authenticated", () => {
    for (const t of textosDaFase()) {
      const sql = semComentariosSql(t.sql);
      const nomes = [...sql.matchAll(/create or replace function public\.(fn_extensions_event\w*)\s*\(/gi)].map((m) => m[1]!);
      expect(nomes.length, t.nome).toBeGreaterThan(0);
      for (const nome of nomes) {
        const revoke = new RegExp(
          `revoke execute on function public\\.${nome}\\([^)]*\\)\\s+from public, anon, authenticated`,
          "i",
        );
        expect(sql, `${t.nome}: ${nome} sem revoke de public/anon/authenticated`).toMatch(revoke);
      }
    }
  });

  it("as funções de leitura e atraso só dão EXECUTE a service_role", () => {
    for (const t of textosDaFase()) {
      const sql = semComentariosSql(t.sql);
      for (const nome of ["fn_extensions_events_allowed", "fn_extensions_events_read", "fn_extensions_events_ack", "fn_extensions_events_lag"]) {
        if (!new RegExp(`create or replace function public\\.${nome}\\(`, "i").test(sql)) continue;
        expect(sql, `${t.nome}: ${nome}`).toMatch(
          new RegExp(`grant execute on function public\\.${nome}\\([^)]*\\) to service_role`, "i"),
        );
        expect(sql, `${t.nome}: ${nome} dada a anon/authenticated`).not.toMatch(
          new RegExp(`grant execute on function public\\.${nome}\\([^)]*\\) to [^;]*\\b(anon|authenticated|public)\\b`, "i"),
        );
      }
    }
  });
});
