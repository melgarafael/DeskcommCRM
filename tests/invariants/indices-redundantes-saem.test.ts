import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * OS TRÊS ÍNDICES REDUNDANTES DA MIGRATION 0259 — O QUE SAI, O QUE FICA, E QUANDO NÃO SAI.
 *
 * `ai_models_provider_model_unique`, `idx_crm_lead_links_lead` e
 * `calendar_connections_org_pessoa_idx` têm o trabalho feito por outro índice
 * da mesma tabela. O risco de derrubá-los não é o drop: é derrubar o menor num
 * banco onde o MAIOR não está de pé. O `update.sh` roda sem `ON_ERROR_STOP`, e
 * uma criação que falhou em silêncio acima no arquivo deixaria a tabela sem
 * índice para a busca — ou, em `ai_models`, sem a única unicidade.
 *
 * Os blocos rodados aqui são LIDOS do `supabase/baseline.sql`, não copiados: o
 * que se mede é o texto que o self-host aplica. Cada caso roda numa transação
 * que termina em `rollback`, então o banco do arquivo volta ao estado do molde.
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

/** O bloco rotulado da 0259, do rótulo até o próximo rótulo de apêndice. */
function blocoDa0259(): string {
  const rotulo = "-- ---- três índices que não pagam o próprio aluguel (migration 0259) ----";
  const inicio = BASELINE.indexOf(rotulo);
  if (inicio === -1) throw new Error("rótulo da 0259 não encontrado no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + rotulo.length);
  if (fim === -1) throw new Error("fim do bloco da 0259 não encontrado");
  return BASELINE.slice(inicio, fim);
}

/** O `do $$ … $$;` do bloco da 0127 que cria o índice só onde a constraint falta. */
function criacaoCondicionalDa0127(): string {
  const m = /do \$\$\s*begin\s*if not exists \([^;]*?ai_models_unique[\s\S]*?create unique index if not exists ai_models_provider_model_unique[\s\S]*?end \$\$;/.exec(
    BASELINE,
  );
  if (!m) throw new Error("criação condicional de ai_models_provider_model_unique não encontrada");
  return m[0];
}

/** Os índices de `public` com estes nomes, em ordem, separados por vírgula. */
function existentes(nomes: string[]): string {
  const lista = nomes.map((n) => `'${n}'`).join(",");
  return `select coalesce(string_agg(indexname, ',' order by indexname), '') from pg_indexes
            where schemaname = 'public' and indexname in (${lista});`;
}

/**
 * Roda `corpo` numa transação desfeita no fim e devolve a última linha que ele
 * imprimiu. O `psql` do helper não usa `-q`, então `BEGIN`/`ROLLBACK` saem na
 * saída — a última linha útil é a de antes do `ROLLBACK`.
 */
function ultimaLinhaDesfeita(corpo: string): string {
  return lastLine(sql(`begin;\n${corpo}\nrollback;`).replace(/\nROLLBACK$/, ""));
}

const REDUNDANTES = [
  "ai_models_provider_model_unique",
  "calendar_connections_org_pessoa_idx",
  "idx_crm_lead_links_lead",
];

describe("migration 0259: índices redundantes saem", () => {
  it("depois de install + update, os três não existem e os substitutos estão de pé", () => {
    expect(lastLine(sql(existentes(REDUNDANTES))), "sobrou índice redundante").toBe("");
    expect(
      lastLine(
        sql(
          existentes(["ai_models_unique", "calendar_connections_conta_key", "uniq_crm_lead_links_lead_target_link"]),
        ),
      ),
    ).toBe("ai_models_unique,calendar_connections_conta_key,uniq_crm_lead_links_lead_target_link");
  });

  it("o upsert do catálogo segue servido pela constraint (on conflict (provider, model_id))", () => {
    const saida = ultimaLinhaDesfeita(`
      insert into public.ai_models (provider, model_id, display_name)
        values ('inv-0259', 'modelo-0259', 'x') on conflict (provider, model_id) do nothing;
      insert into public.ai_models (provider, model_id, display_name)
        values ('inv-0259', 'modelo-0259', 'x') on conflict (provider, model_id) do nothing;
      select count(*) from public.ai_models where provider = 'inv-0259';
    `);
    expect(saida).toBe("1");
  });

  describe("cada drop confere o substituto antes (o bloco re-aplicado num clone)", () => {
    const casos = [
      {
        nome: "crm_lead_links: sem o unique largo, o de uma coluna FICA",
        recriaMenor: "create index idx_crm_lead_links_lead on public.crm_lead_links (lead_id);",
        tiraSubstituto: "drop index public.uniq_crm_lead_links_lead_target_link;",
        menor: "idx_crm_lead_links_lead",
      },
      {
        nome: "calendar_connections: sem a conta_key, o de (org, pessoa) FICA",
        recriaMenor:
          "create index calendar_connections_org_pessoa_idx on public.calendar_connections (organization_id, user_id);",
        tiraSubstituto: "drop index public.calendar_connections_conta_key;",
        menor: "calendar_connections_org_pessoa_idx",
      },
      {
        nome: "ai_models: sem a constraint, o índice único da 0127 FICA",
        recriaMenor:
          "create unique index ai_models_provider_model_unique on public.ai_models (provider, model_id);",
        tiraSubstituto: "alter table public.ai_models drop constraint ai_models_unique;",
        menor: "ai_models_provider_model_unique",
      },
    ];

    for (const c of casos) {
      it(c.nome, () => {
        const semSubstituto = ultimaLinhaDesfeita(`
          ${c.recriaMenor}
          ${c.tiraSubstituto}
          ${blocoDa0259()}
          ${existentes([c.menor])}
        `);
        expect(semSubstituto, "o bloco derrubou o único índice").toBe(c.menor);

        // Controle: com o substituto de pé, o MESMO bloco derruba. Sem isto, um
        // bloco que nunca derrubasse nada deixaria o caso acima verde.
        const comSubstituto = ultimaLinhaDesfeita(`
          ${c.recriaMenor}
          ${blocoDa0259()}
          ${existentes([c.menor])}
        `);
        expect(comSubstituto, "o bloco não derrubou o redundante").toBe("");
      });
    }
  });

  it("o bloco da 0127 só cria o índice onde a constraint falta", () => {
    const comConstraint = ultimaLinhaDesfeita(`
      ${criacaoCondicionalDa0127()}
      ${existentes(["ai_models_provider_model_unique"])}
    `);
    expect(comConstraint, "construiu o índice ao lado da constraint").toBe("");

    const semConstraint = ultimaLinhaDesfeita(`
      alter table public.ai_models drop constraint ai_models_unique;
      ${criacaoCondicionalDa0127()}
      ${existentes(["ai_models_provider_model_unique"])}
    `);
    expect(semConstraint, "sem a constraint, a unicidade sumiu").toBe("ai_models_provider_model_unique");
  });
});
