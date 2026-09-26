/**
 * Invariante de `lost_from_stage_id` (issue #1537) — a etapa de onde o negócio
 * saiu precisa estar gravada por TODOS os caminhos de perda, e o único lugar
 * que decide isso é o gatilho `fn_crm_lead_close_on_stage`.
 *
 * Este teste é ESTATICO de propósito: ele compara o `baseline.sql` (o que uma
 * instalação nova executa) com a migration 0426 (o que uma instalação existente
 * executa). Se os dois corpos divergirem, instalação nova e atualizadas passam
 * a gravar coisas diferentes para o mesmo evento — e nenhum teste de comportamento
 * com um único banco pegaria a divergência, porque cada um roda no seu.
 *
 * O comportamento em si (mover para a etapa de perda preenche a origem) é o que
 * o corpo testado aqui assegura; rodar contra Postgres efêmero exigiria o banco
 * (`pnpm test:db`), que este gate não abre — a regressão possível SEM banco é
 * exatamente a deriva entre os dois arquivos, e é ela que se trava aqui.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const MIGRATION = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20260926150000_0426_motivo_de_perda_com_categoria.sql"),
  "utf8",
);
const MANIFEST = readFileSync(join(process.cwd(), "supabase", "migrations", "MANIFEST.md"), "utf8");
const TIPOS = readFileSync(join(process.cwd(), "lib", "database.types.ts"), "utf8");

/** O corpo do gatilho, sem comentários e sem espaços — o que o banco executa. */
function corpoDoGatilho(sql: string): string {
  // O âncora é o `if v_is_won then`, não a assinatura: o baseline é dump
  // (`CREATE OR REPLACE FUNCTION "public"."…"() RETURNS "trigger"`) e a
  // migration é lowercase (`… public.fn_…() returns trigger`) — a assinatura
  // escrita de um jeito só não acha as duas.
  expect(sql).toContain("fn_crm_lead_close_on_stage");
  const a = sql.lastIndexOf("  if v_is_won then");
  const b = sql.indexOf("  return new;", a);
  expect(a, "corpo do gatilho não encontrado").toBeGreaterThan(-1);
  expect(b, "fim do corpo do gatilho não encontrado").toBeGreaterThan(a);
  return sql
    .slice(a, b + "  return new;".length)
    .split("\n")
    .map((linha) => linha.replace(/--.*$/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
}

describe("lost_from_stage_id gravado pelo gatilho (#1537)", () => {
  it("baseline e migration executam o MESMO corpo — instalação nova não diverge", () => {
    expect(corpoDoGatilho(MIGRATION)).toBe(corpoDoGatilho(BASELINE));
  });

  it("a origem só nasce na transição para `lost`, preservando o que já havia", () => {
    for (const sql of [BASELINE, MIGRATION]) {
      expect(sql).toContain(
        "new.lost_from_stage_id := coalesce(new.lost_from_stage_id, old.stage_id);",
      );
      expect(sql).toContain("if tg_op = 'UPDATE' and old.status is distinct from 'lost' then");
    }
  });

  it("reabrir zera a origem — negócio aberto não tem etapa de perda", () => {
    // Pelo corpo JÁ sem comentários: o texto entre `closed_at` e a limpeza é
    // comentário, e um teste que casa comentário quebra quando alguém explica
    // melhor a linha.
    const corpo = corpoDoGatilho(MIGRATION);
    expect(corpo).toContain(
      "new.status := 'open'; new.closed_at := null; new.lost_from_stage_id := null;",
    );
    expect(corpoDoGatilho(BASELINE)).toContain(
      "new.status := 'open'; new.closed_at := null; new.lost_from_stage_id := null;",
    );
  });

  it("a coluna existe nos TRÊS lugares da tripla", () => {
    expect(MIGRATION).toContain("add column if not exists lost_from_stage_id uuid");
    expect(BASELINE).toContain("add column if not exists lost_from_stage_id uuid");
    expect(MANIFEST).toContain("0426_motivo_de_perda_com_categoria");
    // Row, Insert e Update; e a FK em Relationships, que é o que o PostgREST vê
    // — a segunda FK para `crm_stages` torna ambíguo o embed sem dica.
    expect(TIPOS.match(/lost_from_stage_id\??:/g) ?? []).toHaveLength(3);
    expect(TIPOS).toContain('foreignKeyName: "fk_crm_leads_lost_from_stage"');
  });

  it("o trigger de validação lê o RÓTULO dos dois formatos de lost_reasons", () => {
    // Sem isto, `{ label, categoria }` é recusado com 22023 e o funil inteiro
    // não consegue perder negócio — o defeito que a issue descreve viraria
    // travamento de escrita.
    for (const sql of [BASELINE, MIGRATION]) {
      expect(sql).toContain("jsonb_typeof(e) = 'object'");
      expect(sql).toContain("nullif(e ->> 'label', '')");
      expect(sql).toContain("nullif(e #>> '{}', '')");
    }
  });
});
