/**
 * O `add_tag` ATÔMICO NO SCHEMA — migration, apêndice do baseline e a ação que
 * a usa (issue #2888).
 *
 * Cerca estrutural (só lê o repositório): o self-host aplica SÓ o
 * `supabase/baseline.sql`, e a migration é a fonte da verdade para quem usa o
 * Supabase CLI. Divergir significa que cada público recebe um produto diferente
 * — e nenhum gate vê, porque `test:db` só aplica o baseline. Aqui o que se
 * prende são as DUAS funções de junção nos DOIS artefatos, e a ordem dentro do
 * arquivo: função NOVA em `public` nasce exposta, e a varredura da 0116 é quem
 * cura isso — ela tem de vir DEPOIS do bloco.
 *
 * ─── As cinco coisas medidas ───
 *
 *   1. a migration existe, se descreve (`-- manifest:`) e traz as duas funções;
 *   2. a junção está DENTRO do `UPDATE` (`tags || array(select unnest(...)
 *      except select unnest(tags))`) com `RETURNING tags` — que é o que faz a
 *      segunda transação recalcular sobre a linha vigente em vez de sobrescrever
 *      com uma foto antiga;
 *   3. `security definer` com `EXECUTE` só para `service_role`, `revoke` de
 *      `public`/`anon`/`authenticated` (o default privileges do corpo do baseline
 *      e o grant a PUBLIC do Postgres são DUAS origens — revogar uma só deixaria
 *      uma função que ESCREVE executável por qualquer usuário logado);
 *   4. o CORPO da migration aparece IDÊNTICO no `baseline.sql` — o espelho que o
 *      `install.sh`/`update.sh` aplica;
 *   5. o bloco está ANTES da VARREDURA anon (0116): depois dela, uma função nova
 *      nasceria exposta e sem quem cure.
 *
 * A corrida em si (dois eventos concorrentes de verdade) é medida contra o
 * Postgres em `tests/invariants/add-tag-concorrente-nao-apaga.test.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const MIGRATION = "supabase/migrations/20261019000001_0682_add_tag_atomico_entre_eventos.sql";
const CABECALHO = "-- ---- o add_tag junta no UPDATE, sob a trava da linha (migration 0682, #2888) ----";
const VARREDURA = "-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----";

const lerMigration = () => readFileSync(join(RAIZ, MIGRATION), "utf8");
const lerBaseline = () => readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

describe("o add_tag atômico (#2888) no schema", () => {
  it("controle: a migration existe e não está vazia", () => {
    expect(existsSync(join(RAIZ, MIGRATION))).toBe(true);
    expect(lerMigration().length).toBeGreaterThan(2000);
  });

  it("⭐ as DUAS funções de junção nascem na migration, uma por tabela", () => {
    const sql = lerMigration();
    expect(sql).toMatch(/-- manifest: \S/);
    for (const assinatura of [
      "create or replace function public.fn_lead_adicionar_etiquetas(\n  p_org uuid,\n  p_lead uuid,\n  p_etiquetas text[]\n)",
      "create or replace function public.fn_contato_adicionar_etiquetas(\n  p_org uuid,\n  p_contato uuid,\n  p_etiquetas text[]\n)",
    ]) {
      expect(sql).toContain(assinatura);
    }
  });

  it("⭐ a junção é DENTRO do UPDATE, com RETURNING — não uma lista montada fora", () => {
    const sql = lerMigration();
    // A instrução que decide: duas ocorrências (uma por tabela).
    expect(sql.match(/set tags = coalesce\(tags, '\{\}'::text\[\]\)\n\s*\|\| array\(select unnest\(p_etiquetas\) except select unnest\(coalesce\(tags, '\{\}'::text\[\]\)\)\),/g)).toHaveLength(2);
    expect(sql.match(/returning tags into v_depois;/g)).toHaveLength(2);
    // E os dois ramos de escrita batem no filtro de organização da própria linha.
    expect(sql.match(/where organization_id = p_org and id = p_(lead|contato)\n\s*returning tags/g)).toHaveLength(2);
  });

  it("⭐ EXECUTE só para service_role, e revogado de public/anon/authenticated", () => {
    const sql = lerMigration();
    // Uma linha `security definer` por cabeçalho de função — o texto do
    // `-- manifest:` também cita a expressão, e não conta como definição.
    expect(sql.match(/^security definer$/gm)).toHaveLength(2);
    expect(sql).toContain("from public, anon, authenticated;");
    for (const f of ["fn_lead_adicionar_etiquetas", "fn_contato_adicionar_etiquetas"]) {
      expect(sql).toContain(`revoke all on function public.${f}(uuid, uuid, text[]) from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${f}(uuid, uuid, text[]) to service_role;`);
    }
  });

  it("⭐ o apêndice do baseline espelha a migration, sem uma única diferença", () => {
    const migration = lerMigration();
    const baseline = lerBaseline();

    // O baseline recebe o corpo a partir do cabeçalho `-- ---- ... (migration
    // NNNN) ----` (a convenção que a 0659 e as vizinhas seguem): o `-- manifest:`
    // fica de fora. O que tem de valer é o corpo inteiro, sem diferença.
    const corpo = migration.slice(migration.indexOf(CABECALHO));
    expect(corpo.length).toBeGreaterThan(2000);
    expect(
      baseline.includes(corpo),
      "o corpo da migration não aparece inteiro no baseline — o self-host aplica só o baseline e ficaria sem a junção atômica",
    ).toBe(true);
    // Uma vez só: cópia dupla significaria bloco velho esquecido no arquivo.
    expect(baseline.split(corpo)).toHaveLength(2);
  });

  it("⭐ o bloco vem ANTES da varredura anon — função nova nasce exposta", () => {
    const baseline = lerBaseline();
    const bloco = baseline.indexOf(CABECALHO);
    const varredura = baseline.indexOf(VARREDURA);
    expect(bloco).toBeGreaterThan(-1);
    expect(varredura).toBeGreaterThan(-1);
    expect(bloco).toBeLessThan(varredura);
  });

  it("⭐ a ação usa as duas funções — e não grava mais uma lista montada no app", () => {
    const acao = readFileSync(join(RAIZ, "lib", "automation", "actions", "add-tag.ts"), "utf8");
    expect(acao).toContain('"fn_lead_adicionar_etiquetas"');
    expect(acao).toContain('"fn_contato_adicionar_etiquetas"');
    // O que a #2888 tirou de lá: a releitura + o `update({ tags: ... })` do
    // PostgREST, que mandava um valor pronto calculado a partir da leitura.
    expect(acao).not.toMatch(/\.from\([^)]*\)\s*\n?\s*\.update\(\{\s*tags/);
  });
});
