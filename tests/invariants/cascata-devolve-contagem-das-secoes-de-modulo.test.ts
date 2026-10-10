/**
 * A CONTAGEM da comanda na evidência de LGPD (PR #1907, migration 0620, D8/0485).
 *
 * Na main, o passo 6c da cascata gravava `"sales": n` no jsonb de contagens — que vira
 * `cascaded_to` no `api_audit_log` (`lgpd.redact_executed`) e no retorno da função. Com a
 * redação da comanda passando para a seção declarada (`modulo_secoes_lgpd`), o gatilho
 * redige mas não conta; a 0620 conta cada seção declarada pela própria `ligacao`, sem
 * nomear tabela. Régua: o valor do 6c = todas as comandas do contato naquela org.
 *
 * Sabotagem medida: sem o laço de contagem na 0620 (apêndice do baseline) → vermelho
 * no segundo caso (`sales` ausente do retorno e do audit); sem a guarda de ligação vazia
 * no laço → vermelho no terceiro (o `count` quebra com `syntax error` antes do gatilho).
 */
import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const ORG = "19070000-6666-4000-8000-0000000000c1";
const C_SEM = "19070000-5555-4000-8000-0000000000c1";
const C_COM = "19070000-5555-4000-8000-0000000000c2";
const C_VIZ = "19070000-5555-4000-8000-0000000000c3";
const PIX = "19070000-4444-4000-8000-0000000000c1";

function cascata(contato: string): string {
  return sql(`select (public.fn_lgpd_cascade_redact_contact('${ORG}', '${contato}', gen_random_uuid()) -> 'counts')::text;`);
}

function tentar(script: string): string {
  try {
    return `OK:${sql(script)}`;
  } catch (e) {
    return `ERRO:${(e as { stderr?: string }).stderr ?? String(e)}`;
  }
}

function auditado(contato: string): string {
  return sql(`select (metadata -> 'cascaded_to')::text from public.api_audit_log
                where action = 'lgpd.redact_executed' and resource_id = '${contato}'
                order by created_at desc limit 1;`);
}

describe("a cascata de LGPD conta as seções de módulo", () => {
  it("SEM o módulo: nenhuma chave de seção e nenhum erro", () => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG}', 'tri-1907-cont', 'Tri 1907 cont', 'Tri 1907 cont') on conflict (id) do nothing;
      insert into public.contacts (id, organization_id, name) values
        ('${C_SEM}', '${ORG}', 'Sem Modulo'),
        ('${C_COM}', '${ORG}', 'Com Modulo'),
        ('${C_VIZ}', '${ORG}', 'Vizinha')
        on conflict (id) do nothing;
    `);
    expect(sql(`select coalesce(to_regclass('public.sales')::text, 'ausente');`)).toBe("ausente");
    const counts = JSON.parse(cascata(C_SEM)) as Record<string, number>;
    expect(counts.contacts, "controle: a cascata rodou").toBe(1);
    expect(counts).not.toHaveProperty("sales");
  });

  it("COM o módulo: sales = todas as comandas do contato (3), como o passo 6c da main", () => {
    sql("select public.fn_financeiro_provisionar();");
    sql(`
      insert into public.payment_methods (id, organization_id, name) values ('${PIX}', '${ORG}', 'Pix');
      insert into public.sales (organization_id, number, contact_id, payment_method_id, status, total_cents, notes)
      values
        ('${ORG}', 1, '${C_COM}', '${PIX}', 'finalized', 100, 'a'),
        ('${ORG}', 2, '${C_COM}', null, 'cancelled', 200, null),
        ('${ORG}', 3, '${C_COM}', '${PIX}', 'finalized', 300, 'c'),
        ('${ORG}', 4, '${C_VIZ}', '${PIX}', 'finalized', 400, 'vizinha');
    `);
    const counts = JSON.parse(cascata(C_COM)) as Record<string, number>;
    expect(counts.sales, "comandas do contato, sem a vizinha").toBe(3);
    expect((JSON.parse(auditado(C_COM)) as Record<string, number>).sales, "a evidência no audit").toBe(3);
  });

  it("seção com ligação vazia: o erro segue sendo o NOMEADO do gatilho (D8), não o do count", () => {
    // Uma transação que aborta: a seção errada e a tabela-sonda não sobrevivem ao caso.
    const r = tentar(`
      begin;
      create table public.zz_sonda_1907 (organization_id uuid, contact_id uuid, t text);
      insert into public.modulo_secoes_lgpd (modulo, tabela, ligacao, colunas)
        values ('zz1907', 'zz_sonda_1907', '', '{t}');
      select public.fn_lgpd_cascade_redact_contact('${ORG}', '${C_VIZ}', gen_random_uuid());
      commit;
    `);
    expect(r).toContain("modulo_secao_invalida");
    expect(r).toContain("zz1907/zz_sonda_1907");
    expect(sql(`select coalesce(to_regclass('public.zz_sonda_1907')::text, 'ausente');`)).toBe("ausente");
  });
});
