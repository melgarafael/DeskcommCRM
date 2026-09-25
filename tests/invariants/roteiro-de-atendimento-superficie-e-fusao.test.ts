import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * O ROTEIRO DE ATENDIMENTO NÃO PODE PARAR A VARREDURA NEM O UPDATE (0394 —
 * revisão adversarial do #1559).
 *
 *   1. SUPERFÍCIE IMUTÁVEL. A policy de `followup_flow_pointers` é só de tenant:
 *      um VIEWER, pelo PostgREST, levava um fluxo de silêncio ativo a
 *      'atendimento'; o `trg_enrollment_superficie_coerente` passava a recusar
 *      cada inscrição e a varredura de silêncio abortava a cada tick, para todas
 *      as empresas. `trg_superficie_do_fluxo_imutavel` recusa (23514).
 *   2. ROTEIRO SÓ MANUAL. Um PATCH de gatilho levava um roteiro publicado de
 *      Manual para Silêncio. CHECK `followup_flow_pointers_roteiro_so_manual`.
 *   3. FUSÃO POR NONO DÍGITO. O bloco da 0198 no baseline roda a cada
 *      `update.sh` e reapontava `followup_enrollments` sem deduplicar o roteiro
 *      vivo: dois contatos fundidos com roteiro vivo davam 23505 e o comando
 *      inteiro falhava. O teste executa os comandos REAIS lidos do baseline.
 *
 * Arquivo próprio (e não um caso a mais em `roteiro-de-atendimento-rls-lgpd`):
 * `tests/invariants` é congelado para editar arquivo existente.
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

const TENTA = `
  create or replace function pg_temp.tenta(q text) returns text language plpgsql as $f$
  begin execute q; return 'ok'; exception when others then return sqlstate; end $f$;`;

/** SQLSTATE do comando feito pelo dono do banco, ou `ok`. */
function tenta(comando: string): string {
  return ultima(sql(`${TENTA} select pg_temp.tenta($q$ ${comando} $q$);`));
}

/** SQLSTATE do comando feito COMO o usuário (role authenticated + claims, como o PostgREST), ou `ok`. */
function tentaComo(usuario: string, comando: string): string {
  return ultima(
    sql(`
      ${TENTA}
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated"}', false);
      select pg_temp.tenta($q$ ${comando} $q$);
    `),
  );
}

const ORG = "03941000-0000-4000-8000-00000000000a";
const ADMIN = "03941000-1111-4000-8000-00000000000a";
const VIEWER = "03941000-1111-4000-8000-0000000000fa";
const ROTEIRO = "03941000-3333-4000-8000-00000000000a";
const VERSAO = "03941000-4444-4000-8000-00000000000a";
const FOLLOWUP = "03941000-3333-4000-8000-0000000000fa";
const SEM_NONO = "03941000-5555-4000-8000-000000000012";
const COM_NONO = "03941000-5555-4000-8000-000000000013";

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

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN}', 'roteiro-fusao-admin@invariant.test'), ('${VIEWER}', 'roteiro-fusao-viewer@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'roteiro-0394-fusao', 'Roteiro Fusão', 'Roteiro Fusão');
    insert into public.user_organizations (organization_id, user_id, role, accepted_at) values
      ('${ORG}', '${ADMIN}', 'admin', now()), ('${ORG}', '${VIEWER}', 'viewer', now());
    -- O follow-up fica com o gatilho padrão (manual): um gatilho de silêncio ATIVO
    -- aqui seria varrido pelos outros invariantes que rodam no mesmo banco.
    insert into public.followup_flow_pointers (id, organization_id, name, status, surface) values
      ('${ROTEIRO}', '${ORG}', 'Cadastro', 'active', 'atendimento'),
      ('${FOLLOWUP}', '${ORG}', 'Retomada', 'active', 'followup');
    insert into public.followup_flow_versions (id, organization_id, pointer_id, graph)
      values ('${VERSAO}', '${ORG}', '${ROTEIRO}', '${GRAFO}'::jsonb);
    update public.followup_flow_pointers set active_version_id = '${VERSAO}' where id = '${ROTEIRO}';
  `);
});

describe("superfície imutável e roteiro só com gatilho manual", () => {
  it("controle positivo: o viewer ALCANÇA a linha (a policy é só de tenant) — muda o nome", () => {
    expect(
      tentaComo(VIEWER, `update public.followup_flow_pointers set name = 'Retomada 2' where id = '${FOLLOWUP}'`),
    ).toBe("ok");
    expect(sql(`select name from public.followup_flow_pointers where id = '${FOLLOWUP}';`)).toBe("Retomada 2");
  });

  it("⭐ o viewer NÃO leva um fluxo de follow-up a 'atendimento' (23514)", () => {
    expect(
      tentaComo(VIEWER, `update public.followup_flow_pointers set surface = 'atendimento' where id = '${FOLLOWUP}'`),
    ).toBe("23514");
    expect(sql(`select surface from public.followup_flow_pointers where id = '${FOLLOWUP}';`)).toBe("followup");
  });

  it("nem o admin nem o dono do banco devolvem um roteiro a follow-up", () => {
    expect(tentaComo(ADMIN, `update public.followup_flow_pointers set surface = 'followup' where id = '${ROTEIRO}'`)).toBe("23514");
    expect(tenta(`update public.followup_flow_pointers set surface = 'followup' where id = '${ROTEIRO}'`)).toBe("23514");
  });

  it("⭐ roteiro publicado não troca Manual por Silêncio (o PATCH de gatilho)", () => {
    expect(
      tenta(`update public.followup_flow_pointers
               set trigger_config = '{"kind":"silence","params":{"threshold_minutes":60}}'::jsonb
             where id = '${ROTEIRO}'`),
    ).toBe("23514");
  });

  it("nem nasce roteiro com gatilho de relógio", () => {
    expect(
      tenta(`insert into public.followup_flow_pointers (organization_id, name, surface, trigger_config)
             values ('${ORG}', 'Roteiro de silêncio', 'atendimento', '{"kind":"silence","params":{"threshold_minutes":60}}'::jsonb)`),
    ).toBe("23514");
  });
});

describe("fusão por nono dígito com roteiro vivo nos dois contatos (update.sh)", () => {
  /**
   * Os comandos REAIS do baseline que tocam `followup_enrollments` na fusão: a
   * deduplicação do follow-up (que já existia), a do roteiro vivo (0394) e o
   * reapontamento. Só eles: os demais reapontamentos do bloco dependem das
   * deduplicações de conversa que vêm antes, e não são o que se mede aqui.
   */
  function comandosDoBaseline(): string {
    const texto = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    const roteiro = texto.indexOf("-- Roteiro de atendimento vivo ('coletando', 0394): UM por contato");
    const followup = texto.lastIndexOf(
      "update public.followup_enrollments e\n   set status = 'cancelled', cancel_reason = 'nono_digito_merge'",
      roteiro,
    );
    const reaponta =
      "update public.followup_enrollments t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;";
    const fim = texto.indexOf(reaponta, roteiro);
    expect(followup).toBeGreaterThan(0);
    expect(roteiro).toBeGreaterThan(followup);
    expect(fim).toBeGreaterThan(roteiro);
    const dedupFollowup = texto.slice(followup, texto.indexOf(";\n", followup) + 1);
    return [dedupFollowup, texto.slice(roteiro, fim + reaponta.length)].join("\n");
  }

  function eventosDeCancelamento(): string {
    return sql(`
      select count(*) from public.followup_enrollment_events ev
        join public.followup_enrollments e on e.id = ev.enrollment_id
       where e.contact_id = '${COM_NONO}' and ev.event_type = 'roteiro_cancelado';`);
  }

  it("⭐ fica o roteiro mais novo, o excedente é encerrado com evento, e o reapontamento não dá 23505", () => {
    sql(`
      insert into public.contacts (id, organization_id, name, phone_number) values
        ('${SEM_NONO}', '${ORG}', 'Contato 12', '+551188887777'),
        ('${COM_NONO}', '${ORG}', 'Contato 13', '+5511988887777');
      insert into public.followup_enrollments
        (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, started_at)
      values
        ('${ORG}', '${ROTEIRO}', '${VERSAO}', '${SEM_NONO}', 't', 'coletando', null, now() - interval '2 days'),
        ('${ORG}', '${ROTEIRO}', '${VERSAO}', '${COM_NONO}', 't', 'coletando', null, now() - interval '1 day');
      update public.contacts set is_merged_into = '${COM_NONO}', merged_at = now() where id = '${SEM_NONO}';
    `);
    sql(comandosDoBaseline());
    expect(
      sql(`select count(*) from public.followup_enrollments where contact_id = '${COM_NONO}' and status = 'coletando';`),
    ).toBe("1");
    expect(
      sql(`select count(*) from public.followup_enrollments
            where contact_id = '${COM_NONO}' and status = 'cancelled' and cancel_reason = 'nono_digito_merge'
              and started_at < now() - interval '36 hours';`),
    ).toBe("1");
    expect(eventosDeCancelamento()).toBe("1");
  });

  it("reaplicar (o próximo update.sh) não muda nada", () => {
    sql(comandosDoBaseline());
    expect(eventosDeCancelamento()).toBe("1");
    expect(
      sql(`select count(*) from public.followup_enrollments where contact_id = '${COM_NONO}' and status = 'coletando';`),
    ).toBe("1");
  });
});
