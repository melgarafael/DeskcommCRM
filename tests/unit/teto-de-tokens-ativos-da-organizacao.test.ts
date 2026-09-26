/**
 * A TRAVA ESTÁ NOS TRÊS ARTEFATOS, COM O MESMO CORPO — E O EMISSOR A ENXERGA.
 *
 * Doutrina de migrations do repo: toda mudança de schema sai em migration
 * versionada + apêndice idempotente do `baseline.sql` + linha no MANIFEST, e os
 * dois primeiros têm de dizer a MESMA coisa (é o que
 * `apendice-do-baseline-nao-diverge-da-cadeia` cobra para função existente;
 * aqui a função é NOVA, então a cópia é a minha de ponta a ponta).
 *
 * O que este arquivo garante, em ordem:
 *   1. a tripla existe (migration, apêndice, MANIFEST) e o corpo é igual;
 *   2. o predicado conta só o que está VIVO — sem `revoked_at` e não expirado —
 *      que é o que deixa a rotação legítima passar (revogar e emitir de novo);
 *   3. a comparação é `>=` no teto: com `>` o teto+1 passaria, e a issue é
 *      justamente sobre o primeiro token A MAIS;
 *   4. o erro é mensagem própria (SQLSTATE `PT409`) que diz o limite e manda
 *      revogar, e a rota devolve esse texto em 409 — não um 500 genérico;
 *   5. o limite mora SÓ no banco: nem a rota nem o catálogo de erros carregam
 *      uma cópia do número nem da frase (cópia é a segunda fonte que um gate
 *      teria de reconciliar depois).
 *
 * Os três casos de comportamento (dentro do teto passa, no teto+1 recusa,
 * revogado libera) são de POSTGRES REAL e estão em
 * `tests/invariants/teto-de-tokens-ativos-da-organizacao.test.ts` — gatilho não
 * se testa com dublê. A tradução da recusa no emissor está em
 * `tests/api/emitir-token-respeita-o-teto-da-organizacao.test.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRACAO = "supabase/migrations/20260925180000_0415_teto_de_tokens_ativos_por_organizacao.sql";
const ler = (caminho: string): string => readFileSync(join(process.cwd(), caminho), "utf8");

const migration = ler(MIGRACAO);
const baseline = ler("supabase/baseline.sql");
const manifest = ler("supabase/migrations/MANIFEST.md");
const rota = ler("app/api/v1/settings/api-tokens/route.ts");
const catalogo = ler("lib/api/errors.ts");

/** O corpo da função, como o Postgres executa — comentários e espaços fora. */
function corpoDaFuncao(texto: string): string {
  const inicio = texto.indexOf("create or replace function public.fn_teto_de_tokens_ativos()");
  if (inicio === -1) return "";
  const marca = /\$[a-z_]*\$/i.exec(texto.slice(inicio, inicio + 600));
  if (!marca) return "";
  const fim = texto.indexOf(marca[0], inicio + marca.index + marca[0].length);
  if (fim === -1) return "";
  return texto
    .slice(inicio, fim + marca[0].length)
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

function tetoDe(corpo: string): number {
  const batida = /v_teto\s+constant integer :=\s*(\d+)/.exec(corpo);
  if (!batida) throw new Error("v_teto não encontrada no corpo da função");
  return Number(batida[1]);
}

const corpoMigration = corpoDaFuncao(migration);
const corpoBaseline = corpoDaFuncao(baseline);
const apendice = baseline.indexOf(
  "-- ---- teto de tokens ativos por organização (migration 0415, issue #1448) ----",
);
const varredura = baseline.indexOf(
  "-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----",
);
/** O bloco inteiro do apêndice: função + revoke + trigger (fora do `$$`). */
const bloco = apendice > -1 && varredura > apendice ? baseline.slice(apendice, varredura) : "";

describe("teto de tokens ativos por organização (0415 / issue #1448)", () => {
  it("a tripla existe: migration versionada, apêndice no baseline e linha no MANIFEST", () => {
    expect(existsSync(join(process.cwd(), MIGRACAO))).toBe(true);
    expect(apendice, "apêndice da 0415 ausente do baseline.sql").toBeGreaterThan(-1);
    expect(manifest).toMatch(/\| `20260925180000` \| `0415_teto_de_tokens_ativos_por_organizacao` \|/);
  });

  it("o corpo do apêndice é o MESMO da migration — o self-host e o Supabase CLI não podem divergir", () => {
    expect(corpoMigration.length).toBeGreaterThan(0);
    expect(corpoBaseline).toBe(corpoMigration);
    expect(tetoDe(corpoBaseline)).toBe(tetoDe(corpoMigration));
  });

  it("o apêndice entra ANTES da varredura de anon (a cerca que não deixa função exposta)", () => {
    expect(varredura).toBeGreaterThan(-1);
    expect(apendice).toBeGreaterThan(-1);
    expect(apendice).toBeLessThan(varredura);
  });

  it("a contagem ignora revogados e expirados — é o que faz revogar liberar espaço", () => {
    // Comparação contra o corpo NORMALIZADO (espaços e comentários fora), como
    // o `apendice-do-baseline-nao-diverge-da-cadeia` compara.
    expect(corpoBaseline).toContain("and revoked_at is null");
    expect(corpoBaseline).toContain("expires_at is null or expires_at > now()");
    expect(corpoBaseline).toContain("where organization_id = new.organization_id");
    expect(corpoBaseline).toContain("select count(*)");
  });

  it("a recusa é no teto+1 (`>=`), não um a mais depois dele", () => {
    expect(corpoBaseline).toContain("if v_ativos >= v_teto then");
    expect(corpoBaseline).not.toContain("if v_ativos > v_teto then");
  });

  it("a trava é um trigger BEFORE INSERT, linha a linha, em api_tokens", () => {
    expect(bloco).toContain("create trigger trg_teto_de_tokens_ativos");
    expect(bloco).toContain("before insert on public.api_tokens");
    expect(bloco).toContain("for each row");
    expect(bloco).toContain("execute function public.fn_teto_de_tokens_ativos()");
  });

  it("o erro é mensagem própria em PT409 que DIZ o limite e MANDA revogar", () => {
    expect(corpoBaseline).toContain("using errcode = 'PT409'");
    expect(corpoBaseline).toContain("Teto de tokens ativos por organização atingido: % de %");
    expect(corpoBaseline).toContain("Revogue um token");
    expect(corpoBaseline).toContain("Configurações → Tokens de API → Revogar");
    expect(corpoBaseline).toContain("revogados ou expirados não contam");
  });

  it("a função não é RPC: as duas origens de EXECUTE revogadas (item 9 da doutrina)", () => {
    expect(corpoBaseline).toContain("security definer");
    expect(corpoBaseline).toContain("set search_path = ''");
    expect(baseline).toContain(
      "revoke execute on function public.fn_teto_de_tokens_ativos() from public, anon, authenticated;",
    );
    expect(migration).toContain(
      "revoke execute on function public.fn_teto_de_tokens_ativos() from public, anon, authenticated;",
    );
  });

  it("o emissor reconhece PT409 e devolve 409 com a mensagem do banco, sem cópia do número", () => {
    expect(rota).toContain('if (insErr.code === "PT409")');
    expect(rota).toContain('fail("api_token_teto_atingido", insErr.message, 409');
    // Nenhuma cópia da frase nem do limite na rota: quem sabe o número é o banco.
    expect(rota).not.toContain("Teto de tokens ativos por organização");
    expect(rota).not.toContain(`v_teto`);
  });

  it("o código da recusa está declarado no catálogo de erros (contrato de wire)", () => {
    expect(catalogo).toMatch(/api_token_teto_atingido:\s*"api_token_teto_atingido"/);
  });

  it("o limite está SÓ nos artefatos de schema — nenhum código do produto o repete", () => {
    const teto = tetoDe(corpoMigration);
    expect(teto).toBeGreaterThan(0);
    // O número aparece na migration e no apêndice (que é o mesmo corpo)…
    expect(migration).toContain(`v_teto   constant integer := ${teto}`);
    expect(baseline).toContain(`v_teto   constant integer := ${teto}`);
    // …e em prosa nenhuma do caminho de emissão.
    expect(rota).not.toMatch(/limite de \d+ tokens/i);
    expect(catalogo).not.toMatch(/limite de \d+ tokens/i);
  });
});
