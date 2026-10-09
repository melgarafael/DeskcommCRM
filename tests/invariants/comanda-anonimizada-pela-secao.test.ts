/**
 * O EFEITO da anonimização sobre a comanda, com e sem o módulo `financeiro`
 * (PR #1907, migrations 0619/0620, D8/0485).
 *
 * As cercas vizinhas medem o REGISTRO: `cascata-lgpd-nao-encolhe` vê que `sales`
 * saiu da cascata e `lgpd-redact-unificado-alcanca-pelo-catalogo` vê que a seção
 * `financeiro/sales` está declarada. Nenhuma delas olha a COLUNA depois de
 * anonimizar — e é a coluna que diz se o efeito mudou.
 *
 * A régua é a main antes do #1907: o passo 6c da cascata fazia
 *   notes = null,
 *   cancel_reason  = case when cancel_reason  is null then null else '[redigido]' end,
 *   reverse_reason = case when reverse_reason is null then null else '[redigido]' end,
 *   updated_at = now()
 * e mudar o lugar do passo (da cascata para a seção declarada) não pode mudar a
 * saída de LGPD. Por isso a seção usa os modos `colunas_redigidas` e
 * `colunas_agora` (0619), e não `colunas` nem `colunas_rotulo`.
 *
 * Sabotagens medidas (no apêndice do baseline, que é o que este banco aplica):
 *  - motivos em `colunas` (viram NULO) → vermelho: o motivo preenchido sai NULL;
 *  - motivos em `colunas_rotulo` (rótulo também sobre nulo) → vermelho: o motivo
 *    nulo ganha 'Cliente Anonimizado #…';
 *  - sem `colunas_agora` → vermelho: `updated_at` não muda;
 *  - sem a declaração da seção → vermelho: `notes` continua legível.
 */
import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const ORG = "19070000-6666-4000-8000-000000000001";
const C_SEM = "19070000-5555-4000-8000-000000000001";
const C_COM = "19070000-5555-4000-8000-000000000002";
const C_VIZ = "19070000-5555-4000-8000-000000000003";
const PIX = "19070000-4444-4000-8000-000000000001";
// Três comandas do MESMO contato: motivos preenchidos; motivos nulos; só notes.
const V_MOTIVOS = "19070000-3333-4000-8000-000000000001";
const V_NULOS = "19070000-3333-4000-8000-000000000002";
const V_NOTES = "19070000-3333-4000-8000-000000000004";
const VV = "19070000-3333-4000-8000-000000000003";

const ANTES = "2020-01-01T00:00:00Z";
// As mesmas datas do seed, em epoch: 2026-01-02/03/04 10:00Z e 2020-01-01 00:00Z.
const FIN = 1767348000;
const CANC = 1767434400;
const EST = 1767520800;
const CRIADA = 1577836800;

/** notes|cancel_reason|reverse_reason, com NULO escrito. */
function textos(id: string): string {
  return sql(`select concat_ws('|', coalesce(notes,'NULL'), coalesce(cancel_reason,'NULL'),
                                coalesce(reverse_reason,'NULL'))
                from public.sales where id = '${id}';`);
}

/** O que a anonimização PRESERVA: valor, status, vínculo, moeda e as datas (em epoch; NULL escrito). */
function preservado(id: string): string {
  return sql(`select concat_ws('|', total_cents, status, contact_id, currency,
                                coalesce(extract(epoch from finalized_at)::bigint::text, 'NULL'),
                                coalesce(extract(epoch from cancelled_at)::bigint::text, 'NULL'),
                                coalesce(extract(epoch from reversed_at)::bigint::text, 'NULL'),
                                extract(epoch from created_at)::bigint)
                from public.sales where id = '${id}';`);
}

function carimboMudou(id: string): string {
  return sql(`select (updated_at > '${ANTES}'::timestamptz)::text from public.sales where id = '${id}';`);
}

describe("a comanda e a anonimização", () => {
  it("SEM o módulo: sales não existe e anonimizar o contato funciona", () => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG}', 'tri-1907', 'Tri 1907', 'Tri 1907') on conflict (id) do nothing;
      insert into public.contacts (id, organization_id, name) values
        ('${C_SEM}', '${ORG}', 'Sem Modulo'),
        ('${C_COM}', '${ORG}', 'Com Modulo'),
        ('${C_VIZ}', '${ORG}', 'Vizinha')
        on conflict (id) do nothing;
    `);
    expect(sql(`select coalesce(to_regclass('public.sales')::text, 'ausente');`)).toBe("ausente");
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${C_SEM}', gen_random_uuid());`);
    expect(sql(`select is_anonymized::text from public.contacts where id = '${C_SEM}';`)).toBe("true");
  });

  it("COM o módulo: o efeito é o do passo 6c da main — notes NULO, motivo preenchido vira '[redigido]', nulo fica nulo", () => {
    sql("select public.fn_financeiro_provisionar();");
    sql(`
      insert into public.payment_methods (id, organization_id, name)
        values ('${PIX}', '${ORG}', 'Pix') on conflict (id) do nothing;
      insert into public.sales (id, organization_id, number, contact_id, payment_method_id, status,
                                total_cents, notes, cancel_reason, reverse_reason,
                                finalized_at, cancelled_at, reversed_at, created_at, updated_at)
      values
        ('${V_MOTIVOS}', '${ORG}', 1, '${C_COM}', null, 'cancelled', 12345, 'Maria alergica a X',
         'Maria desistiu', 'Maria pediu estorno',
         '2026-01-02T10:00:00Z', '2026-01-03T10:00:00Z', '2026-01-04T10:00:00Z', '${ANTES}', '${ANTES}'),
        ('${V_NULOS}', '${ORG}', 2, '${C_COM}', '${PIX}', 'finalized', 500, null, null, null,
         '2026-01-02T10:00:00Z', null, null, '${ANTES}', '${ANTES}'),
        ('${V_NOTES}', '${ORG}', 4, '${C_COM}', '${PIX}', 'finalized', 777, 'Maria prefere manha', null, null,
         '2026-01-02T10:00:00Z', null, null, '${ANTES}', '${ANTES}'),
        ('${VV}', '${ORG}', 3, '${C_VIZ}', '${PIX}', 'finalized', 999, 'nota da vizinha', 'motivo da vizinha', null,
         '2026-01-02T10:00:00Z', null, null, '${ANTES}', '${ANTES}')
      on conflict (id) do nothing;
    `);
    // controle de seed: o texto está lá antes, e o carimbo está no passado.
    expect(textos(V_MOTIVOS)).toBe("Maria alergica a X|Maria desistiu|Maria pediu estorno");
    expect(carimboMudou(V_MOTIVOS)).toBe("false");

    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${C_COM}', gen_random_uuid());`);

    expect(textos(V_MOTIVOS), "motivos preenchidos viram '[redigido]' (main 6c)").toBe(
      "NULL|[redigido]|[redigido]",
    );
    expect(textos(V_NULOS), "motivo nulo continua nulo — nada é inventado").toBe("NULL|NULL|NULL");
    expect(textos(V_NOTES)).toBe("NULL|NULL|NULL");

    expect(preservado(V_MOTIVOS)).toBe(`12345|cancelled|${C_COM}|BRL|${FIN}|${CANC}|${EST}|${CRIADA}`);
    expect(preservado(V_NULOS)).toBe(`500|finalized|${C_COM}|BRL|${FIN}|NULL|NULL|${CRIADA}`);
    expect(preservado(V_NOTES)).toBe(`777|finalized|${C_COM}|BRL|${FIN}|NULL|NULL|${CRIADA}`);

    for (const v of [V_MOTIVOS, V_NULOS, V_NOTES]) {
      expect(carimboMudou(v), `updated_at da comanda ${v} recebe now() (main 6c)`).toBe("true");
    }

    // A vizinha (outro contato) fica intocada, carimbo inclusive.
    expect(textos(VV)).toBe("nota da vizinha|motivo da vizinha|NULL");
    expect(carimboMudou(VV)).toBe("false");
  });
});
