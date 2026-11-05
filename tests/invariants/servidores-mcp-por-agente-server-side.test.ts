/**
 * Servidores MCP por agente e OAuth por contato (migration 9095), medidos no
 * banco que o `baseline.sql` instala:
 *
 * 1. As TRÊS tabelas guardam segredo de terceiro (chave, `client_secret`,
 *    tokens do contato, `code_verifier`) e são server-side only: RLS ligada,
 *    nenhuma policy e privilégio NENHUM para `anon` e `authenticated` — o
 *    PostgREST responde `permission denied`, nem zero linhas. Um membro da
 *    própria organização X não lê, e muito menos um da Y [§5.2].
 * 2. O encerramento da conversa só AGENDA a revogação (`revogar_apos` = agora +
 *    retenção), sem HTTP; reabrir não agenda; credencial de outro contato ou de
 *    outra organização não é tocada.
 * 3. Anonimizar o contato apaga os pedidos pendentes e as credenciais já
 *    revogadas, e agenda a revogação imediata; excluir o contato leva tudo em
 *    cascata (a revogação no terceiro, antes, é da rota de exclusão).
 * 4. As funções dos gatilhos não são executáveis por `anon`/`authenticated`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELAS = ["ai_agent_mcp_servers", "mcp_oauth_pedidos", "contato_mcp_credenciais"] as const;

const ORG_X = "9095aaaa-0000-4000-8000-000000000001";
const ORG_Y = "9095aaaa-0000-4000-8000-000000000002";
const USUARIO_X = "9095bbbb-0000-4000-8000-000000000001";
const USUARIO_Y = "9095bbbb-0000-4000-8000-000000000002";
const AGENTE = "9095cccc-0000-4000-8000-000000000001";
const SERVIDOR = "9095dddd-0000-4000-8000-000000000001";
const SESSAO = "9095eeee-0000-4000-8000-000000000001";
const CONTATO_A = "9095ffff-0000-4000-8000-00000000000a";
const CONTATO_B = "9095ffff-0000-4000-8000-00000000000b";
const CONVERSA_A = "90951111-0000-4000-8000-00000000000a";
const CRED_A = "90952222-0000-4000-8000-00000000000a";
const CRED_B = "90952222-0000-4000-8000-00000000000b";

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

function privilegiosDe(tabela: string, papel: string): string {
  return sql(`
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'NENHUM')
      from information_schema.role_table_grants
     where table_schema = 'public' and table_name = '${tabela}' and grantee = '${papel}';
  `).trim();
}

const credencial = (id: string, contato: string) => `
  insert into public.contato_mcp_credenciais
    (id, organization_id, servidor_id, contact_id, access_token_encrypted, access_token_iv, access_token_tag, escopos)
  values ('${id}', '${ORG_X}', '${SERVIDOR}', '${contato}', '\\x01'::bytea, '\\x02'::bytea, '\\x03'::bytea, '{casa:leitura}')
  on conflict (id) do update set revogar_apos = null, revogado_em = null;`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USUARIO_X}', 'x9095@invariant.test'), ('${USUARIO_Y}', 'y9095@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_X}', 'inv-9095-x', 'Org X 9095', 'X'), ('${ORG_Y}', 'inv-9095-y', 'Org Y 9095', 'Y')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USUARIO_X}', '${ORG_X}', 'admin', now()), ('${USUARIO_Y}', '${ORG_Y}', 'admin', now())
      on conflict do nothing;
    do $s$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG_X}', 'inv-9095', '\\x00'::bytea);
    exception when unique_violation then null; end $s$;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_A}', '${ORG_X}', 'Contato A 9095'), ('${CONTATO_B}', '${ORG_X}', 'Contato B 9095')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA_A}', '${ORG_X}', '${CONTATO_A}', '${SESSAO}', 'open')
      on conflict do nothing;
    insert into public.ai_agents (id, organization_id, name, system_prompt)
      values ('${AGENTE}', '${ORG_X}', 'Agente 9095', '') on conflict (id) do nothing;
    insert into public.ai_agent_mcp_servers
      (id, organization_id, agent_id, nome, slug, endpoint, modo_autenticacao, retencao_apos_encerramento_horas)
    values ('${SERVIDOR}', '${ORG_X}', '${AGENTE}', 'Casa', 'casa', 'https://mcp.casa.test/mcp', 'oauth_por_contato', 2)
      on conflict (id) do nothing;
    ${credencial(CRED_A, CONTATO_A)}
    ${credencial(CRED_B, CONTATO_B)}
  `);
});

describe("as três tabelas do OAuth por contato são server-side only [§5.2]", () => {
  it("existem no baseline — controle positivo da sonda", () => {
    for (const t of TABELAS) {
      expect(
        sql(`select count(*) from information_schema.tables where table_schema='public' and table_name='${t}';`).trim(),
        `a 9095 não chegou ao baseline: ${t}`,
      ).toBe("1");
    }
  });

  it("`anon` e `authenticated` sem privilégio nenhum; `service_role` com o que usa", () => {
    for (const t of TABELAS) {
      expect(privilegiosDe(t, "anon"), t).toBe("NENHUM");
      expect(privilegiosDe(t, "authenticated"), t).toBe("NENHUM");
      const sr = privilegiosDe(t, "service_role");
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) expect(sr, t).toContain(p);
    }
  });

  it("RLS ligada e nenhuma policy", () => {
    for (const t of TABELAS) {
      expect(sql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass;`).trim(), t).toBe("t");
      expect(sql(`select count(*) from pg_policies where schemaname='public' and tablename='${t}';`).trim(), t).toBe("0");
    }
  });

  it("nem o admin da PRÓPRIA organização, nem o de outra, lê o token pelo PostgREST", () => {
    for (const usuario of [USUARIO_X, USUARIO_Y]) {
      const erro = erroSob("authenticated", "select access_token_encrypted from public.contato_mcp_credenciais", usuario);
      expect(erro, "authenticated leu a credencial SEM erro — o token está exposto").not.toBeNull();
      expect(erro).toContain("permission denied");
    }
    expect(erroSob("anon", "select chave_encrypted from public.ai_agent_mcp_servers")).toContain("permission denied");
    expect(erroSob("anon", "select code_verifier_encrypted from public.mcp_oauth_pedidos")).toContain("permission denied");
  });

  it("unique (servidor, contato): um token por servidor × contato", () => {
    expect(() => sql(credencial("90952222-0000-4000-8000-0000000000ff", CONTATO_A))).toThrow();
  });
});

describe("o encerramento AGENDA a revogação — trigger sem HTTP [§3]", () => {
  it("fechar a conversa de A grava revogar_apos = agora + retenção; B intacto", () => {
    sql(`update public.conversations set status = 'open' where id = '${CONVERSA_A}';
         update public.contato_mcp_credenciais set revogar_apos = null where id in ('${CRED_A}','${CRED_B}');
         update public.conversations set status = 'closed' where id = '${CONVERSA_A}';`);
    const horas = sql(`
      select round(extract(epoch from (revogar_apos - now())) / 3600)
        from public.contato_mcp_credenciais where id = '${CRED_A}';`).trim();
    expect(horas).toBe("2");
    expect(sql(`select revogar_apos is null from public.contato_mcp_credenciais where id = '${CRED_B}';`).trim()).toBe("t");
  });

  it("atualizar a conversa sem trocar o status não reagenda", () => {
    sql(`update public.contato_mcp_credenciais set revogar_apos = null where id = '${CRED_A}';
         update public.conversations set status = 'closed' where id = '${CONVERSA_A}';`);
    expect(sql(`select revogar_apos is null from public.contato_mcp_credenciais where id = '${CRED_A}';`).trim()).toBe("t");
  });

  it("as funções dos gatilhos não são executáveis por anon/authenticated", () => {
    for (const f of ["fn_mcp_agenda_revogacao_no_encerramento", "fn_mcp_contato_anonimizado_revoga_acessos"]) {
      for (const papel of ["anon", "authenticated"]) {
        expect(
          sql(`select has_function_privilege('${papel}', 'public.${f}()', 'execute');`).trim(),
          `${papel} executa ${f}`,
        ).toBe("f");
      }
    }
  });
});

describe("LGPD: anonimizar revoga e apaga os acessos do contato [§3]", () => {
  it("apaga os pedidos pendentes e agenda a revogação imediata", () => {
    sql(`
      insert into public.mcp_oauth_pedidos
        (id, organization_id, servidor_id, contact_id, code_verifier_encrypted, code_verifier_iv, code_verifier_tag, expira_em)
      values ('${"B".repeat(43)}', '${ORG_X}', '${SERVIDOR}', '${CONTATO_B}', '\\x01', '\\x02', '\\x03', now() + interval '10 minutes')
      on conflict (id) do nothing;
      update public.contato_mcp_credenciais set revogar_apos = null where id = '${CRED_B}';
      update public.contacts set is_anonymized = true, anonymized_at = now() where id = '${CONTATO_B}';
    `);
    expect(sql(`select count(*) from public.mcp_oauth_pedidos where contact_id = '${CONTATO_B}';`).trim()).toBe("0");
    expect(sql(`select revogar_apos <= now() from public.contato_mcp_credenciais where id = '${CRED_B}';`).trim()).toBe("t");
  });

  it("a credencial JÁ revogada (sem token) também some na anonimização — o cron só vê as vivas", () => {
    const contato = "9095ffff-0000-4000-8000-00000000000c";
    sql(`
      insert into public.contacts (id, organization_id, display_name)
        values ('${contato}', '${ORG_X}', 'Contato C 9095') on conflict do nothing;
      insert into public.contato_mcp_credenciais (organization_id, servidor_id, contact_id, escopos, revogado_em)
        values ('${ORG_X}', '${SERVIDOR}', '${contato}', '{casa:leitura}', now())
        on conflict do nothing;
    `);
    // Controle positivo: a linha revogada existe antes.
    expect(sql(`select count(*) from public.contato_mcp_credenciais where contact_id = '${contato}';`).trim()).toBe("1");
    sql(`update public.contacts set is_anonymized = true, anonymized_at = now() where id = '${contato}';`);
    expect(sql(`select count(*) from public.contato_mcp_credenciais where contact_id = '${contato}';`).trim()).toBe("0");
  });

  it("excluir o servidor leva credenciais e pedidos em cascata", () => {
    sql(`
      insert into public.ai_agent_mcp_servers (id, organization_id, agent_id, nome, slug, endpoint, modo_autenticacao)
      values ('9095dddd-0000-4000-8000-000000000002', '${ORG_X}', '${AGENTE}', 'Outro', 'outro', 'https://o.test/mcp', 'oauth_por_contato')
      on conflict (id) do nothing;
      insert into public.contato_mcp_credenciais
        (organization_id, servidor_id, contact_id, access_token_encrypted, access_token_iv, access_token_tag)
      values ('${ORG_X}', '9095dddd-0000-4000-8000-000000000002', '${CONTATO_A}', '\\x01', '\\x02', '\\x03')
      on conflict do nothing;
      delete from public.ai_agent_mcp_servers where id = '9095dddd-0000-4000-8000-000000000002';
    `);
    expect(
      sql(`select count(*) from public.contato_mcp_credenciais where servidor_id = '9095dddd-0000-4000-8000-000000000002';`).trim(),
    ).toBe("0");
  });

  it("escrita delegada só existe com oauth_por_contato (CHECK)", () => {
    expect(() =>
      sql(`insert into public.ai_agent_mcp_servers (organization_id, agent_id, nome, slug, endpoint, modo_autenticacao, escrita_delegada)
           values ('${ORG_X}', '${AGENTE}', 'X', 'x', 'https://x.test/mcp', 'chave_estatica', true);`),
    ).toThrow();
  });

  it("endereço com querystring ou fragmento é recusado pelo banco (segredo no endereço)", () => {
    expect(() =>
      sql(`insert into public.ai_agent_mcp_servers (organization_id, agent_id, nome, slug, endpoint)
           values ('${ORG_X}', '${AGENTE}', 'Q', 'q', 'https://x.test/mcp?token=abc');`),
    ).toThrow();
  });
});
