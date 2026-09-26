import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import {
  RETENCAO_CANDIDATOS_GOLDEN_DIAS_PADRAO,
  RETENCAO_CANDIDATOS_GOLDEN_DIAS_PISO,
} from "@/lib/retencao/politica";

/**
 * OS CANDIDATOS AO GOLDEN SET (migration 0428, issue #1695) — isolamento,
 * escrita, forma da linha, deduplicação do retry e prazo.
 *
 * Arquivo próprio pelo mesmo motivo de `jev-observacoes.test.ts`: acrescentar a
 * tabela a `TABLES` seria editar um invariante congelado. A varredura
 * `rls-completude-varredura.test.ts` aponta para cá em `PROVA_PROPRIA`.
 *
 * Conectar como `postgres` mediria NADA (rolbypassrls = t): aqui é `set role
 * authenticated` + `request.jwt.claims`, o caminho da produção.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ultimaLinha = (saida: string) => saida.split("\n").pop() ?? "";

function contarComo(usuario: string, consulta: string): number {
  const saida = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
    ${consulta}
  `);
  const n = ultimaLinha(saida);
  if (!/^\d+$/.test(n)) throw new Error(`saída inesperada do psql: ${saida}`);
  return Number(n);
}

const ORG_A = "04280428-0000-4000-8000-00000000000a";
const ORG_B = "04280428-0000-4000-8000-00000000000b";
const AGENTE_A = "04280428-1111-4000-8000-00000000000a";
const AGENTE_B = "04280428-1111-4000-8000-00000000000b";
const MOTIVO = "probe_matched_without_hard_match";
/** Marca das linhas semeadas pela poda: só elas entram na conta de quem sobrou. */
const SKILL_DA_PODA = "poda-0428";

/** Tenta o `insert` como postgres: 'recusado' se o CHECK barrou; se aceitar, o psql falha e o teste junto. */
function tentarInserir(valores: string): string {
  return ultimaLinha(
    sql(`
      do $$
      begin
        insert into public.golden_candidates
          (organization_id, job_id, fonte, skill, motivo, estagio_sugerido, estagio_confirmado)
          values ${valores};
        raise exception 'aceitou a linha híbrida';
      exception when check_violation then null;
      end
      $$;
      select 'recusado';
    `),
  );
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENTE_A}', 'golden-0428-a@invariant.test'),
      ('${AGENTE_B}', 'golden-0428-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'golden-0428-a', 'Golden 0428 A', 'Golden A'),
      ('${ORG_B}', 'golden-0428-b', 'Golden 0428 B', 'Golden B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENTE_A}', '${ORG_A}', 'agent', now()),
      ('${AGENTE_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into public.golden_candidates (organization_id, job_id, fonte, skill, motivo)
    select v.org, gen_random_uuid(), 'skill_match_miss', 'agendar', '${MOTIVO}'
      from (values ('${ORG_A}'::uuid), ('${ORG_B}'::uuid)) as v(org)
     where not exists (select 1 from public.golden_candidates g where g.organization_id = v.org);
  `);
});

describe("golden_candidates — isolamento entre organizações", () => {
  it.each([
    ["A", AGENTE_A, ORG_A, ORG_B],
    ["B", AGENTE_B, ORG_B, ORG_A],
  ])("o membro de %s lê os da própria organização e ZERO dos do vizinho", (_lado, usuario, propria, vizinha) => {
    expect(
      contarComo(usuario, `select count(*) from public.golden_candidates where organization_id = '${propria}';`),
    ).toBeGreaterThan(0);
    expect(
      contarComo(usuario, `select count(*) from public.golden_candidates where organization_id = '${vizinha}';`),
    ).toBe(0);
    // Sem filtro, como um cliente do PostgREST pediria a tabela toda.
    expect(contarComo(usuario, "select count(*) from public.golden_candidates;")).toBe(
      contarComo(usuario, `select count(*) from public.golden_candidates where organization_id = '${propria}';`),
    );
  });

  it("a anon key não lê nada", () => {
    const saida = sql(`
      set role anon;
      do $$
      begin
        perform 1 from public.golden_candidates limit 1;
        raise exception 'anon leu';
      exception when insufficient_privilege then null;
      end
      $$;
      select 'recusado';
    `);
    expect(ultimaLinha(saida)).toBe("recusado");
  });

  it("ninguém com sessão ESCREVE: só o servidor grava o candidato", () => {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${AGENTE_A}"}', false);
      do $$
      begin
        insert into public.golden_candidates (organization_id, job_id, fonte, skill, motivo)
          values ('${ORG_A}', gen_random_uuid(), 'skill_match_miss', 'forjada pela sessão', '${MOTIVO}');
      exception when others then null;
      end
      $$;
      do $$
      begin
        update public.golden_candidates set skill = 'reescrita' where organization_id = '${ORG_A}';
      exception when others then null;
      end
      $$;
      do $$
      begin
        delete from public.golden_candidates where organization_id = '${ORG_A}';
      exception when others then null;
      end
      $$;
    `);
    expect(
      ultimaLinha(
        sql("select count(*) from public.golden_candidates where skill in ('forjada pela sessão', 'reescrita');"),
      ),
    ).toBe("0");
    expect(
      ultimaLinha(sql(`select count(*) from public.golden_candidates where organization_id = '${ORG_A}' and skill = 'agendar';`)),
    ).not.toBe("0");
  });
});

describe("golden_candidates — a forma da linha", () => {
  it.each([
    ["near-miss com estágio", `('${ORG_A}', gen_random_uuid(), 'skill_match_miss', 's', '${MOTIVO}', 'x', null)`],
    ["near-miss sem motivo", `('${ORG_A}', gen_random_uuid(), 'skill_match_miss', 's', null, null, null)`],
    ["divergência com skill", `('${ORG_A}', gen_random_uuid(), 'stage_classifier_divergence', 's', null, 'a', 'b')`],
    ["divergência sem o estágio confirmado", `('${ORG_A}', gen_random_uuid(), 'stage_classifier_divergence', null, null, 'a', null)`],
    ["fonte desconhecida", `('${ORG_A}', gen_random_uuid(), 'texto_do_cliente', 's', '${MOTIVO}', null, null)`],
  ])("o CHECK recusa a linha híbrida: %s", (_caso, valores) => {
    expect(tentarInserir(valores)).toBe("recusado");
  });

  it("o retry do mesmo turno não duplica: uma linha por (job, skill) e uma por job na divergência", () => {
    const job = "04280428-2222-4000-8000-000000000001";
    sql(`
      insert into public.golden_candidates (organization_id, job_id, fonte, skill, motivo)
        values ('${ORG_A}', '${job}', 'skill_match_miss', 'agendar', '${MOTIVO}') on conflict do nothing;
      insert into public.golden_candidates (organization_id, job_id, fonte, skill, motivo)
        values ('${ORG_A}', '${job}', 'skill_match_miss', 'agendar', '${MOTIVO}') on conflict do nothing;
      insert into public.golden_candidates (organization_id, job_id, fonte, skill, motivo)
        values ('${ORG_A}', '${job}', 'skill_match_miss', 'orcamento', '${MOTIVO}') on conflict do nothing;
      insert into public.golden_candidates (organization_id, job_id, fonte, estagio_sugerido, estagio_confirmado)
        values ('${ORG_A}', '${job}', 'stage_classifier_divergence', 'a', 'b') on conflict do nothing;
      insert into public.golden_candidates (organization_id, job_id, fonte, estagio_sugerido, estagio_confirmado)
        values ('${ORG_A}', '${job}', 'stage_classifier_divergence', 'a', 'c') on conflict do nothing;
    `);
    expect(
      ultimaLinha(
        sql(`select string_agg(fonte || ':' || coalesce(skill, '-'), ',' order by fonte, skill)
               from public.golden_candidates where job_id = '${job}';`),
      ),
    ).toBe("skill_match_miss:agendar,skill_match_miss:orcamento,stage_classifier_divergence:-");
  });
});

describe("fn_expurgar_candidatos_do_golden — o prazo, com o piso no corpo", () => {
  function semear(): void {
    sql(`
      delete from public.golden_candidates where skill = '${SKILL_DA_PODA}';
      insert into public.golden_candidates (organization_id, job_id, fonte, skill, motivo, created_at) values
        ('${ORG_A}', gen_random_uuid(), 'skill_match_miss', '${SKILL_DA_PODA}', '${MOTIVO}', now() - interval '10 days'),
        ('${ORG_A}', gen_random_uuid(), 'skill_match_miss', '${SKILL_DA_PODA}', '${MOTIVO}', now() - interval '40 days'),
        ('${ORG_B}', gen_random_uuid(), 'skill_match_miss', '${SKILL_DA_PODA}', '${MOTIVO}', now() - interval '120 days');
    `);
  }
  const restam = () =>
    Number(ultimaLinha(sql(`select count(*) from public.golden_candidates where skill = '${SKILL_DA_PODA}';`)));

  it(`sem número, vale o padrão (${RETENCAO_CANDIDATOS_GOLDEN_DIAS_PADRAO} dias): só o de 120 dias sai, de qualquer organização`, () => {
    semear();
    sql("select public.fn_expurgar_candidatos_do_golden(null, 1000);");
    expect(restam()).toBe(2);
  });

  it(`abaixo do piso (${RETENCAO_CANDIDATOS_GOLDEN_DIAS_PISO} dias) vale o piso: pedir 1 dia não apaga o de 10`, () => {
    semear();
    sql("select public.fn_expurgar_candidatos_do_golden(1, 1000);");
    expect(restam()).toBe(1);
  });

  it("o limite do lote vale", () => {
    semear();
    expect(ultimaLinha(sql("select public.fn_expurgar_candidatos_do_golden(1, 1);"))).toBe("1");
    expect(restam()).toBe(2);
  });

  it.each(["authenticated", "anon"])("%s não executa a poda — só o service_role", (papel) => {
    const saida = sql(`
      set role ${papel};
      do $$
      begin
        perform public.fn_expurgar_candidatos_do_golden(30, 1000);
        raise exception '${papel} executou';
      exception when insufficient_privilege then null;
      end
      $$;
      select 'recusado';
    `);
    expect(ultimaLinha(saida)).toBe("recusado");
  });
});
