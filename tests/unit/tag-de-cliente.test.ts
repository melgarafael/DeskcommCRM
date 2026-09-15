import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TAG_DE_CLIENTE } from "@/lib/contacts/cliente";

/**
 * A ÚNICA divergência possível entre a etiqueta que o banco escreve e a que a
 * tela oferece no filtro.
 *
 * Quem grava `cliente` é SQL (o trigger e o backfill da migration 0255); quem
 * filtra por ela é TypeScript. São dois literais em dois idiomas, sem nada que
 * os obrigue a concordar — e o dia em que discordarem, o filtro "Cliente" não
 * acha ninguém, sem erro nenhum para investigar. É o modo de falha mais caro
 * que uma feature destas tem: silencioso e plausível ("então não temos clientes
 * marcados ainda").
 *
 * O teste lê o ARQUIVO, e não o banco, de propósito: assim ele roda em
 * `test:unit` (sem Postgres) e reprova o PR que muda um lado só.
 */
const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/20260915130000_0255_cliente_nasce_do_agendamento.sql",
);

describe("a etiqueta de cliente", () => {
  it("é a mesma no TypeScript e no SQL que a escreve", () => {
    const sql = readFileSync(MIGRATION, "utf8");

    // As duas escritas da migration: o trigger (transição) e o backfill
    // (histórico). Contar as ocorrências garante que nenhuma delas ficou com
    // outro literal — que é exatamente como a divergência nasceria.
    const ocorrencias = sql.match(new RegExp(`'${TAG_DE_CLIENTE}'`, "g")) ?? [];
    expect(
      ocorrencias.length,
      `a migration 0255 tem de escrever '${TAG_DE_CLIENTE}' no trigger E no backfill`,
    ).toBeGreaterThanOrEqual(4);
  });

  it("o baseline carrega a mesma etiqueta — é ele que o self-hoster aplica", () => {
    // Migração que só entra em `migrations/` não chega a quem instalou pelo kit.
    const baseline = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
    expect(baseline).toContain("trg_agendamento_marca_cliente");
    expect(baseline).toContain(`'${TAG_DE_CLIENTE}'`);
  });
});
