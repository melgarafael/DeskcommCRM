/**
 * Funil novo nasce com o vocabulário NEUTRO — migration 9080, doc 249 (resposta B).
 *
 * O DEFAULT de `crm_pipelines.vocabulary` era o de loja (Cliente/Pedido/Pago/
 * Cancelado), e todo funil que nasce sem a coluna o herda: o do gatilho de
 * seed, o que o onboarding troca de ramo e o de `POST /api/v1/pipelines`. Numa
 * clínica recém-instalada, o quadro dizia "1 Pedido selecionado".
 *
 * Cerca estrutural (só lê o repositório). O que vale numa instalação é a
 * ÚLTIMA definição do DEFAULT no `baseline.sql` — o `CREATE TABLE` do dump
 * segue com o de loja, e é o apêndice que o sobrescreve. Ler a primeira
 * ocorrência mediria o snapshot, não o que o `install.sh` deixa no banco.
 * O efeito no Postgres de verdade é medido em
 * `tests/invariants/quadro-do-onboarding.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveVocabulary } from "@/lib/kanban/vocabulary";

const RAIZ = join(__dirname, "..", "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

const NEUTRO = {
  lead: "Contato",
  lead_plural: "Contatos",
  deal: "Negócio",
  deal_plural: "Negócios",
  won: "Ganho",
  lost: "Perdido",
  stage: "Etapa",
  stage_plural: "Etapas",
};

/** Os pares `'chave', 'valor'` de um `jsonb_build_object(...)` plano. */
function pares(args: string): Record<string, string> {
  const literais = [...args.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
  const obj: Record<string, string> = {};
  for (let i = 0; i + 1 < literais.length; i += 2) obj[literais[i]!] = literais[i + 1]!;
  return obj;
}

/** Toda definição do DEFAULT da coluna, na ordem do arquivo. */
function definicoes(sql: string): Array<{ indice: number; valor: Record<string, string> }> {
  const padroes = [
    /"vocabulary" "jsonb" DEFAULT "jsonb_build_object"\(([^)]*)\)/g,
    /alter table (?:public\.)?"?crm_pipelines"?\s+alter column "?vocabulary"? set default "?jsonb_build_object"?\(([^)]*)\)/gi,
  ];
  return padroes
    .flatMap((re) => [...sql.matchAll(re)].map((m) => ({ indice: m.index ?? 0, valor: pares(m[1] ?? "") })))
    .sort((a, b) => a.indice - b.indice);
}

describe("o vocabulário padrão do funil é neutro (9080)", () => {
  const baseline = ler("supabase/baseline.sql");
  const todas = definicoes(baseline);

  it("a sonda acha a definição do CREATE TABLE — senão o resto passaria vazio", () => {
    // Controle positivo: vale com e sem o conserto, porque o dump segue com o de loja.
    expect(todas.length).toBeGreaterThanOrEqual(1);
    expect(todas[0]!.valor.deal).toBe("Pedido");
  });

  it("a ÚLTIMA definição no baseline é a neutra, com as MESMAS chaves do default de loja", () => {
    const ultima = todas.at(-1)!.valor;
    expect(ultima).toEqual(NEUTRO);
    expect(Object.keys(ultima).sort()).toEqual(Object.keys(todas[0]!.valor).sort());
  });

  it("a migration 9080 grava o mesmo default, se descreve e não reescreve linha nenhuma", () => {
    const nome = readdirSync(join(RAIZ, "supabase/migrations")).find((f) => /^\d{14}_9080_/.test(f));
    expect(nome, "migration 9080 ausente").toBeTruthy();
    const migration = ler(`supabase/migrations/${nome}`);
    expect(migration).toMatch(/^-- manifest:\s*\S/m);
    expect(definicoes(migration).map((d) => d.valor)).toEqual([NEUTRO]);
    expect(migration).not.toMatch(/^\s*update\b/im);
  });

  it("o fallback da tela diz o mesmo que o banco", () => {
    const { lead, deal, won, lost } = NEUTRO;
    expect(resolveVocabulary(null)).toEqual({ lead, deal, won, lost });
  });
});
