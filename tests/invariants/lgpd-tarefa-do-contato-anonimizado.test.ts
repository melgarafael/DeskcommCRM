import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * ANONIMIZAR UM CONTATO APAGA O TEXTO DAS TAREFAS DELE — E PRESERVA A OPERAÇÃO.
 *
 * `crm_tasks` (migration 0210) guarda `title`, que na prática é "Ligar para
 * Fulano confirmar o orçamento". Sem o trigger, anonimizar devolveria SUCESSO, a
 * contagem por tabela fecharia, o SLA de D+15 seria marcado como cumprido — e o
 * nome de quem exerceu o direito de apagamento continuaria legível no banco.
 * Nada erra e nada loga.
 *
 * Este arquivo existe porque a entrada de `crm_tasks` em `DIVIDA_LGPD_CONHECIDA`
 * (em `lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts`) afirma que a tabela JÁ
 * está protegida por trigger. Afirmação sem prova de COMPORTAMENTO é o defeito
 * que aquele arquivo existe para pegar, uma camada acima: sem este teste, a
 * dívida declarada seria só uma frase tranquilizadora ao lado de um gate verde.
 *
 * As duas metades importam igualmente. Um teste que só provasse que o texto some
 * ficaria verde com um trigger que APAGASSE a linha — e aí a empresa perderia a
 * resposta a "esta tarefa foi feita?", que é registro de operação e não dado da
 * pessoa.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG = "7a5f0000-0000-4000-8000-00000000000a";
const DONO = "7a5f0000-1111-4000-8000-000000000001";
const ALVO = "7a5f0000-2222-4000-8000-000000000001";
const VIZINHO = "7a5f0000-2222-4000-8000-000000000002";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${DONO}', 'lgpd-tarefa@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'tarefa-lgpd', 'Tarefa LGPD', 'Tarefa LGPD') on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, name) values
      ('${ALVO}',    '${ORG}', 'Maria Silva'),
      ('${VIZINHO}', '${ORG}', 'Joao Pereira')
      on conflict (id) do nothing;
  `);

  for (const contato of [ALVO, VIZINHO]) {
    sql(`
      insert into public.crm_tasks
        (organization_id, contact_id, created_by, title, description, due_date, priority, status)
      select '${ORG}', '${contato}', '${DONO}',
             'Ligar para ' || c.name || ' confirmar o orcamento',
             'telefone do trabalho, falar com a irma dela',
             '2026-03-10 14:00:00+00', 'high', 'done'
        from public.contacts c
       where c.id = '${contato}'
         and not exists (
           select 1 from public.crm_tasks t where t.contact_id = '${contato}'
         );
    `);
  }
});

function campo(contato: string, coluna: string): string {
  return sql(`select coalesce(${coluna}::text, '<null>') from public.crm_tasks
               where contact_id = '${contato}' limit 1;`);
}

describe("a anonimização de LGPD alcança as tarefas do contato", () => {
  it("ANTES: o nome está legível na tarefa (controle positivo)", () => {
    // Sem este caso, um seed que falhasse em silêncio deixaria as asserções de
    // baixo verdes por ausência de linha — verde por não medir nada.
    expect(campo(ALVO, "title")).toContain("Maria");
    expect(campo(ALVO, "description")).toContain("irma dela");
  });

  it("anonimizar o contato apaga o texto livre da tarefa", () => {
    // Chama a FUNÇÃO REAL da cascata, não um `update is_anonymized` à mão: é o
    // caminho por onde a anonimização realmente passa, e o trigger dispara
    // DENTRO da transação dela. O atalho provaria que o trigger reage a um
    // UPDATE que a produção nunca faz.
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO}', gen_random_uuid());`);
    expect(campo(ALVO, "title")).toBe("Tarefa anonimizada");
    expect(campo(ALVO, "description")).toBe("<null>");
  });

  it("...e PRESERVA o que é operação: prazo, situação e prioridade", () => {
    expect(campo(ALVO, "due_date")).toContain("2026-03-10");
    expect(campo(ALVO, "status")).toBe("done");
    expect(campo(ALVO, "priority")).toBe("high");
  });

  it("a tarefa de OUTRO contato não é tocada", () => {
    expect(campo(VIZINHO, "title")).toContain("Joao");
    expect(campo(VIZINHO, "description")).toContain("irma dela");
  });
});
