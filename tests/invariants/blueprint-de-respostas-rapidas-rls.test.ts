/**
 * IMPORTAR BLUEPRINT DE RESPOSTAS RÁPIDAS (migration 9091, #1995) — A FUNÇÃO NO
 * POSTGRES DE VERDADE, COM OS PAPÉIS DE VERDADE.
 *
 * `fn_importar_blueprint_de_respostas_rapidas` é `security invoker`: quem
 * decide quem grava onde é a RLS `message_templates_write`, não a função. O
 * teste da rota usa um fake da RPC e não alcança nada disso; este arquivo
 * chama a função com o JWT de cada papel, no baseline que o self-host aplica.
 *
 * O que fica provado, um caso por afirmação:
 *
 *   - manager aplica na própria organização: linhas compartilhadas, ordem do
 *     array, mídia vazia, e `created_by_user_id` = quem importou;
 *   - o item sem corpo (áudio) não grava linha;
 *   - a segunda chamada devolve `aplicado: false` e não duplica;
 *   - agent é recusado pela RLS, com zero linhas;
 *   - manager da A com `p_org` da B é recusado, com zero linhas na B;
 *   - `anon` não tem EXECUTE;
 *   - DUAS CONEXÕES simultâneas: a segunda ESPERA a trava (medido em
 *     `pg_stat_activity`), vê a organização preenchida e devolve
 *     `aplicado: false` — a organização fica com uma cópia, não duas.
 */
import { spawn } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const container = process.env.TEST_DB_CONTAINER ?? "";

/** Namespace próprio (`b1e0…`): orgs vazias de resposta rápida, só deste arquivo. */
const ORG_A = "b1e00000-0000-4000-8000-000000000001";
const ORG_AGENT = "b1e00000-0000-4000-8000-000000000002";
const ORG_B = "b1e00000-0000-4000-8000-000000000003";
const ORG_CORRIDA = "b1e00000-0000-4000-8000-000000000004";
const MANAGER = "b1e00000-1111-4000-8000-000000000001";
const AGENT = "b1e00000-1111-4000-8000-000000000002";

const FUNCAO = "public.fn_importar_blueprint_de_respostas_rapidas";

const ITENS = [
  {
    titulo: "Boas-vindas",
    corpo: "Ola, como podemos ajudar?",
    atalho: "bv",
    mostrar_na_barra: true,
  },
  { titulo: "Audio", corpo: "", atalho: null, mostrar_na_barra: true },
  { titulo: "Prazo", corpo: "Chega em 5 dias.", atalho: null, mostrar_na_barra: false },
];

const chamada = (org: string) =>
  `select ${FUNCAO}('${org}', '${JSON.stringify(ITENS)}'::jsonb)::text;`;

const como = (usuario: string, corpo: string) => `
  set role authenticated;
  select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
  ${corpo}
`;

function aplicarComo(usuario: string, org: string): { aplicado: boolean; importadas: number } {
  return JSON.parse(lastLine(sql(como(usuario, chamada(org)))));
}

const linhasDa = (org: string) =>
  Number(sql(`select count(*) from public.message_templates where organization_id = '${org}';`));

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER}', 'blueprint-manager@invariant.test'),
      ('${AGENT}', 'blueprint-agent@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'blueprint-a', 'Blueprint A', 'Blueprint A'),
      ('${ORG_AGENT}', 'blueprint-agent', 'Blueprint Agent', 'Blueprint Agent'),
      ('${ORG_B}', 'blueprint-b', 'Blueprint B', 'Blueprint B'),
      ('${ORG_CORRIDA}', 'blueprint-corrida', 'Blueprint Corrida', 'Blueprint Corrida')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER}', '${ORG_A}', 'manager', now()),
      ('${MANAGER}', '${ORG_CORRIDA}', 'manager', now()),
      ('${AGENT}', '${ORG_AGENT}', 'agent', now())
      on conflict do nothing;
  `);
});

describe("9091 — a função com o papel de quem chama", () => {
  it("manager aplica na própria organização: compartilhadas, na ordem, com o autor", () => {
    expect(aplicarComo(MANAGER, ORG_A)).toEqual({ aplicado: true, importadas: 2 });

    const linhas = sql(`
      select string_agg(
        concat_ws('|', title, coalesce(owner_user_id::text, 'null'), ordem::text,
                  midias::text, created_by_user_id::text),
        E'\\n' order by ordem)
        from public.message_templates where organization_id = '${ORG_A}';
    `);
    // O item sem corpo (posição 2 do array) não virou linha; a ordem é a
    // posição no array, e quem importou fica registrado como autor.
    expect(linhas.split("\n")).toEqual([
      `Boas-vindas|null|0|[]|${MANAGER}`,
      `Prazo|null|2|[]|${MANAGER}`,
    ]);
  });

  it("a segunda chamada devolve aplicado=false e não duplica", () => {
    expect(linhasDa(ORG_A)).toBe(2);
    expect(aplicarComo(MANAGER, ORG_A)).toEqual({ aplicado: false, importadas: 0 });
    expect(linhasDa(ORG_A)).toBe(2);
  });

  it("agent é recusado pela RLS e a organização fica vazia", () => {
    expect(() => aplicarComo(AGENT, ORG_AGENT)).toThrow(/row-level security/);
    expect(linhasDa(ORG_AGENT)).toBe(0);
  });

  it("manager da A com p_org da B é recusado, com zero linhas na B", () => {
    expect(() => aplicarComo(MANAGER, ORG_B)).toThrow(/row-level security/);
    expect(linhasDa(ORG_B)).toBe(0);
  });

  it("`anon` não executa: sem privilégio no catálogo e permission denied na chamada", () => {
    expect(sql(`select has_function_privilege('anon', '${FUNCAO}(uuid, jsonb)', 'EXECUTE');`)).toBe(
      "f",
    );
    expect(() => sql(`set role anon; ${chamada(ORG_B)}`)).toThrow(/permission denied/);
    expect(linhasDa(ORG_B)).toBe(0);
  });
});

/** Uma sessão psql própria, com nome, rodando em paralelo à do teste. */
function sessao(nome: string, script: string): Promise<{ codigo: number | null; saida: string }> {
  return new Promise((resolve) => {
    const psql = spawn("docker", [
      "exec",
      "-i",
      "-e",
      `PGAPPNAME=${nome}`,
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ]);
    let saida = "";
    psql.stdout.on("data", (pedaco: Buffer) => (saida += pedaco.toString()));
    psql.stderr.on("data", (pedaco: Buffer) => (saida += pedaco.toString()));
    psql.on("close", (codigo) => resolve({ codigo, saida }));
    psql.stdin.end(script);
  });
}

const resultadoDa = (saida: string) =>
  JSON.parse(saida.split("\n").find((linha) => linha.startsWith('{"aplicado"')) ?? "null");

/** Pergunta até o banco dizer "1", ou desiste em ~15s. */
async function ate(consulta: string): Promise<boolean> {
  for (let tentativa = 0; tentativa < 150; tentativa++) {
    if (sql(consulta) === "1") return true;
    await new Promise((pronto) => setTimeout(pronto, 100));
  }
  return false;
}

describe("9091 — duas conexões ao mesmo tempo", () => {
  it("a segunda espera a trava, vê a organização preenchida e não duplica", async () => {
    // A primeira aplica e SEGURA a transação aberta: a trava só solta no commit.
    const primeira = sessao(
      "blueprint-primeira",
      `begin;
       set local role authenticated;
       select set_config('request.jwt.claims', '{"sub":"${MANAGER}"}', true);
       ${chamada(ORG_CORRIDA)}
       select pg_sleep(6);
       commit;`,
    );
    expect(
      await ate(`
        select count(*) from pg_locks l join pg_stat_activity a using (pid)
         where a.application_name = 'blueprint-primeira'
           and l.locktype = 'advisory' and l.granted;`),
    ).toBe(true);

    const segunda = sessao("blueprint-segunda", como(MANAGER, chamada(ORG_CORRIDA)));
    // A prova de que houve disputa: a segunda está PARADA na trava consultiva
    // enquanto a primeira não terminou — sem isto, um "aplicado=false" poderia
    // ser só a segunda chegando depois do commit.
    expect(
      await ate(`
        select count(*) from pg_stat_activity
         where application_name = 'blueprint-segunda'
           and wait_event_type = 'Lock' and wait_event = 'advisory';`),
    ).toBe(true);

    const [a, b] = await Promise.all([primeira, segunda]);
    expect(a.codigo, a.saida).toBe(0);
    expect(b.codigo, b.saida).toBe(0);
    expect(resultadoDa(a.saida)).toEqual({ aplicado: true, importadas: 2 });
    expect(resultadoDa(b.saida)).toEqual({ aplicado: false, importadas: 0 });
    expect(linhasDa(ORG_CORRIDA)).toBe(2);
  }, 60_000);
});
