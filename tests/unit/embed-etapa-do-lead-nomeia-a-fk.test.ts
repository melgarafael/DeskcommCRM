/**
 * Desde a 0426 existem DUAS FKs de `crm_leads` para `crm_stages`: `stage_id`
 * (`crm_leads_stage_id_fkey`) e `lost_from_stage_id`
 * (`fk_crm_leads_lost_from_stage`). Com duas, o PostgREST recusa o embed sem
 * dica — `crm_stages(name)` a partir de `crm_leads`, ou `crm_leads(...)` a
 * partir de `crm_stages` — com PGRST201, e a rota inteira responde 500. Foi o
 * que derrubou o painel do contato no Inbox ("Não consegui ler estes dados")
 * no e2e do #1717.
 *
 * Nenhum dublê de banco modela a ambiguidade e o `tsc` não a pega (as rotas
 * fazem cast do resultado), então a vigia é textual: arquivo que consulta uma
 * das tabelas não pode embutir a outra sem nomear a FK
 * (`crm_stages!crm_leads_stage_id_fkey(...)`).
 *
 * ponytail: régua por ARQUIVO, não por cadeia de consulta — um arquivo que lê
 * `crm_leads` e também embute `crm_stages` a partir de `crm_pipelines` (onde não
 * há ambiguidade) reprova em falso; aí nomeie a FK também ali, custa nada.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "../..");
const PASTAS = ["app", "lib", "components", "hooks", "workers"];

function arquivos(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : arquivos(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("embed entre crm_leads e crm_stages nomeia a FK", () => {
  it("nenhum arquivo embute a outra tabela sem a dica da FK", () => {
    const culpados: string[] = [];
    for (const f of PASTAS.flatMap((d) => arquivos(path.join(RAIZ, d)))) {
      const src = fs.readFileSync(f, "utf8");
      const rel = path.relative(RAIZ, f);
      if (/from\(\s*["']crm_leads["']\s*\)/.test(src) && /(?<!references )\bcrm_stages\s*\(/.test(src)) {
        culpados.push(`${rel}: crm_stages( sem !crm_leads_stage_id_fkey`);
      }
      if (/from\(\s*["']crm_stages["']\s*\)/.test(src) && /(?<!references )\bcrm_leads\s*\(/.test(src)) {
        culpados.push(`${rel}: crm_leads( sem !crm_leads_stage_id_fkey`);
      }
    }
    expect(culpados).toEqual([]);
  });
});
