/**
 * OAuth 2.1 do MCP do CRM (migration 9390), medido no banco que o
 * `baseline.sql` instala:
 *
 * 1. As três tabelas são server-side only: RLS ligada, nenhuma policy,
 *    privilégio NENHUM para `anon`/`authenticated` — admin da própria
 *    organização e da vizinha recebem `permission denied`.
 * 2. As funções só executam por `service_role`.
 * 3. A troca do código confere PKCE S256 NO BANCO (com o desafio calculado em
 *    TypeScript — paridade das duas pontas), queima o código mesmo na recusa,
 *    e o reuso revoga o que o código emitiu.
 * 4. O token emitido é uma linha de `api_tokens` da organização certa, criada
 *    pela pessoa que consentiu, com `role:admin` — e a RLS de `api_tokens` a
 *    mostra ao admin da organização dona e a ninguém da vizinha.
 * 5. Renovação rotaciona (o hash do token muda na MESMA linha; o refresh
 *    anterior só vale mais 60 s, para a resposta perdida na rede) e re-confere: token revogado na tela, pessoa que deixou de ser
 *    admin → recusa e desliga a conexão.
 * 6. Revogação só alcança concessão do próprio cliente.
 * 7. A poda leva códigos vencidos e clientes nunca usados.
 */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELAS = ["mcp_oauth_clientes", "mcp_oauth_codigos", "mcp_oauth_concessoes"] as const;
const FUNCOES = [
  "fn_mcp_oauth_ainda_admin(uuid, uuid)",
  "fn_mcp_oauth_desligar(uuid)",
  "fn_mcp_oauth_trocar_codigo(bytea, uuid, text, text, bytea, text, timestamptz, bytea, timestamptz, text)",
  "fn_mcp_oauth_renovar(bytea, uuid, bytea, bytea, text, timestamptz, timestamptz, text[])",
  "fn_mcp_oauth_revogar(bytea, uuid)",
  "fn_mcp_oauth_podar()",
] as const;

const ORG_X = "93900000-0000-4000-8000-00000000000a";
const ORG_Y = "93900000-0000-4000-8000-00000000000b";
const ADMIN_X = "93901111-0000-4000-8000-00000000000a";
const ADMIN_Y = "93901111-0000-4000-8000-00000000000b";
const AGENTE_X = "93901111-0000-4000-8000-00000000000c";
const CLIENTE_A = "93902222-0000-4000-8000-00000000000a";
const CLIENTE_B = "93902222-0000-4000-8000-00000000000b";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const VERIFIER = "verificador-de-teste-com-mais-de-quarenta-e-tres-caracteres_9390";

/** O desafio calculado como o CLIENTE calcula — o banco tem de concordar. */
function desafioS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const h = (v: string) => `sha256(convert_to('${v}', 'UTF8'))`;

function erroSob(papel: string, comando: string, usuario?: string): string | null {
  const jwt = usuario
    ? `select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated"}', true);`
    : "";
  try {
    sql(`begin;\n${jwt}\nset local role ${papel};\n${comando};\ncommit;`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

function contarSob(usuario: string, comando: string): string {
  return sql(`begin;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated"}', true);
    set local role authenticated;
    ${comando};
    commit;`)
    .split("\n")
    .filter((l) => /^\d+$/.test(l.trim()))
    .pop()!
    .trim();
}

function novoCodigo(
  codigo: string,
  opts: { usuario?: string; org?: string; cliente?: string; expira?: string; escopos?: string } = {},
): void {
  sql(`insert into public.mcp_oauth_codigos
         (organization_id, cliente_id, user_id, codigo_hash, code_challenge, redirect_uri, escopos, recurso, expira_em)
       values ('${opts.org ?? ORG_X}', '${opts.cliente ?? CLIENTE_A}', '${opts.usuario ?? ADMIN_X}', ${h(codigo)},
               '${desafioS256(VERIFIER)}', '${REDIRECT}', '${opts.escopos ?? "{mcp:read,mcp:write}"}',
               'https://crm.test/api/mcp', ${opts.expira ?? "now() + interval '5 minutes'"});`);
}

/** Troca o código; devolve `ok|<api_token_id>|<concessao_id>` ou o motivo. */
function trocar(codigo: string, token: string, refresh: string, opts: { cliente?: string; verifier?: string; redirect?: string } = {}): string {
  return sql(`select coalesce(motivo, 'ok') || '|' || coalesce(api_token_id::text, '') || '|' || coalesce(concessao_id::text, '')
                from public.fn_mcp_oauth_trocar_codigo(
                  ${h(codigo)}, '${opts.cliente ?? CLIENTE_A}', '${opts.redirect ?? REDIRECT}', '${opts.verifier ?? VERIFIER}',
                  ${h(token)}, 'dsk_${createHash("md5").update(token).digest("hex").slice(0, 8)}', now() + interval '1 hour',
                  ${h(refresh)}, now() + interval '60 days', 'ChatGPT (OAuth)');`);
}

function renovar(refresh: string, novoRefresh: string, novoToken: string, escopos = "null", cliente = CLIENTE_A): string {
  return sql(`select coalesce(motivo, 'ok') || '|' || coalesce(array_to_string(escopos, ' '), '')
                from public.fn_mcp_oauth_renovar(
                  ${h(refresh)}, '${cliente}', ${h(novoRefresh)}, ${h(novoToken)},
                  'dsk_${createHash("md5").update(novoToken).digest("hex").slice(0, 8)}',
                  now() + interval '1 hour', now() + interval '60 days', ${escopos});`);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_X}', 'ax9390@invariant.test'), ('${ADMIN_Y}', 'ay9390@invariant.test'), ('${AGENTE_X}', 'gx9390@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_X}', 'inv-9390-x', 'Org X 9390', 'X'), ('${ORG_Y}', 'inv-9390-y', 'Org Y 9390', 'Y')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_X}', '${ORG_X}', 'admin', now()), ('${ADMIN_Y}', '${ORG_Y}', 'admin', now()),
      ('${AGENTE_X}', '${ORG_X}', 'agent', now())
      on conflict do nothing;
    insert into public.mcp_oauth_clientes (id, client_id, nome, redirect_uris) values
      ('${CLIENTE_A}', 'dcc_${"a".repeat(32)}', 'ChatGPT', '{${REDIRECT}}'),
      ('${CLIENTE_B}', 'dcc_${"b".repeat(32)}', 'Outro', '{${REDIRECT}}')
      on conflict do nothing;
  `);
});

describe("tabelas e funções do OAuth do MCP são server-side only", () => {
  it("as três tabelas existem no baseline — controle positivo da sonda", () => {
    for (const t of TABELAS) {
      expect(
        sql(`select count(*) from information_schema.tables where table_schema='public' and table_name='${t}';`),
        `a 9390 não chegou ao baseline: ${t}`,
      ).toBe("1");
    }
  });

  it("RLS ligada, nenhuma policy, nenhum privilégio para anon/authenticated", () => {
    for (const t of TABELAS) {
      expect(sql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass;`), t).toBe("t");
      expect(sql(`select count(*) from pg_policies where schemaname='public' and tablename='${t}';`), t).toBe("0");
      for (const papel of ["anon", "authenticated"]) {
        expect(
          sql(`select count(*) from information_schema.role_table_grants
                where table_schema='public' and table_name='${t}' and grantee='${papel}';`),
          `${papel} tem privilégio em ${t}`,
        ).toBe("0");
      }
    }
  });

  it("nem o admin da própria organização nem o da vizinha lê pelo PostgREST", () => {
    for (const usuario of [ADMIN_X, ADMIN_Y]) {
      for (const t of TABELAS) {
        const erro = erroSob("authenticated", `select count(*) from public.${t}`, usuario);
        expect(erro, `authenticated leu ${t} sem erro`).not.toBeNull();
        expect(erro).toContain("permission denied");
      }
    }
    expect(erroSob("anon", "select client_secret_hash from public.mcp_oauth_clientes")).toContain("permission denied");
  });

  it("as funções não executam por anon/authenticated e executam por service_role", () => {
    for (const f of FUNCOES) {
      for (const papel of ["anon", "authenticated"]) {
        expect(sql(`select has_function_privilege('${papel}', 'public.${f}', 'execute');`), `${papel} executa ${f}`).toBe("f");
      }
      expect(sql(`select has_function_privilege('service_role', 'public.${f}', 'execute');`), f).toBe("t");
    }
  });
});

describe("troca do código (authorization_code + PKCE)", () => {
  it("PKCE certo: emite api_tokens da organização, criado pela pessoa, com role:admin", () => {
    novoCodigo("dco_ok");
    const [motivo, token, concessao] = trocar("dco_ok", "dsk_t_ok", "dsr_ok").split("|");
    expect(motivo).toBe("ok");
    expect(sql(`select organization_id || '|' || created_by || '|' || (scopes @> '["mcp:read","mcp:write","role:admin"]')::text
                  from public.api_tokens where id = '${token}';`)).toBe(`${ORG_X}|${ADMIN_X}|true`);
    expect(sql(`select (token_hash = ${h("dsk_t_ok")})::text from public.api_tokens where id = '${token}';`)).toBe("true");
    expect(sql(`select api_token_id from public.mcp_oauth_concessoes where id = '${concessao}';`)).toBe(token);
    expect(sql(`select usado_em is not null from public.mcp_oauth_codigos where codigo_hash = ${h("dco_ok")};`)).toBe("t");
  });

  it("isolamento: a RLS de api_tokens mostra a conexão ao admin dono e a ninguém da vizinha", () => {
    expect(contarSob(ADMIN_X, `select count(*) from public.api_tokens where token_hash = ${h("dsk_t_ok")}`)).toBe("1");
    expect(contarSob(ADMIN_Y, `select count(*) from public.api_tokens where token_hash = ${h("dsk_t_ok")}`)).toBe("0");
  });

  it("reuso do código: recusa e REVOGA o que ele emitiu (OAuth 2.1 §4.1.3)", () => {
    novoCodigo("dco_reuso");
    const [, token, concessao] = trocar("dco_reuso", "dsk_t_reuso", "dsr_reuso").split("|");
    expect(trocar("dco_reuso", "dsk_t_reuso2", "dsr_reuso2").split("|")[0]).toBe("invalid_grant");
    expect(sql(`select revoked_at is not null from public.api_tokens where id = '${token}';`)).toBe("t");
    expect(sql(`select revogada_em is not null from public.mcp_oauth_concessoes where id = '${concessao}';`)).toBe("t");
  });

  it("verifier errado: recusa E queima o código — o certo depois também é recusado", () => {
    novoCodigo("dco_verifier");
    expect(trocar("dco_verifier", "dsk_t_v1", "dsr_v1", { verifier: `${VERIFIER}x` })).toBe("invalid_grant||");
    expect(trocar("dco_verifier", "dsk_t_v2", "dsr_v2")).toBe("invalid_grant||");
    expect(sql(`select count(*) from public.api_tokens where token_hash in (${h("dsk_t_v1")}, ${h("dsk_t_v2")});`)).toBe("0");
  });

  it("outro cliente, outro redirect ou código vencido: recusa sem token", () => {
    novoCodigo("dco_cliente");
    expect(trocar("dco_cliente", "dsk_t_c", "dsr_c", { cliente: CLIENTE_B })).toBe("invalid_grant||");
    novoCodigo("dco_redirect");
    expect(trocar("dco_redirect", "dsk_t_r", "dsr_r", { redirect: "https://evil.example/cb" })).toBe("invalid_grant||");
    novoCodigo("dco_vencido", { expira: "now() - interval '1 second'" });
    expect(trocar("dco_vencido", "dsk_t_e", "dsr_e")).toBe("invalid_grant||");
  });

  it("quem consentiu deixou de ser admin antes da troca: recusa", () => {
    novoCodigo("dco_agente", { usuario: AGENTE_X });
    expect(trocar("dco_agente", "dsk_t_ag", "dsr_ag")).toBe("invalid_grant||");
  });
});

describe("renovação (refresh_token) com rotação", () => {
  it("rotaciona: o hash do token muda NA MESMA linha e o refresh velho morre", () => {
    novoCodigo("dco_ren");
    const [, token] = trocar("dco_ren", "dsk_t_ren0", "dsr_ren0").split("|");
    expect(renovar("dsr_ren0", "dsr_ren1", "dsk_t_ren1")).toBe("ok|mcp:read mcp:write");
    expect(sql(`select (token_hash = ${h("dsk_t_ren1")})::text from public.api_tokens where id = '${token}';`)).toBe("true");
    expect(sql(`select count(*) from public.api_tokens where token_hash = ${h("dsk_t_ren0")};`)).toBe("0");
    // Passada a tolerância de 60 s, o refresh anterior não vale mais.
    sql(`update public.mcp_oauth_concessoes set renovada_em = now() - interval '61 seconds' where api_token_id = '${token}';`);
    expect(renovar("dsr_ren0", "dsr_renX", "dsk_t_renX")).toBe("invalid_grant|");
    expect(sql(`select (token_hash = ${h("dsk_t_ren1")})::text from public.api_tokens where id = '${token}';`)).toBe("true");
  });

  it("resposta perdida: o refresh anterior renova de novo por 60 s — e a janela não se estende", () => {
    novoCodigo("dco_perdida");
    const [, token] = trocar("dco_perdida", "dsk_t_p0", "dsr_p0").split("|");
    expect(renovar("dsr_p0", "dsr_p1", "dsk_t_p1")).toBe("ok|mcp:read mcp:write");
    // O cliente não recebeu a resposta e repete com o refresh que ainda tem.
    expect(renovar("dsr_p0", "dsr_p2", "dsk_t_p2")).toBe("ok|mcp:read mcp:write");
    expect(sql(`select (token_hash = ${h("dsk_t_p2")})::text from public.api_tokens where id = '${token}';`)).toBe("true");
    // O refresh da resposta perdida (p1) foi superado e nunca foi o "anterior": morre.
    expect(renovar("dsr_p1", "dsr_p3", "dsk_t_p3")).toBe("invalid_grant|");
    // A repetição não renovou o relógio: a janela conta da PRIMEIRA rotação.
    sql(`update public.mcp_oauth_concessoes set renovada_em = renovada_em - interval '61 seconds' where api_token_id = '${token}';`);
    expect(renovar("dsr_p0", "dsr_p4", "dsk_t_p4")).toBe("invalid_grant|");
    expect(renovar("dsr_p2", "dsr_p5", "dsk_t_p5")).toBe("ok|mcp:read mcp:write");
  });

  it("pedir menos escopo vale; pedir mais, não", () => {
    expect(renovar("dsr_ren1", "dsr_ren2", "dsk_t_ren2", "'{mcp:read}'")).toBe("ok|mcp:read");
    expect(sql(`select (scopes @> '["mcp:write"]')::text from public.api_tokens where token_hash = ${h("dsk_t_ren2")};`)).toBe("false");
    novoCodigo("dco_so_leitura", { escopos: "{mcp:read}" });
    trocar("dco_so_leitura", "dsk_t_sl", "dsr_sl");
    expect(renovar("dsr_sl", "dsr_sl2", "dsk_t_sl2", "'{mcp:read,mcp:write}'")).toBe("invalid_scope|");
  });

  it("outro cliente não renova a concessão alheia", () => {
    expect(renovar("dsr_ren2", "dsr_ren3", "dsk_t_ren3", "null", CLIENTE_B)).toBe("invalid_grant|");
  });

  it("token revogado na tela de API Tokens: a renovação recusa e desliga a conexão", () => {
    novoCodigo("dco_tela");
    const [, token, concessao] = trocar("dco_tela", "dsk_t_tela", "dsr_tela").split("|");
    sql(`update public.api_tokens set revoked_at = now() where id = '${token}';`);
    expect(renovar("dsr_tela", "dsr_tela2", "dsk_t_tela2")).toBe("invalid_grant|");
    expect(sql(`select revogada_em is not null from public.mcp_oauth_concessoes where id = '${concessao}';`)).toBe("t");
  });

  it("quem autorizou deixou de ser admin: a renovação recusa e revoga o token", () => {
    const usuario = "93901111-0000-4000-8000-00000000000d";
    sql(`insert into auth.users (id, email) values ('${usuario}', 'dx9390@invariant.test') on conflict do nothing;
         insert into public.user_organizations (user_id, organization_id, role, accepted_at)
           values ('${usuario}', '${ORG_X}', 'admin', now()) on conflict do nothing;`);
    novoCodigo("dco_rebaixado", { usuario });
    const [motivo, token] = trocar("dco_rebaixado", "dsk_t_reb", "dsr_reb").split("|");
    expect(motivo).toBe("ok");
    sql(`update public.user_organizations set role = 'agent' where user_id = '${usuario}' and organization_id = '${ORG_X}';`);
    expect(renovar("dsr_reb", "dsr_reb2", "dsk_t_reb2")).toBe("invalid_grant|");
    expect(sql(`select revoked_at is not null from public.api_tokens where id = '${token}';`)).toBe("t");
  });
});

describe("revogação (RFC 7009)", () => {
  it("um cliente não revoga a conexão de outro; o dono revoga pelo access token", () => {
    novoCodigo("dco_rev");
    const [, token] = trocar("dco_rev", "dsk_t_rev", "dsr_rev").split("|");
    expect(sql(`select count(*) from public.fn_mcp_oauth_revogar(${h("dsk_t_rev")}, '${CLIENTE_B}');`)).toBe("0");
    expect(sql(`select revoked_at is null from public.api_tokens where id = '${token}';`)).toBe("t");
    expect(sql(`select count(*) from public.fn_mcp_oauth_revogar(${h("dsk_t_rev")}, '${CLIENTE_A}');`)).toBe("1");
    expect(sql(`select revoked_at is not null from public.api_tokens where id = '${token}';`)).toBe("t");
    expect(renovar("dsr_rev", "dsr_rev2", "dsk_t_rev2")).toBe("invalid_grant|");
  });
});

describe("poda", () => {
  it("leva código vencido há mais de um dia e cliente nunca usado há 30 dias; poupa o cliente com conexão", () => {
    const velho = "93902222-0000-4000-8000-0000000000ff";
    sql(`insert into public.mcp_oauth_clientes (id, client_id, nome, redirect_uris, created_at)
           values ('${velho}', 'dcc_${"v".repeat(32)}', 'Velho', '{${REDIRECT}}', now() - interval '31 days')
           on conflict do nothing;
         update public.mcp_oauth_clientes set created_at = now() - interval '31 days' where id = '${CLIENTE_A}';`);
    novoCodigo("dco_podar", { expira: "now() - interval '2 days'" });
    sql(`select public.fn_mcp_oauth_podar();`);
    expect(sql(`select count(*) from public.mcp_oauth_clientes where id = '${velho}';`)).toBe("0");
    expect(sql(`select count(*) from public.mcp_oauth_codigos where codigo_hash = ${h("dco_podar")};`)).toBe("0");
    expect(sql(`select count(*) from public.mcp_oauth_clientes where id = '${CLIENTE_A}';`)).toBe("1");
  });
});
