import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

import { midpoint } from "@/lib/kanban/fractional-indexing";

/**
 * 0209 — mover N cards de uma vez dá N posições DISTINTAS.
 *
 * O defeito que a migration fecha não é de schema, é de aritmética: o handler
 * escrevia UM `position_in_stage` escalar em N linhas, e `position_in_stage` é
 * fractional indexing (`numeric`, nunca `int`). Duas linhas com o mesmo número
 * fazem o `midpoint(prev, next)` do arrasto seguinte devolver NaN — e a ordem
 * entre elas passa a ser o que o plano de execução decidir naquele refetch.
 *
 * Por isso o teste é de COMPORTAMENTO e não de presença: chama a função no
 * Postgres real (baseline.sql já aplicado por scripts/test-db.sh) e mede as
 * posições que saíram. Um teste que só checasse "a função existe" ficaria verde
 * com um corpo que grava o mesmo número em todas as linhas — que é exatamente o
 * estado anterior.
 *
 * As três propriedades que o quadro precisa, e que estão medidas abaixo:
 *   1. nenhuma posição colide (o `distinct` conta o mesmo que o total);
 *   2. a ORDEM relativa em que os cards estavam sobrevive à movida;
 *   3. o lote não pousa por cima de quem já estava na etapa de destino.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec", "-i", containerName,
      "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG = "0209aaaa-0000-4000-8000-000000000001";
const USER = "0209aaaa-1111-4000-8000-000000000001";
const PIPELINE = "0209aaaa-3333-4000-8000-000000000001";
const ORIGEM_A = "0209aaaa-4444-4000-8000-00000000000a";
const ORIGEM_B = "0209aaaa-4444-4000-8000-00000000000b";
const DESTINO = "0209aaaa-4444-4000-8000-00000000000d";

/**
 * Os seis cards do lote.
 *
 * A ordem VISÍVEL deles (etapa, depois posição) é de propósito diferente da
 * ordem dos ids: `2, 5, 1, 6, 3, 4`. Com fixture em que as duas coincidem, um
 * corpo que dá a MESMA posição a todos passa no caso de ordenação por sorte —
 * o desempate por `id` do `order by` da leitura reproduz a ordem esperada sem
 * que a função tenha preservado nada.
 */
const LOTE = [
  { id: "0209aaaa-5555-4000-8000-000000000001", stage: ORIGEM_A, pos: 3000 },
  { id: "0209aaaa-5555-4000-8000-000000000002", stage: ORIGEM_A, pos: 1000 },
  { id: "0209aaaa-5555-4000-8000-000000000003", stage: ORIGEM_B, pos: 2000 },
  // Já está no destino: entra no lote e não pode servir de piso para si mesmo.
  { id: "0209aaaa-5555-4000-8000-000000000004", stage: DESTINO, pos: 500 },
  { id: "0209aaaa-5555-4000-8000-000000000005", stage: ORIGEM_A, pos: 2000 },
  { id: "0209aaaa-5555-4000-8000-000000000006", stage: ORIGEM_B, pos: 1000 },
];
/** Não entra no lote. É quem define o piso: o lote tem de pousar ACIMA dele. */
const RESIDENTE = { id: "0209aaaa-5555-4000-8000-0000000000ff", stage: DESTINO, pos: 7000 };

beforeAll(() => {
  sql(`
    insert into auth.users (id) values ('${USER}') on conflict do nothing;

    insert into organizations (id, slug, legal_name, display_name)
    values ('${ORG}', 'org-0209', 'Org 0209', 'Org 0209') on conflict (id) do nothing;

    insert into user_organizations (user_id, organization_id, role)
    values ('${USER}', '${ORG}', 'admin') on conflict do nothing;

    insert into crm_pipelines (id, organization_id, name, slug)
    values ('${PIPELINE}', '${ORG}', 'Pipeline 0209', 'pipeline-0209') on conflict (id) do nothing;

    insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${ORIGEM_A}', '${ORG}', '${PIPELINE}', 'Origem A', 'origem-a-0209', 1000),
      ('${ORIGEM_B}', '${ORG}', '${PIPELINE}', 'Origem B', 'origem-b-0209', 2000),
      ('${DESTINO}',  '${ORG}', '${PIPELINE}', 'Destino',  'destino-0209',  3000)
    on conflict (id) do nothing;

    insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, position_in_stage) values
      ${[...LOTE, RESIDENTE]
        .map(
          (c, i) =>
            `('${c.id}', '${ORG}', '${PIPELINE}', '${c.stage}', 'Card ${i + 1}', ${c.pos})`,
        )
        .join(",\n      ")}
    on conflict (id) do nothing;
  `);
});

/**
 * Devolve os cards ao estado inicial do quadro.
 *
 * Cada `it` reposiciona o fixture antes de medir: sem isto o segundo caso
 * mediria o resultado de um lote que já tinha sido movido pelo primeiro, e a
 * ordem de execução do vitest (embaralhada por arquivo, mas não dentro dele)
 * viraria parte do contrato.
 */
function resetarFixture(): void {
  sql(
    [...LOTE, RESIDENTE]
      .map(
        (c) =>
          `update crm_leads set stage_id='${c.stage}', position_in_stage=${c.pos} where id='${c.id}';`,
      )
      .join("\n"),
  );
}

/** Chama a função e devolve as posições do destino, ordenadas por posição. */
function moverLoteELer(): Array<{ id: string; pos: number }> {
  sql(`
    select 1 from public.fn_mover_leads_em_lote(
      '${ORG}'::uuid,
      array[${LOTE.map((c) => `'${c.id}'`).join(",")}]::uuid[],
      '${DESTINO}'::uuid
    );
  `);
  const linhas = sql(`
    select id || '|' || position_in_stage
      from crm_leads
     where organization_id = '${ORG}' and stage_id = '${DESTINO}'
     order by position_in_stage, id;
  `);
  return linhas
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [id, pos] = l.split("|");
      return { id: id!, pos: Number(pos) };
    });
}

describe("0209 — mover em lote não empilha os cards na mesma posição", () => {
  it("dá uma posição DISTINTA a cada card do lote", () => {
    resetarFixture();
    const noDestino = moverLoteELer();
    // 6 do lote + o residente que já estava lá.
    expect(noDestino).toHaveLength(LOTE.length + 1);

    const distintas = new Set(noDestino.map((c) => c.pos));
    expect(distintas.size).toBe(noDestino.length);
  });

  it("preserva a ordem relativa em que os cards estavam no quadro", () => {
    resetarFixture();
    const noDestino = moverLoteELer();
    const doLote = noDestino.filter((c) => LOTE.some((l) => l.id === c.id));
    // A função ordena por (stage_id, position_in_stage, id) — a mesma leitura
    // que o quadro faz. Reproduzimos a expectativa aqui em vez de reusar a
    // ordem de LOTE, para o teste falhar se a função trocar o critério.
    const esperada = [...LOTE]
      .sort((a, b) => a.stage.localeCompare(b.stage) || a.pos - b.pos || a.id.localeCompare(b.id))
      .map((c) => c.id);
    expect(doLote.map((c) => c.id)).toEqual(esperada);
  });

  it("pousa ACIMA de quem já estava na etapa, e não por cima dele", () => {
    resetarFixture();
    const noDestino = moverLoteELer();
    const residente = noDestino.find((c) => c.id === RESIDENTE.id);
    expect(residente?.pos).toBe(RESIDENTE.pos);
    for (const card of noDestino.filter((c) => c.id !== RESIDENTE.id)) {
      expect(card.pos).toBeGreaterThan(RESIDENTE.pos);
    }
  });

  it("o arrasto seguinte para ENTRE dois cards do lote calcula posição, não NaN", () => {
    resetarFixture();
    const noDestino = moverLoteELer();
    // O defeito de origem em uma linha: `midpoint` devolve NaN quando os
    // vizinhos empatam. Com posições distintas, todo par vizinho é arrastável.
    for (let i = 0; i + 1 < noDestino.length; i++) {
      const meio = midpoint(noDestino[i]!.pos, noDestino[i + 1]!.pos);
      expect(Number.isFinite(meio)).toBe(true);
    }
  });

  it("é idempotente: reexecutar o mesmo lote não reordena nem colide", () => {
    resetarFixture();
    const primeira = moverLoteELer();
    const segunda = moverLoteELer();
    expect(segunda.map((c) => c.id)).toEqual(primeira.map((c) => c.id));
    expect(new Set(segunda.map((c) => c.pos)).size).toBe(segunda.length);
  });

  it("não toca lead de OUTRA organização mesmo com o id no array", () => {
    const outraOrg = "0209bbbb-0000-4000-8000-000000000001";
    const outroLead = "0209bbbb-5555-4000-8000-000000000001";
    sql(`
      insert into organizations (id, slug, legal_name, display_name)
      values ('${outraOrg}', 'org-0209-b', 'Org 0209 B', 'Org 0209 B') on conflict (id) do nothing;
      insert into crm_pipelines (id, organization_id, name, slug)
      values ('0209bbbb-3333-4000-8000-000000000001', '${outraOrg}', 'P', 'p-0209b') on conflict (id) do nothing;
      insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('0209bbbb-4444-4000-8000-000000000001', '${outraOrg}', '0209bbbb-3333-4000-8000-000000000001', 'E', 'e-0209b', 1000)
      on conflict (id) do nothing;
      insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, position_in_stage)
      values ('${outroLead}', '${outraOrg}', '0209bbbb-3333-4000-8000-000000000001', '0209bbbb-4444-4000-8000-000000000001', 'Alheio', 4242)
      on conflict (id) do nothing;
    `);
    sql(`
      select 1 from public.fn_mover_leads_em_lote(
        '${ORG}'::uuid, array['${outroLead}']::uuid[], '${DESTINO}'::uuid
      );
    `);
    expect(
      sql(`select stage_id || '|' || position_in_stage from crm_leads where id = '${outroLead}';`),
    ).toBe("0209bbbb-4444-4000-8000-000000000001|4242");
  });
});
