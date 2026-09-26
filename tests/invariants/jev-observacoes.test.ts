import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { ESTADOS_QUE_PERGUNTAM } from "@/lib/ai/decisao/config";
import {
  RETENCAO_OBSERVACOES_DO_JEV_DIAS_PADRAO,
  RETENCAO_OBSERVACOES_DO_JEV_DIAS_PISO,
} from "@/lib/retencao/politica";

/**
 * AS OBSERVAÇÕES DO JEV (migration 0421) — isolamento, escrita, vocabulário e prazo.
 *
 * ═══ Por que um arquivo próprio, e não uma linha em rls-isolation.test.ts ═══
 *
 * `tests/invariants/**` existente é congelado pelo pre-commit do gov-loop
 * (`loop/hooks/freeze-invariants.sh`): acrescentar a tabela a `TABLES` é editar
 * um invariante que já existe, e a válvula é reservada ao flip de `test.fails`
 * numa sessão humana. Arquivo NOVO passa. Aqui mora a prova comportamental
 * inteira — JWT simulado, contagem cross-org nos dois sentidos, controle
 * positivo —, e `rls-completude-varredura.test.ts` precisa de UMA linha em
 * `PROVA_PROPRIA` apontando para cá: edição de arquivo congelado, ato de uma
 * sessão humana. Até ela entrar, aquela varredura acusa `jev_observacoes` — que
 * é o gate funcionando, e não defeito da tabela.
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

const ORG_A = "04160416-0000-4000-8000-00000000000a";
const ORG_B = "04160416-0000-4000-8000-00000000000b";
const AGENTE_A = "04160416-1111-4000-8000-00000000000a";
const AGENTE_B = "04160416-1111-4000-8000-00000000000b";
/** Marca das linhas semeadas pela poda: só elas entram na conta de quem sobrou. */
const MODELO_DA_PODA = "poda-0416";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENTE_A}', 'jev-0416-a@invariant.test'),
      ('${AGENTE_B}', 'jev-0416-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'jev-0416-a', 'Jev 0416 A', 'Jev A'),
      ('${ORG_B}', 'jev-0416-b', 'Jev 0416 B', 'Jev B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENTE_A}', '${ORG_A}', 'agent', now()),
      ('${AGENTE_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into public.jev_observacoes (organization_id, tarefa, estado, rotulo_jev, rotulo_atual)
    select v.org, 'manipulacao', 'observando', 'high', 'low'
      from (values ('${ORG_A}'::uuid), ('${ORG_B}'::uuid)) as v(org)
     where not exists (select 1 from public.jev_observacoes o where o.organization_id = v.org);
  `);
});

describe("jev_observacoes — isolamento entre organizações", () => {
  it.each([
    ["A", AGENTE_A, ORG_A, ORG_B],
    ["B", AGENTE_B, ORG_B, ORG_A],
  ])("o membro de %s lê as da própria organização e ZERO das do vizinho", (_lado, usuario, propria, vizinha) => {
    expect(
      contarComo(usuario, `select count(*) from public.jev_observacoes where organization_id = '${propria}';`),
    ).toBeGreaterThan(0);
    expect(
      contarComo(usuario, `select count(*) from public.jev_observacoes where organization_id = '${vizinha}';`),
    ).toBe(0);
    // Sem filtro, como um cliente do PostgREST pediria a tabela toda.
    expect(contarComo(usuario, "select count(*) from public.jev_observacoes;")).toBe(
      contarComo(usuario, `select count(*) from public.jev_observacoes where organization_id = '${propria}';`),
    );
  });

  it("a anon key não lê nada", () => {
    const saida = sql(`
      set role anon;
      do $$
      begin
        perform 1 from public.jev_observacoes limit 1;
        raise exception 'anon leu';
      exception when insufficient_privilege then null;
      end
      $$;
      select 'recusado';
    `);
    expect(ultimaLinha(saida)).toBe("recusado");
  });

  it("ninguém com sessão ESCREVE: só o servidor grava a observação", () => {
    // Um membro que forjasse observações mudaria a concordância que decide
    // deixar o Jev decidir. A prova é por contagem como superusuário depois.
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${AGENTE_A}"}', false);
      do $$
      begin
        insert into public.jev_observacoes (organization_id, tarefa, estado, modelo)
          values ('${ORG_A}', 'manipulacao', 'decidindo', 'forjada pela sessão');
      exception when others then null;
      end
      $$;
      do $$
      begin
        update public.jev_observacoes set rotulo_atual = 'high' where organization_id = '${ORG_A}';
      exception when others then null;
      end
      $$;
      do $$
      begin
        delete from public.jev_observacoes where organization_id = '${ORG_A}';
      exception when others then null;
      end
      $$;
    `);
    expect(ultimaLinha(sql("select count(*) from public.jev_observacoes where modelo = 'forjada pela sessão';"))).toBe("0");
    expect(
      ultimaLinha(sql(`select count(*) from public.jev_observacoes where organization_id = '${ORG_A}' and rotulo_atual = 'low';`)),
    ).not.toBe("0");
  });
});

describe("jev_observacoes — o que a coluna aceita", () => {
  it("o CHECK de `estado` aceita exatamente ESTADOS_QUE_PERGUNTAM (lib/ai/decisao/config.ts)", () => {
    const def = sql(
      "select pg_get_constraintdef(oid) from pg_constraint where conname = 'jev_observacoes_estado_check';",
    );
    const noBanco = [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
    expect(noBanco.length, "o CHECK sumiu ou mudou de forma — ENSINE ESTE TESTE").toBeGreaterThan(0);
    expect(noBanco).toEqual([...ESTADOS_QUE_PERGUNTAM].sort());
  });

  it("`concordou` é gerada, e nula sem par — sem par não é discordância", () => {
    const linha = sql(`
      with o as (
        insert into public.jev_observacoes (organization_id, tarefa, estado, rotulo_jev, rotulo_atual) values
          ('${ORG_B}', 'x', 'observando', 'high', 'high'),
          ('${ORG_B}', 'x', 'observando', 'high', 'low'),
          ('${ORG_B}', 'x', 'observando', 'high', null)
        returning rotulo_atual, concordou
      )
      select string_agg(coalesce(rotulo_atual, '∅') || '=' || coalesce(concordou::text, 'null'), ',' order by rotulo_atual nulls last) from o;
    `);
    expect(ultimaLinha(linha)).toBe("high=true,low=false,∅=null");
  });
});

describe("fn_expurgar_observacoes_do_jev — o prazo, com o piso no corpo", () => {
  function semear(): void {
    sql(`
      delete from public.jev_observacoes where modelo = '${MODELO_DA_PODA}';
      insert into public.jev_observacoes (organization_id, tarefa, estado, modelo, created_at) values
        ('${ORG_A}', 'manipulacao', 'observando', '${MODELO_DA_PODA}', now() - interval '10 days'),
        ('${ORG_A}', 'manipulacao', 'observando', '${MODELO_DA_PODA}', now() - interval '40 days'),
        ('${ORG_B}', 'manipulacao', 'observando', '${MODELO_DA_PODA}', now() - interval '120 days');
    `);
  }
  const restam = () =>
    Number(ultimaLinha(sql(`select count(*) from public.jev_observacoes where modelo = '${MODELO_DA_PODA}';`)));

  it(`sem número, vale o padrão (${RETENCAO_OBSERVACOES_DO_JEV_DIAS_PADRAO} dias): só a de 120 dias sai, de qualquer organização`, () => {
    semear();
    sql("select public.fn_expurgar_observacoes_do_jev(null, 1000);");
    expect(restam()).toBe(2);
  });

  it(`abaixo do piso (${RETENCAO_OBSERVACOES_DO_JEV_DIAS_PISO} dias) vale o piso: pedir 1 dia não apaga a de 10`, () => {
    semear();
    sql("select public.fn_expurgar_observacoes_do_jev(1, 1000);");
    expect(restam()).toBe(1);
  });

  it("o limite do lote vale", () => {
    semear();
    expect(ultimaLinha(sql("select public.fn_expurgar_observacoes_do_jev(1, 1);"))).toBe("1");
    expect(restam()).toBe(2);
  });

  it("quem tem sessão não executa a poda — só o service_role", () => {
    const saida = sql(`
      set role authenticated;
      do $$
      begin
        perform public.fn_expurgar_observacoes_do_jev(30, 1000);
        raise exception 'authenticated executou';
      exception when insufficient_privilege then null;
      end
      $$;
      select 'recusado';
    `);
    expect(ultimaLinha(saida)).toBe("recusado");
  });
});
