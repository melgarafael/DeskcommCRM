import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * RE-APLICAR O BASELINE SOBRE UM ACERVO DE VERDADE NÃO ERRA.
 *
 * O `update.sh` re-aplica o `baseline.sql` inteiro num banco que tem DADOS. O
 * modo update do `scripts/test-db.sh` re-aplica com ON_ERROR_STOP=1, mas sobre o
 * molde vazio — e erro que depende de dado não aparece em banco vazio.
 *
 * Foi assim que três criações únicas do corpo do dump passaram meses falhando
 * em produção sem nenhum gate ver: `ai_kbv_version_unique` (agente, número),
 * `ai_kbv_one_active_per_agent` e `ai_knowledge_sources_unique_per_agent`
 * (agente, tipo). As migrations 0181 e 0205 trocaram o modelo — a versão passou
 * a ser contada POR MATERIAL — e o apêndice as derruba logo adiante, mas o corpo
 * seguia tentando construí-las antes. Num agente com dois materiais, cada um com
 * a sua versão 1, o índice por agente não constrói. Medido numa VPS real
 * (5 materiais de um agente, versões 1 e 2 de cada): os três
 * `could not create unique index` em todo `update.sh` desde que ela tinha
 * materiais; e o `deadlock detected` que apagou uma policy na v1.27.3 saiu na
 * tela misturado a eles, onde ninguém o distinguiu do ruído de sempre.
 *
 * Nenhum dado estava errado — a fixture abaixo é o que o produto grava hoje. A
 * regra de texto que pega a forma do defeito é
 * `tests/unit/baseline-nao-constroi-o-que-derruba.test.ts`; esta é a prova em
 * banco de que re-aplicar sobre dado real sai limpo.
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

const AGENTE = "eeeeeeee-1111-4000-8000-000000000001";
const FONTE_1 = "eeeeeeee-2222-4000-8000-000000000001";
const FONTE_2 = "eeeeeeee-2222-4000-8000-000000000002";

/** Os três índices únicos do modelo por agente, na forma exata do corpo do dump. */
const INDICES_DO_MODELO_ANTIGO = [
  {
    nome: "ai_kbv_version_unique",
    ddl: `alter table only public.ai_knowledge_versions
            add constraint ai_kbv_version_unique unique (agent_id, version_number);`,
  },
  {
    nome: "ai_kbv_one_active_per_agent",
    ddl: `create unique index ai_kbv_one_active_per_agent
            on public.ai_knowledge_versions using btree (agent_id) where is_active;`,
  },
  {
    nome: "ai_knowledge_sources_unique_per_agent",
    ddl: `create unique index ai_knowledge_sources_unique_per_agent
            on public.ai_knowledge_sources using btree (agent_id, source_type) where is_active;`,
  },
];

function contagemDoAcervo(): string {
  return lastLine(
    sql(`select (select count(*) from public.ai_knowledge_sources where agent_id = '${AGENTE}')
             || '|' || (select count(*) from public.ai_knowledge_versions where agent_id = '${AGENTE}');`),
  );
}

beforeAll(() => {
  seedGov();
  // A forma de produção: UM agente, DOIS materiais do mesmo tipo, e cada material
  // com a própria história (versão 1 aposentada, versão 2 ativa).
  sql(`
    insert into public.ai_agents (id, organization_id, name, system_prompt, kind, is_default)
      values ('${AGENTE}', '${GOV_ORG}', 'Acervo reaplicado', 'p', 'mcp_agent', false)
      on conflict do nothing;

    insert into public.ai_knowledge_sources
      (id, organization_id, agent_id, source_type, name, status, is_active)
      values ('${FONTE_1}', '${GOV_ORG}', '${AGENTE}', 'documento', 'Catálogo de produtos', 'ready', true),
             ('${FONTE_2}', '${GOV_ORG}', '${AGENTE}', 'documento', 'Política de trocas', 'ready', true)
      on conflict do nothing;

    insert into public.ai_knowledge_versions
      (organization_id, agent_id, knowledge_source_id, version_number, status, is_active)
      values ('${GOV_ORG}', '${AGENTE}', '${FONTE_1}', 1, 'ready', false),
             ('${GOV_ORG}', '${AGENTE}', '${FONTE_1}', 2, 'ready', true),
             ('${GOV_ORG}', '${AGENTE}', '${FONTE_2}', 1, 'ready', false),
             ('${GOV_ORG}', '${AGENTE}', '${FONTE_2}', 2, 'ready', true);
  `);
}, 60_000);

/**
 * Tenta construir cada índice do modelo antigo sobre a fixture, cada um na sua
 * subtransação, e devolve `nome=desfecho` de todos. UMA sessão de psql e tudo
 * desfeito no fim: o banco do arquivo volta ao que era.
 */
function construirModeloAntigo(): string {
  const tentativas = INDICES_DO_MODELO_ANTIGO.map(
    ({ nome, ddl }) => `
      begin
        ${ddl}
        insert into pg_temp.desfecho values ('${nome}', 'construiu');
      exception when others then
        insert into pg_temp.desfecho values ('${nome}', sqlerrm);
      end;`,
  ).join("\n");
  const saida = sql(`begin;
    create temporary table desfecho (nome text, resultado text) on commit drop;
    do $$ begin ${tentativas} end $$;
    select string_agg(nome || '=' || resultado, ' | ' order by nome) from pg_temp.desfecho;
    rollback;`);
  return lastLine(saida.replace(/\nROLLBACK$/, ""));
}

describe("baseline re-aplicado sobre acervo do modelo por material", () => {
  it(
    "a fixture é mesmo o que os índices do modelo antigo recusam",
    () => {
      // Controle positivo. Sem ele, uma fixture que deixasse de violar o modelo
      // antigo (um material só, números distintos) deixaria o caso de baixo verde
      // com os três índices de volta no corpo — medindo um banco onde eles cabem.
      const desfechos = construirModeloAntigo();
      for (const { nome } of INDICES_DO_MODELO_ANTIGO) {
        expect(desfechos, `${nome} construiu sobre a fixture — ela não reproduz o acervo de produção`).toContain(
          `${nome}=could not create unique index "${nome}"`,
        );
      }
    },
    120_000,
  );

  it(
    "re-aplicar o baseline inteiro, como o update.sh faz, não produz erro nenhum",
    () => {
      const antes = contagemDoAcervo();
      expect(antes, "fixture incompleta").toBe("2|4");

      // SEM ON_ERROR_STOP, como o update.sh: o psql segue depois de cada erro, e a
      // lista abaixo traz TODOS, não só o primeiro. Os NOTICE de "já existe,
      // pulando" saem do caminho; erro continua sendo impresso.
      const r = spawnSync(
        "docker",
        [
          "exec",
          "-i",
          "-e",
          "PGOPTIONS=-c client_min_messages=warning",
          process.env.TEST_DB_CONTAINER!,
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-q",
          "-f",
          "-",
        ],
        { input: BASELINE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      expect(r.error, "não consegui rodar o psql no contêiner").toBeUndefined();
      expect(r.status, `o psql não chegou ao fim do arquivo:\n${r.stderr.slice(-2000)}`).toBe(0);

      const erros = r.stderr.split("\n").filter((l) => /\b(ERROR|FATAL)\b/.test(l));
      expect(erros, "re-aplicar sobre dado real errou — é o que o update.sh mostraria ao dono").toEqual([]);

      // Sair limpo não pode ser por ter apagado o que atrapalhava.
      expect(contagemDoAcervo(), "re-aplicar o baseline mexeu no acervo").toBe(antes);
      const nomes = INDICES_DO_MODELO_ANTIGO.map((i) => `'${i.nome}'`).join(",");
      expect(lastLine(sql(`select count(*) from pg_class where relname in (${nomes});`))).toBe("0");
      expect(
        lastLine(
          sql(`select string_agg(indexname, ',' order by indexname) from pg_indexes
                where schemaname = 'public' and indexname in ('ai_kbv_uma_ativa_por_fonte', 'ai_kbv_version_por_fonte');`),
        ),
        "o modelo por material perdeu a própria unicidade",
      ).toBe("ai_kbv_uma_ativa_por_fonte,ai_kbv_version_por_fonte");
    },
    300_000,
  );
});
