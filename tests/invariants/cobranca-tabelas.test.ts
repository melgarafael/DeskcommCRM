import { beforeAll, describe, expect, it } from "vitest";

import { columnExists, sql } from "./gov-helpers";
import { assinar, comoServidor, criarOrg, criarPlano, erroDe, numero, uuid, valor } from "./cobranca-helpers";

/**
 * AS DUAS TABELAS DA COBRANÇA: forma, vocabulário e o que sai (migration 0583;
 * spec cobrança do revendedor §2.1-§2.3). Nascem VAZIAS em toda instalação
 * (D-1), por isso a forma é provada no baseline que o kit aplica. O isolamento
 * entre organizações é o irmão cobranca-isolamento.test.ts.
 */

const P = "c0b00001-0000-4000-8000";
const ORG = uuid(P, 1);
const ORG_2 = uuid(P, 2);
const ORG_APAGAVEL = uuid(P, 3);
const PLANO = uuid(P, 101);
const PADRAO_1 = uuid(P, 102);
const PADRAO_2 = uuid(P, 103);

beforeAll(() => {
  criarOrg(ORG, "cob-tabelas-1");
  criarOrg(ORG_2, "cob-tabelas-2");
  criarOrg(ORG_APAGAVEL, "cob-tabelas-3");
  criarPlano({ id: PLANO, nome: "Básico" });
  assinar(ORG, PLANO);
  assinar(ORG_2, PLANO);
  assinar(ORG_APAGAVEL, PLANO);
});

describe("cobranca_planos — a forma do plano", () => {
  it("preço abaixo de R$ 5 é recusado (mínimo de boleto nos dois provedores)", () => {
    const e = erroDe(`insert into public.cobranca_planos (nome, preco_cents, intervalo) values ('Barato', 499, 'mes');`);
    expect(e).toContain("23514");
    expect(e).toContain("cobranca_planos_preco_cents_check");
    expect(erroDe(`insert into public.cobranca_planos (nome, preco_cents, intervalo) values ('Piso', 500, 'mes');`)).toBe("");
  });

  it("moeda só BRL, intervalo só mes|ano, teste grátis de 0 a 90 dias", () => {
    const casos: ReadonlyArray<readonly [string, string]> = [
      [`insert into public.cobranca_planos (nome, preco_cents, intervalo, moeda) values ('Dólar', 900, 'mes', 'USD')`, "cobranca_planos_moeda_check"],
      [`insert into public.cobranca_planos (nome, preco_cents, intervalo) values ('Semanal', 900, 'semana')`, "cobranca_planos_intervalo_check"],
      [`insert into public.cobranca_planos (nome, preco_cents, intervalo, trial_dias) values ('Longo', 900, 'mes', 91)`, "cobranca_planos_trial_dias_check"],
    ];
    for (const [comando, restricao] of casos) {
      const e = erroDe(`${comando};`);
      expect(e, restricao).toContain("23514");
      expect(e, restricao).toContain(restricao);
    }
  });

  it("⭐ um plano do cadastro por vez; o arquivado sai da conta", () => {
    sql(`insert into public.cobranca_planos (id, nome, preco_cents, intervalo, padrao_no_cadastro)
           values ('${PADRAO_1}', 'Cadastro 1', 900, 'mes', true);`);
    const segundo = `insert into public.cobranca_planos (id, nome, preco_cents, intervalo, padrao_no_cadastro)
                       values ('${PADRAO_2}', 'Cadastro 2', 900, 'mes', true);`;
    const e = erroDe(segundo);
    expect(e).toContain("23505");
    expect(e).toContain("cobranca_planos_um_padrao");
    sql(`update public.cobranca_planos set arquivado_em = now() where id = '${PADRAO_1}';`);
    expect(erroDe(segundo)).toBe("");
  });

  it("plano com assinante não se apaga (on delete restrict)", () => {
    expect(erroDe(`delete from public.cobranca_planos where id = '${PLANO}';`)).toContain("23503");
    expect(numero(`select count(*) from public.cobranca_planos where id = '${PLANO}';`)).toBe(1);
  });

  it("editar o plano carimba updated_at", () => {
    sql(`update public.cobranca_planos set updated_at = '2020-01-01' where id = '${PLANO}';`);
    sql(`update public.cobranca_planos set nome = 'Básico renomeado' where id = '${PLANO}';`);
    expect(valor(`select (updated_at > now() - interval '1 minute')::text from public.cobranca_planos where id = '${PLANO}';`)).toBe("true");
  });
});

describe("cobranca_assinaturas — uma linha por organização", () => {
  it("nasce em teste grátis, sem provedor, sem aviso e sem cobrança dupla", () => {
    expect(
      valor(`select estado || '|' || coalesce(provedor, '-') || '|' || coalesce(ultimo_aviso, '-') || '|' || assinaturas_vivas || '|' || cancela_no_fim
               from public.cobranca_assinaturas where organization_id = '${ORG}';`),
    ).toBe("trial|-|-|0|false");
  });

  it("uma organização, uma assinatura", () => {
    const e = erroDe(`insert into public.cobranca_assinaturas (organization_id, plano_id) values ('${ORG}', '${PLANO}');`);
    expect(e).toContain("23505");
    expect(e).toContain("cobranca_assinaturas_pkey");
  });

  it("⭐ provedor e cliente do provedor andam juntos (a Publicação zera os dois)", () => {
    const e = erroDe(`update public.cobranca_assinaturas set provedor = 'stripe' where organization_id = '${ORG}';`);
    expect(e).toContain("23514");
    expect(e).toContain("cobranca_assinaturas_provedor_e_cliente_juntos");
    expect(
      erroDe(`update public.cobranca_assinaturas set provedor = 'stripe', provedor_cliente_id = 'cus_0510', modo = 'teste'
                where organization_id = '${ORG}';`),
    ).toBe("");
  });

  it("⭐ o mesmo cliente do provedor não serve a duas organizações (o mapa cliente → org é nosso)", () => {
    const e = erroDe(`update public.cobranca_assinaturas set provedor = 'stripe', provedor_cliente_id = 'cus_0510'
                        where organization_id = '${ORG_2}';`);
    expect(e).toContain("23505");
    expect(e).toContain("cobranca_assinaturas_cliente");
    expect(
      erroDe(`update public.cobranca_assinaturas set provedor = 'asaas', provedor_cliente_id = 'cus_0510'
                where organization_id = '${ORG_2}';`),
    ).toBe("");
  });

  it("vocabulário fechado em estado, provedor, modo, último aviso e último erro", () => {
    for (const coluna of ["estado", "modo", "ultimo_aviso", "ultimo_erro"]) {
      const e = erroDe(`update public.cobranca_assinaturas set ${coluna} = 'forjado' where organization_id = '${ORG}';`);
      expect(e, coluna).toContain("23514");
      expect(e, coluna).toContain(`cobranca_assinaturas_${coluna}_check`);
    }
    const e = erroDe(`update public.cobranca_assinaturas set provedor = 'mercadopago' where organization_id = '${ORG_2}';`);
    expect(e).toContain("cobranca_assinaturas_provedor_check");
  });

  it("apagar a organização leva a assinatura junto", () => {
    sql(`delete from public.organizations where id = '${ORG_APAGAVEL}';`);
    expect(numero(`select count(*) from public.cobranca_assinaturas where organization_id = '${ORG_APAGAVEL}';`)).toBe(0);
  });
});

describe("RLS, grants e o que sai de organizations", () => {
  it("as duas tabelas têm RLS ligada", () => {
    expect(
      valor(`select string_agg(relname || ':' || relrowsecurity, ',' order by relname) from pg_class
              where relnamespace = 'public'::regnamespace and relname in ('cobranca_assinaturas', 'cobranca_planos');`),
    ).toBe("cobranca_assinaturas:true,cobranca_planos:true");
  });

  it("planos sem policy; assinaturas com UMA, de leitura, para authenticated", () => {
    expect(numero(`select count(*) from pg_policy where polrelid = 'public.cobranca_planos'::regclass;`)).toBe(0);
    expect(
      valor(`select string_agg(p.polname || '|' || p.polcmd::text || '|' ||
                     (select string_agg(r.rolname, ',') from pg_roles r where r.oid = any(p.polroles)), ' ## ')
               from pg_policy p where p.polrelid = 'public.cobranca_assinaturas'::regclass;`),
    ).toBe("tenant_isolation_cobranca_assinaturas_select|r|authenticated");
  });

  it("⭐ anon e authenticated não escrevem em nenhuma das duas (nem TRUNCATE)", () => {
    expect(
      valor(`select coalesce(string_agg(table_name || ':' || grantee || ':' || privilege_type, ','
                                        order by table_name, grantee, privilege_type), '-')
               from information_schema.role_table_grants
              where table_schema = 'public' and table_name in ('cobranca_assinaturas', 'cobranca_planos')
                and grantee in ('anon', 'authenticated', 'PUBLIC');`),
    ).toBe("cobranca_assinaturas:authenticated:SELECT");
  });

  it("controle: service_role lê e escreve as duas", () => {
    expect(numero(comoServidor(`select count(*) from public.cobranca_planos`))).toBeGreaterThanOrEqual(1);
    expect(erroDe(comoServidor(`update public.cobranca_assinaturas set relida_em = now() where organization_id = '${ORG}'`))).toBe("");
  });

  it("organizations perde ai_budget_cents e rate_limit_rps (nenhum leitor)", () => {
    expect(columnExists("organizations", "ai_budget_cents")).toBe(false);
    expect(columnExists("organizations", "rate_limit_rps")).toBe(false);
  });
});
