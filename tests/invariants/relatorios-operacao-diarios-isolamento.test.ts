import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * Prova da migration 9400 (`relatorios_operacao_diarios`): o relatório de uma
 * organização não aparece para a outra, só manager ou acima o lê (ele reúne as
 * conversas da equipe inteira), a sessão não escreve, e a unicidade
 * `(organization_id, dia)` é o que segura o cron idempotente. Identificadores
 * exclusivos desta fixture.
 */
const ORG_A = "c9400000-0000-4000-8000-000000000001";
const ORG_B = "c9400000-0000-4000-8000-000000000002";
const MANAGER_A = "c9400000-1111-4000-8000-000000000001";
const MANAGER_B = "c9400000-1111-4000-8000-000000000002";
const AGENT_A = "c9400000-1111-4000-8000-000000000003";
const ADMIN_A = "c9400000-1111-4000-8000-000000000004";
const VIEWER_A = "c9400000-1111-4000-8000-000000000005";

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values
      ('${MANAGER_A}','relatorio-gestor-a@invariant.test'),
      ('${MANAGER_B}','relatorio-gestor-b@invariant.test'),
      ('${AGENT_A}','relatorio-atendente-a@invariant.test'),
      ('${ADMIN_A}','relatorio-admin-a@invariant.test'),
      ('${VIEWER_A}','relatorio-viewer-a@invariant.test');
    insert into organizations(id,slug,legal_name,display_name) values
      ('${ORG_A}','relatorio-9400-a','Relatório sintético A','Relatório A'),
      ('${ORG_B}','relatorio-9400-b','Relatório sintético B','Relatório B');
    insert into user_organizations(user_id,organization_id,role,accepted_at) values
      ('${MANAGER_A}','${ORG_A}','manager',now()),
      ('${MANAGER_B}','${ORG_B}','manager',now()),
      ('${AGENT_A}','${ORG_A}','agent',now()),
      ('${ADMIN_A}','${ORG_A}','admin',now()),
      ('${VIEWER_A}','${ORG_A}','viewer',now());
    insert into relatorios_operacao_diarios(organization_id,dia,fuso,gerado_por,conteudo) values
      ('${ORG_A}','2026-11-14','Asia/Beirut','cron','{"versao":1,"de":"A"}'),
      ('${ORG_A}','2026-11-15','Asia/Beirut','usuario','{"versao":1,"de":"A"}'),
      ('${ORG_B}','2026-11-15','UTC','cron','{"versao":1,"de":"B"}');
  `);
});

describe("relatorios_operacao_diarios: isolamento entre organizações", () => {
  it.each([
    [MANAGER_A, ORG_A, ORG_B, 2],
    [ADMIN_A, ORG_A, ORG_B, 2],
    [MANAGER_B, ORG_B, ORG_A, 1],
  ])("%s lê os relatórios da própria organização e nenhum da outra", (user, propria, outra, n) => {
    expect(countAs(user, `select count(*) from relatorios_operacao_diarios where organization_id='${propria}'`)).toBe(n);
    expect(countAs(user, `select count(*) from relatorios_operacao_diarios where organization_id='${outra}'`)).toBe(0);
    expect(countAs(user, `select count(*) from relatorios_operacao_diarios`)).toBe(n);
  });

  it("atendente (agent) não lê o relatório da equipe, nem da própria organização", () => {
    expect(countAs(AGENT_A, `select count(*) from relatorios_operacao_diarios`)).toBe(0);
  });

  it("quem só lê (viewer) não lê o relatório guardado, nem pelo dia nem pela tabela inteira", () => {
    expect(countAs(VIEWER_A, `select count(*) from relatorios_operacao_diarios`)).toBe(0);
    expect(countAs(VIEWER_A, `select count(*) from relatorios_operacao_diarios where organization_id='${ORG_A}' and dia='2026-11-15'`)).toBe(0);
    // Controle positivo da MESMA linha: o gestor da organização a lê.
    expect(countAs(MANAGER_A, `select count(*) from relatorios_operacao_diarios where organization_id='${ORG_A}' and dia='2026-11-15'`)).toBe(1);
  });

  it("a sessão não escreve: sem GRANT de INSERT/UPDATE/DELETE para authenticated", () => {
    const out = sql(`
      select has_table_privilege('authenticated','public.relatorios_operacao_diarios','INSERT')::text
        || ',' || has_table_privilege('authenticated','public.relatorios_operacao_diarios','UPDATE')::text
        || ',' || has_table_privilege('authenticated','public.relatorios_operacao_diarios','DELETE')::text
        || ',' || has_table_privilege('anon','public.relatorios_operacao_diarios','SELECT')::text
        || ',' || has_table_privilege('authenticated','public.relatorios_operacao_diarios','SELECT')::text;
    `);
    expect(out.split("\n").at(-1)).toBe("false,false,false,false,true");
  });

  it("nem o gestor da outra organização consegue apagar pela sessão", () => {
    let recusado = false;
    try {
      writeCountAs(MANAGER_B, `delete from relatorios_operacao_diarios where organization_id='${ORG_A}'`);
    } catch (err) {
      recusado = /permission denied/.test(String((err as { stderr?: string }).stderr ?? err));
    }
    expect(recusado).toBe(true);
    expect(sql(`select count(*) from relatorios_operacao_diarios where organization_id='${ORG_A}'`)).toBe("2");
  });

  it("um dia por organização: o segundo insert do cron (on conflict do nothing) não duplica", () => {
    const out = sql(`
      insert into relatorios_operacao_diarios(organization_id,dia,fuso,gerado_por,conteudo)
      values ('${ORG_A}','2026-11-15','Asia/Beirut','cron','{"versao":1,"de":"de novo"}')
      on conflict (organization_id, dia) do nothing;
      select count(*) || ':' || max(conteudo->>'de') from relatorios_operacao_diarios where organization_id='${ORG_A}' and dia='2026-11-15';
    `);
    expect(out.split("\n").at(-1)).toBe("1:A");
  });

  it("LGPD: a tabela não tem coluna de texto livre — só o jsonb de fatos e metadados", () => {
    const out = sql(`
      select string_agg(column_name, ',' order by column_name)
        from information_schema.columns
       where table_schema='public' and table_name='relatorios_operacao_diarios';
    `);
    expect(out.split("\n").at(-1)).toBe("conteudo,dia,fuso,gerado_em,gerado_por,id,organization_id");
  });

  it("gerado_por fora do vocabulário é recusado pelo CHECK", () => {
    const out = sql(`do $t$
      begin
        insert into relatorios_operacao_diarios(organization_id,dia,fuso,gerado_por,conteudo)
        values ('${ORG_B}','2026-11-10','UTC','robo','{}');
        raise exception 'gerado_por inválido foi aceito';
      exception when check_violation then null;
      end $t$;
      select 'recusado';`);
    expect(out.split("\n").at(-1)).toBe("recusado");
  });

  it("conversa NOVA é a que não tinha mensagem do cliente antes do dia; grupo e outra organização ficam de fora", () => {
    const SESSAO = "c9400000-2222-4000-8000-000000000001";
    const [K1, K2, K3] = ["1", "2", "3"].map((n) => `c9400000-3333-4000-8000-00000000000${n}`);
    const [C1, C2, C3] = ["1", "2", "3"].map((n) => `c9400000-4444-4000-8000-00000000000${n}`);
    sql(`
      insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG_A}', 'relatorio-9400-a', '\\x00'::bytea);
      insert into contacts (id, organization_id, display_name) values
        ('${K1}','${ORG_A}','Antiga'), ('${K2}','${ORG_A}','Nova'), ('${K3}','${ORG_A}','Grupo');
      insert into conversations (id, organization_id, contact_id, channel_session_id, status, channel, is_group) values
        ('${C1}','${ORG_A}','${K1}','${SESSAO}','open','whatsapp',false),
        ('${C2}','${ORG_A}','${K2}','${SESSAO}','open','instagram',false),
        ('${C3}','${ORG_A}','${K3}','${SESSAO}','open','whatsapp',true);
      insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_at) values
        ('${ORG_A}','${C1}','${SESSAO}','${K1}','text','inbound','received','2026-11-13T10:00:00Z'),
        ('${ORG_A}','${C1}','${SESSAO}','${K1}','text','inbound','received','2026-11-15T08:00:00Z'),
        ('${ORG_A}','${C2}','${SESSAO}','${K2}','text','outbound','sent','2026-11-14T09:00:00Z'),
        ('${ORG_A}','${C2}','${SESSAO}','${K2}','text','inbound','received','2026-11-15T09:00:00Z'),
        ('${ORG_A}','${C2}','${SESSAO}','${K2}','text','inbound','received','2026-11-15T09:05:00Z'),
        ('${ORG_A}','${C3}','${SESSAO}','${K3}','text','inbound','received','2026-11-15T09:00:00Z');
    `);
    const chamada = (org: string) =>
      `select coalesce(string_agg(channel || ':' || entradas || ':' || nova, ',' order by channel), 'nenhuma') as r
         from fn_operacao_conversas_com_entrada('${org}', '2026-11-14T22:00:00Z', '2026-11-15T22:00:00Z')`;
    expect(sql(`${chamada(ORG_A)};`).split("\n").at(-1)).toBe("instagram:2:true,whatsapp:1:false");
    // Pela sessão do gestor da OUTRA organização, a RLS não devolve nada.
    const comoB = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MANAGER_B}"}', false);
      ${chamada(ORG_A)};
    `);
    expect(comoB.split("\n").at(-1)).toBe("nenhuma");
    // E pela sessão do gestor da PRÓPRIA organização (security invoker: a RLS deixa ver).
    const comoA = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', false);
      ${chamada(ORG_A)};
    `);
    expect(comoA.split("\n").at(-1)).toBe("instagram:2:true,whatsapp:1:false");
  });

  it("a função das conversas com entrada não é alcançável pela anon key", () => {
    const out = sql(`
      select has_function_privilege('anon','public.fn_operacao_conversas_com_entrada(uuid,timestamptz,timestamptz,integer)','EXECUTE')::text
        || ',' || has_function_privilege('authenticated','public.fn_operacao_conversas_com_entrada(uuid,timestamptz,timestamptz,integer)','EXECUTE')::text
        || ',' || (select prosecdef::text from pg_proc where proname='fn_operacao_conversas_com_entrada');
    `);
    expect(out.split("\n").at(-1)).toBe("false,true,false");
  });
});
