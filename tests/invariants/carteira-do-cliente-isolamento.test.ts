/** #2591 — carteira entre DUAS organizações e a exclusão do login do dono (on delete set null x CHECK do trio). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lastLine, sql } from "./gov-helpers";

const ORG1 = "eeeeeeee-7000-4000-8000-000000000001";
const ORG2 = "eeeeeeee-7000-4000-8000-000000000002";
const DONO = "eeeeeeee-7111-4000-8000-000000000001";
const GESTOR1 = "eeeeeeee-7111-4000-8000-000000000002";
const GESTOR2 = "eeeeeeee-7111-4000-8000-000000000003";
const C1 = "eeeeeeee-7333-4000-8000-000000000001";
const C2 = "eeeeeeee-7333-4000-8000-000000000002";

function rpc(user: string, org: string, contato: string, dono: string): string {
  try {
    sql(`set role service_role;
         select public.fn_definir_carteira_do_cliente('${org}', '${user}', '${contato}', '${dono}', 'manual');`);
    return "";
  } catch (err) {
    return ((err as { stderr?: string }).stderr ?? "").replace(/\s+/g, " ");
  }
}

describe("carteira do cliente (#2591) — isolamento e exclusão do dono", () => {
  beforeAll(() => {
    sql(`
      insert into auth.users (id, email) values ('${DONO}','s-d@x.test'),('${GESTOR1}','s-g1@x.test'),('${GESTOR2}','s-g2@x.test') on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG1}','sonda-c1','S1','S1'),('${ORG2}','sonda-c2','S2','S2') on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${DONO}','${ORG1}','agent',now()),('${GESTOR1}','${ORG1}','manager',now()),('${GESTOR2}','${ORG2}','manager',now())
        on conflict (user_id, organization_id) do nothing;
      insert into public.contacts (id, organization_id, display_name) values ('${C1}','${ORG1}','c1'),('${C2}','${ORG2}','c2') on conflict (id) do nothing;
    `);
  });
  afterAll(() => {
    sql(`delete from public.user_organizations where organization_id in ('${ORG1}','${ORG2}');
         delete from public.contacts where organization_id in ('${ORG1}','${ORG2}');
         delete from public.organizations where id in ('${ORG1}','${ORG2}');
         delete from auth.users where id in ('${DONO}','${GESTOR1}','${GESTOR2}');`);
  });

  it("2 tenants: gestor de ORG2 não põe contato de ORG1 na carteira, nem com p_org=ORG1 nem com p_org=ORG2", () => {
    expect(rpc(GESTOR2, ORG1, C1, DONO)).toContain("carteira_permissao_negada");
    expect(rpc(GESTOR2, ORG2, C1, DONO)).toContain("carteira_contato_de_outra_organizacao");
    expect(rpc(GESTOR2, ORG2, C2, DONO)).toContain("carteira_dono_invalido"); // dono de outra org
    expect(lastLine(sql(`select coalesce(carteira_user_id::text,'NULL') from public.contacts where id='${C1}';`))).toBe("NULL");
  });

  it("a sessão não chama a porta direto: só o servidor, depois do requireRole da rota", () => {
    let erro = "";
    try {
      sql(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"${GESTOR1}"}', false);
           select public.fn_definir_carteira_do_cliente('${ORG1}', '${GESTOR1}', '${C1}', '${DONO}', 'manual');`);
    } catch (err) {
      erro = ((err as { stderr?: string }).stderr ?? "").replace(/\s+/g, " ");
    }
    expect(erro).toContain("permission denied for function fn_definir_carteira_do_cliente");
    expect(lastLine(sql(`select coalesce(carteira_user_id::text,'NULL') from public.contacts where id='${C1}';`))).toBe("NULL");
  });

  it("excluir o login do dono (on delete set null) devolve o cliente ao fluxo normal", () => {
    expect(rpc(GESTOR1, ORG1, C1, DONO)).toBe("");
    sql(`delete from public.user_organizations where user_id='${DONO}';`);
    let erro = "";
    try { sql(`delete from auth.users where id='${DONO}';`); }
    catch (err) { erro = ((err as { stderr?: string }).stderr ?? "").replace(/\s+/g, " "); }
    expect(erro).toBe("");
    expect(lastLine(sql(`select coalesce(carteira_user_id::text,'NULL') from public.contacts where id='${C1}';`))).toBe("NULL");
  });
});
