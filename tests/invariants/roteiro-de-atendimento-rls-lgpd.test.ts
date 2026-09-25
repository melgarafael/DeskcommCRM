import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * O ROTEIRO DE ATENDIMENTO NO BANCO (migration 0394, port do #1130 de @vgamkt).
 *
 * O roteiro não tem tabela própria: a execução é `followup_enrollments` com
 * status 'coletando', a trilha é `followup_enrollment_events` (sem o valor) e a
 * resposta mora em `contacts.custom_fields`. Este invariante prova, num
 * Postgres com o `baseline.sql` aplicado, o que a escolha promete:
 *
 *   1. ISOLAMENTO — o admin da empresa B não lê o roteiro, a trilha nem as
 *      respostas da A (e o da A lê: controle positivo); o roteador da B não
 *      aponta roteiro da A (FK composta).
 *   2. VAGA PRÓPRIA — um roteiro 'coletando' por contato, e ele NÃO ocupa a
 *      vaga do follow-up (bloqueio 3 da prova prática: quem parava no meio do
 *      roteiro nunca recebia a retomada).
 *   3. SUPERFÍCIE E STATUS COERENTES — roteiro só como 'coletando'/terminal;
 *      'coletando' só em roteiro (`trg_enrollment_superficie_coerente`).
 *   4. LGPD NOS DOIS CAMINHOS — pela tela (o UPDATE que `fn_lgpd_anonymize_contact`
 *      faz; a RPC exige sessão com MFA, como no invariante da 0391) e pelo
 *      pedido formal (`fn_lgpd_cascade_redact_contact`): as respostas somem, o
 *      roteiro vivo é encerrado, e a trilha não carrega o que foi respondido.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

function ultima(out: string): string {
  const linhas = out.split("\n");
  return linhas[linhas.length - 1] ?? "";
}

/** SQLSTATE do comando, ou `ok`. */
function tenta(comando: string): string {
  return ultima(
    sql(`
      create or replace function pg_temp.tenta(q text) returns text language plpgsql as $f$
      begin execute q; return 'ok'; exception when others then return sqlstate; end $f$;
      select pg_temp.tenta($q$ ${comando} $q$);
    `),
  );
}

/** Uma contagem feita COMO o usuário (role authenticated + claims), como o PostgREST faz. */
function contaComo(usuario: string, consulta: string): number {
  const out = ultima(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated"}', false);
      ${consulta}
    `),
  );
  if (!/^\d+$/.test(out)) throw new Error(`saída inesperada: ${out}`);
  return Number(out);
}

const ORG_A = "03940000-0000-4000-8000-00000000000a";
const ORG_B = "03940000-0000-4000-8000-00000000000b";
const ADMIN_A = "03940000-1111-4000-8000-00000000000a";
const ADMIN_B = "03940000-1111-4000-8000-00000000000b";
const SESSAO_B = "03940000-2222-4000-8000-00000000000b";
const ROTEIRO_A = "03940000-3333-4000-8000-00000000000a";
const VERSAO_A = "03940000-4444-4000-8000-00000000000a";
const FOLLOWUP_A = "03940000-3333-4000-8000-0000000000fa";
const VERSAO_FOLLOWUP_A = "03940000-4444-4000-8000-0000000000fa";
const VIA_TELA = "03940000-5555-4000-8000-000000000001";
const VIA_PEDIDO = "03940000-5555-4000-8000-000000000002";
const VAGA = "03940000-5555-4000-8000-000000000003";

const NOME = "Bruno Almeida Feliz";
const GRAFO = JSON.stringify({
  nodes: [
    { id: "t", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    {
      id: "c1",
      type: "collect",
      label: "Nome",
      position: { x: 0, y: 0 },
      config: { key: "nome_completo", label: "Nome completo", type: "text", required: true, permite_correcao: true },
    },
    { id: "e", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [
    { id: "a", source: "t", target: "c1", priority: 0, condition: { type: "always" } },
    { id: "b", source: "c1", target: "e", priority: 0, condition: { type: "always" } },
  ],
});

function roteiroColetando(contato: string): string {
  return `
    insert into public.followup_enrollments
      (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
    values ('${ORG_A}', '${ROTEIRO_A}', '${VERSAO_A}', '${contato}', 't', 'coletando', null)`;
}

beforeAll(() => {
  const contatos = [VIA_TELA, VIA_PEDIDO, VAGA]
    .map(
      (c) => `
    insert into public.contacts (id, organization_id, name, display_name, custom_fields)
      values ('${c}', '${ORG_A}', '${NOME}', '${NOME}', '{"nome_completo":"${NOME}","cidade":"Campinas"}'::jsonb);`,
    )
    .join("\n");
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_A}', 'roteiro-a@invariant.test'), ('${ADMIN_B}', 'roteiro-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'roteiro-0394-a', 'Roteiro A', 'Roteiro A'),
      ('${ORG_B}', 'roteiro-0394-b', 'Roteiro B', 'Roteiro B');
    insert into public.user_organizations (organization_id, user_id, role, accepted_at) values
      ('${ORG_A}', '${ADMIN_A}', 'admin', now()), ('${ORG_B}', '${ADMIN_B}', 'admin', now());
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSAO_B}', '${ORG_B}', 'roteiro-0394-b', '\\x00'::bytea);

    insert into public.followup_flow_pointers (id, organization_id, name, status, surface)
      values ('${ROTEIRO_A}', '${ORG_A}', 'Cadastro', 'active', 'atendimento'),
             ('${FOLLOWUP_A}', '${ORG_A}', 'Retomada', 'active', 'followup');
    insert into public.followup_flow_versions (id, organization_id, pointer_id, graph)
      values ('${VERSAO_A}', '${ORG_A}', '${ROTEIRO_A}', '${GRAFO}'::jsonb),
             ('${VERSAO_FOLLOWUP_A}', '${ORG_A}', '${FOLLOWUP_A}', '${GRAFO}'::jsonb);
    update public.followup_flow_pointers set active_version_id = '${VERSAO_A}' where id = '${ROTEIRO_A}';
    update public.followup_flow_pointers set active_version_id = '${VERSAO_FOLLOWUP_A}' where id = '${FOLLOWUP_A}';

    ${contatos}
    ${roteiroColetando(VIA_TELA)};
    ${roteiroColetando(VIA_PEDIDO)};
    insert into public.followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, payload)
      select '${ORG_A}', e.id, 'c1', 'roteiro_resposta', '{"campo":"nome_completo","origem":"validador"}'::jsonb
        from public.followup_enrollments e
       where e.organization_id = '${ORG_A}' and e.status = 'coletando';
  `);
});

describe("isolamento entre empresas", () => {
  it("o admin da A vê o roteiro, a trilha e as respostas (controle positivo)", () => {
    expect(contaComo(ADMIN_A, `select count(*) from public.followup_enrollments where organization_id = '${ORG_A}' and status = 'coletando';`)).toBe(2);
    expect(contaComo(ADMIN_A, `select count(*) from public.followup_enrollment_events where organization_id = '${ORG_A}' and event_type like 'roteiro_%';`)).toBe(2);
    expect(contaComo(ADMIN_A, `select count(*) from public.contacts where id = '${VIA_TELA}' and custom_fields ? 'nome_completo';`)).toBe(1);
  });

  it("o admin da B não vê nada disso", () => {
    expect(contaComo(ADMIN_B, `select count(*) from public.followup_enrollments where organization_id = '${ORG_A}';`)).toBe(0);
    expect(contaComo(ADMIN_B, `select count(*) from public.followup_enrollment_events where organization_id = '${ORG_A}';`)).toBe(0);
    expect(contaComo(ADMIN_B, `select count(*) from public.contacts where organization_id = '${ORG_A}';`)).toBe(0);
  });

  it("o roteador da B não aponta roteiro da A (FK composta)", () => {
    const setup = sql(`
      insert into public.ai_agents (id, organization_id, name, system_prompt)
        values ('03940000-6666-4000-8000-00000000000b', '${ORG_B}', 'Agente B', 'x') on conflict do nothing;
      insert into public.ai_routers (id, organization_id, name, channel_session_id)
        values ('03940000-7777-4000-8000-00000000000b', '${ORG_B}', 'Roteador B', '${SESSAO_B}') on conflict do nothing;
      select 'ok';
    `);
    expect(ultima(setup)).toBe("ok");
    expect(
      tenta(`insert into public.ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description, flow_pointer_id)
             values ('${ORG_B}', '03940000-7777-4000-8000-00000000000b', '03940000-6666-4000-8000-00000000000b',
                     'troca', 'quer dar a moto na troca', '${ROTEIRO_A}')`),
    ).toBe("23503");
  });
});

describe("a vaga do roteiro é dele, não do follow-up", () => {
  it("um segundo roteiro 'coletando' no mesmo contato é recusado (23505)", () => {
    expect(tenta(roteiroColetando(VIA_TELA))).toBe("23505");
  });

  it("⭐ o follow-up vivo convive com o roteiro no mesmo contato (bloqueio 3 da prova)", () => {
    expect(tenta(roteiroColetando(VAGA))).toBe("ok");
    expect(
      tenta(`insert into public.followup_enrollments
               (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
             values ('${ORG_A}', '${FOLLOWUP_A}', '${VERSAO_FOLLOWUP_A}', '${VAGA}', 't', 'active', now())`),
    ).toBe("ok");
  });
});

describe("superfície e status andam juntos", () => {
  it("roteiro de atendimento como 'active' é recusado (23514)", () => {
    expect(
      tenta(`insert into public.followup_enrollments
               (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
             values ('${ORG_A}', '${ROTEIRO_A}', '${VERSAO_A}', '${VIA_PEDIDO}', 't', 'active', now())`),
    ).toBe("23514");
  });

  it("'coletando' num fluxo de follow-up é recusado (23514)", () => {
    expect(
      tenta(`insert into public.followup_enrollments
               (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
             values ('${ORG_A}', '${FOLLOWUP_A}', '${VERSAO_FOLLOWUP_A}', '${VIA_PEDIDO}', 't', 'coletando', null)`),
    ).toBe("23514");
  });
});

describe("LGPD: anonimizar apaga as respostas e encerra o roteiro, pelos dois caminhos", () => {
  function residuo(contato: string): string {
    return sql(`
      select coalesce(string_agg(onde, ',' order by onde), '') from (
        select 'custom_fields' as onde from public.contacts
         where id = '${contato}' and custom_fields <> '{}'::jsonb
        union
        select 'roteiro_vivo' from public.followup_enrollments
         where contact_id = '${contato}' and status = 'coletando'
        union
        select 'trilha_com_valor' from public.followup_enrollment_events ev
          join public.followup_enrollments e on e.id = ev.enrollment_id
         where e.contact_id = '${contato}' and ev.payload::text ilike '%Bruno%'
      ) r;
    `);
  }

  it("ANTES: respostas no contato e roteiro vivo (controle positivo)", () => {
    expect(residuo(VIA_TELA)).toBe("custom_fields,roteiro_vivo");
    expect(residuo(VIA_PEDIDO)).toBe("custom_fields,roteiro_vivo");
  });

  it("⭐ pela TELA (o UPDATE de fn_lgpd_anonymize_contact)", () => {
    sql(`
      update public.contacts set
        name = null, display_name = 'Contato Anonimizado #03940000',
        email = null, phone_number = null, cpf_encrypted = null, cpf_hash = null, birthdate = null,
        is_anonymized = true, anonymized_at = now(), updated_at = now()
      where organization_id = '${ORG_A}' and id = '${VIA_TELA}';
    `);
    expect(residuo(VIA_TELA)).toBe("");
    expect(
      sql(`select status || '|' || cancel_reason from public.followup_enrollments where contact_id = '${VIA_TELA}' and pointer_id = '${ROTEIRO_A}';`),
    ).toBe("cancelled|Contato anonimizado (LGPD)");
  });

  it("⭐ pelo PEDIDO formal (fn_lgpd_cascade_redact_contact)", () => {
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG_A}', '${VIA_PEDIDO}', null);`);
    expect(residuo(VIA_PEDIDO)).toBe("");
  });

  it("depois do esquecimento, o roteiro não regrava: contato anonimizado não recebe resposta", () => {
    sql(`
      update public.contacts
         set custom_fields = coalesce(custom_fields, '{}'::jsonb) || jsonb_build_object('nome_completo', 'Bruno')
       where organization_id = '${ORG_A}' and id = '${VIA_TELA}' and not coalesce(is_anonymized, false);
    `);
    expect(residuo(VIA_TELA)).toBe("");
  });
});
