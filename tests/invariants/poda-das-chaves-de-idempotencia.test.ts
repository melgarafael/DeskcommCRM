/**
 * A PODA DAS CHAVES DE IDEMPOTÊNCIA NO BANCO REAL (#1613, item B).
 *
 * O teste estático (`tests/unit/poda-das-chaves-de-idempotencia.test.ts`)
 * confere o TEXTO da função. Aqui ela roda contra linhas reais e o que se mede
 * é quem sobrou:
 *
 *   - chave viva e chave vencida há pouco (dentro da folga de 1 dia) ficam —
 *     a vencida há pouco pode ser a reserva de um envio ainda gravando o
 *     recibo, e `lib/api/idempotency.ts` a reescreve no lugar;
 *   - vencida há mais que a folga sai, de qualquer organização (é a rotina da
 *     instalação, como as podas irmãs);
 *   - `p_retencao_dias` 0 ou nulo vale como 1 (o piso mora no CORPO);
 *   - `p_limite` limita o lote;
 *   - quem não é a service role não executa.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const ORG_A = "16130001-0000-4000-8000-000000000001";
const ORG_B = "16130001-0000-4000-8000-000000000002";

function valor(consulta: string): number {
  const saida = sql(consulta).trim().split("\n").at(-1) ?? "";
  if (!/^-?\d+$/.test(saida)) throw new Error(`saída inesperada do psql: ${saida}`);
  return Number(saida);
}

function chavesQueRestam(): string[] {
  return sql(
    `select key from public.idempotency_keys where organization_id in ('${ORG_A}', '${ORG_B}') order by key;`,
  )
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^k-/.test(l));
}

/** Uma chave com o `expires_at` deslocado de `horas` (negativo = vencida). */
function chave(org: string, nome: string, horas: number): string {
  return `('${org}', '${nome}', '/api/v1/messages', '\\x00'::bytea, 201, '{}'::jsonb,
           now() - interval '3 days', now() + make_interval(hours => ${horas}))`;
}

beforeEach(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'idem-1613-a', 'Idem 1613 A', 'Idem 1613 A'),
      ('${ORG_B}', 'idem-1613-b', 'Idem 1613 B', 'Idem 1613 B')
      on conflict do nothing;
    delete from public.idempotency_keys where organization_id in ('${ORG_A}', '${ORG_B}');
    insert into public.idempotency_keys
      (organization_id, key, endpoint, request_hash, status_code, response_body, created_at, expires_at)
    values
      ${chave(ORG_A, "k-1-viva", 12)},
      ${chave(ORG_A, "k-2-vencida-ha-12h", -12)},
      ${chave(ORG_A, "k-3-vencida-ha-2-dias", -48)},
      ${chave(ORG_B, "k-4-outra-org-vencida-ha-2-dias", -48)};
  `);
});

describe("#1613 — fn_expurgar_chaves_de_idempotencia_vencidas", () => {
  it("CONTROLE POSITIVO: a função existe e devolve inteiro", () => {
    expect(valor(`select public.fn_expurgar_chaves_de_idempotencia_vencidas(1, 1000);`)).toBeGreaterThanOrEqual(0);
  });

  it("apaga só o que venceu há mais de 1 dia, de qualquer organização", () => {
    sql(`select public.fn_expurgar_chaves_de_idempotencia_vencidas(1, 1000);`);
    expect(chavesQueRestam()).toEqual(["k-1-viva", "k-2-vencida-ha-12h"]);
  });

  it("piso no corpo: 0 e nulo valem como 1 dia", () => {
    sql(`select public.fn_expurgar_chaves_de_idempotencia_vencidas(0, 1000);`);
    expect(chavesQueRestam()).toContain("k-2-vencida-ha-12h");
    sql(`select public.fn_expurgar_chaves_de_idempotencia_vencidas(null, null);`);
    expect(chavesQueRestam()).toEqual(["k-1-viva", "k-2-vencida-ha-12h"]);
  });

  it("o lote limita quantas saem por chamada", () => {
    expect(valor(`select public.fn_expurgar_chaves_de_idempotencia_vencidas(1, 1);`)).toBe(1);
    expect(chavesQueRestam()).toHaveLength(3);
  });

  it("só a service role executa", () => {
    for (const papel of ["authenticated", "anon"]) {
      expect(
        valor(
          `select case when has_function_privilege('${papel}', 'public.fn_expurgar_chaves_de_idempotencia_vencidas(int, int)', 'execute') then 1 else 0 end;`,
        ),
      ).toBe(0);
    }
    expect(
      valor(
        `select case when has_function_privilege('service_role', 'public.fn_expurgar_chaves_de_idempotencia_vencidas(int, int)', 'execute') then 1 else 0 end;`,
      ),
    ).toBe(1);
  });
});
