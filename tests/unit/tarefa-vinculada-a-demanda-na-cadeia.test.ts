/**
 * A TAREFA PRESA À DEMANDA NO SCHEMA — migration e apêndice do baseline.
 *
 * Cerca estrutural (só lê o repositório): o self-host aplica SÓ o
 * `supabase/baseline.sql`, e a migration é a fonte da verdade para quem usa o
 * Supabase CLI. Divergir significa que cada público recebe um produto diferente
 * — e nenhum gate vê, porque `test:db` só aplica o baseline. Aqui o que se
 * prende é a COLUNA e o ÍNDICE do vínculo novo (#2818) nos DOIS artefatos, da
 * mesma forma que os dois precisam existir.
 *
 * ─── As três coisas medidas ───
 *
 *   1. a migration existe, se descreve (`-- manifest:`) e traz a coluna
 *      `demanda_id` como FK para `demandas` com `on delete set null` — o MESMO
 *      desfecho do `lead_id` (0210): apagar o assunto não apaga o combinado;
 *   2. o índice parcial `(demanda_id) where demanda_id is not null` — a
 *      consulta da seção do inbox é por demanda, e a maioria das tarefas não
 *      tem uma (índice parcial, não global);
 *   3. o CORPO da migration aparece IDÊNTICO no `baseline.sql` — o espelho que
 *      o `install.sh`/`update.sh` aplica.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const MIGRATION = "supabase/migrations/20261013215540_0659_tarefa_vinculada_a_demanda.sql";

describe("a tarefa vinculada à demanda (#2818) no schema", () => {
  it("controle: a migration existe e não está vazia", () => {
    expect(existsSync(join(RAIZ, MIGRATION))).toBe(true);
    const sql = readFileSync(join(RAIZ, MIGRATION), "utf8");
    expect(sql.length).toBeGreaterThan(500);
  });

  it("⭐ a coluna nova é FK para demandas com on delete set null", () => {
    const sql = readFileSync(join(RAIZ, MIGRATION), "utf8");
    expect(sql).toMatch(/-- manifest: \S/);
    expect(sql).toContain(
      "add column if not exists demanda_id uuid references public.demandas(id) on delete set null",
    );
  });

  it("⭐ o índice parcial das tarefas de UMA demanda existe", () => {
    const sql = readFileSync(join(RAIZ, MIGRATION), "utf8");
    expect(sql).toContain("create index if not exists crm_tasks_demanda_idx");
    expect(sql).toContain("on public.crm_tasks (demanda_id) where demanda_id is not null");
  });

  it("⭐ o apêndice do baseline espelha a migration, sem uma única diferença", () => {
    const migration = readFileSync(join(RAIZ, MIGRATION), "utf8");
    const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

    // O baseline recebe o corpo a partir do cabeçalho `-- ---- ... (migration
    // NNNN) ----` (a convenção que a 0652/0654 seguem): o `-- manifest:` fica de
    // fora. O que tem de valer é o corpo inteiro, presente sem diferença.
    const corpo = migration.slice(migration.indexOf("-- ---- a tarefa nasce presa"));
    expect(corpo.length).toBeGreaterThan(300);
    expect(
      baseline.includes(corpo),
      "o corpo da migration não aparece inteiro no baseline — o self-host aplica só o baseline e ficaria sem a coluna",
    ).toBe(true);
  });

  it("a migration está registrada no baseline pela marca do apêndice", () => {
    const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
    expect(baseline).toContain("(migration 0659, #2818)");
  });
});
