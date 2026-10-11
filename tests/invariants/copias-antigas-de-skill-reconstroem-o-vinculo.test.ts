/**
 * O BACKFILL DA 0631 EXECUTADO NUM POSTGRES COM DADOS (#1974).
 *
 * `tests/unit/copias-antigas-de-skill-reconstruem-o-vinculo.test.ts` prende a
 * LETRA do bloco e reimplementa a regra em TypeScript, mas não executa o SQL:
 * medido na triagem do #2716, tirar o filtro
 * `anterior.organization_id = v.organization_id` deixou aquele arquivo em
 * `7 passed`. Aqui o bloco é EXTRAÍDO do `supabase/baseline.sql` (o que o
 * self-hoster aplica no install e a cada `update.sh`) e EXECUTADO sobre um
 * histórico semeado, numa transação revertida, para o resto da suíte não
 * herdar as linhas.
 *
 * ## Qual caso guarda o quê
 *
 *   - edição dentro da janela [#1484, #1960) é curada: o controle positivo. Sem
 *     ele, extração quebrada deixaria todos os casos "fica nulo" verdes por vácuo;
 *   - outra organização com o mesmo nome fica nula: o filtro de organização;
 *   - reinstalação pega a origem MAIS RECENTE da linhagem;
 *   - .zip antes de 23/09 (o editor ainda não existia) e .zip depois de 30/09
 *     (o PUT já herda) ficam nulos: as duas pontas da janela;
 *   - cópia sem linhagem de catálogo fica nula;
 *   - reaplicar não muda nada (o `update.sh` re-aplica o baseline inteiro);
 *   - a trava de imutabilidade volta ligada e recusa UPDATE de conteúdo;
 *   - o conteúdo (descrição, corpo, matcher, manifest) não muda.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, seedGov, sql } from "./gov-helpers";

/** O bloco de backfill do apêndice: `do $$ … end $$;` único que desliga e religa a trava. */
function blocoDoBaseline(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const achou = baseline.match(/do \$\$\ndeclare\n  v_alteradas integer;[\s\S]*?end \$\$;/);
  if (!achou) {
    throw new Error("bloco da 0631 não achado em supabase/baseline.sql (extração quebrada)");
  }
  return achou[0];
}

// Namespace pela migration (0631), como manda meta-templates-rls.test.ts.
const ORG_B = "0631bbbb-0000-4000-8000-000000000001";
const id = (n: number) => `0631aaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P1 = id(1);
const P2 = id(2);
const P_OUTRO = id(3);

function versao(vid: string, org: string | null, nome: string, quando: string, fk: string | null): string {
  return `insert into public.skill_versions
      (id, organization_id, name, description, body, matcher, created_at, forked_from_version_id)
    values ('${vid}', ${org ? `'${org}'` : "null"}, '${nome}', 'd', 'corpo', '{"any_keywords":["x"]}',
            '${quando}', ${fk ? `'${fk}'` : "null"});`;
}

/** O histórico semeado: cada versão de org nula é um caso. */
const SEMENTE = `
  insert into public.organizations (id, slug, legal_name, display_name)
    values ('${ORG_B}', 'org-b-0631', 'Org B 0631', 'Org B 0631') on conflict do nothing;
  ${versao(P1, null, "pb-0631", "2026-08-01T10:00:00Z", null)}
  ${versao(P2, null, "pb-0631", "2026-09-20T10:00:00Z", null)}
  ${versao(P_OUTRO, null, "outro-0631", "2026-08-01T10:00:00Z", null)}
  -- edição dentro da janela: instalada do catálogo, editada em 25/09
  ${versao(id(10), GOV_ORG, "pb-0631", "2026-08-05T10:00:00Z", P1)}
  ${versao(id(11), GOV_ORG, "pb-0631", "2026-09-25T10:00:00Z", null)}
  -- cópia sem linhagem de catálogo, dentro da janela
  ${versao(id(20), GOV_ORG, "manual-0631", "2026-09-24T10:00:00Z", null)}
  -- outra organização, mesmo nome, sem linhagem própria
  ${versao(id(30), ORG_B, "pb-0631", "2026-09-25T10:00:00Z", null)}
  -- .zip reimportado depois do #1960
  ${versao(id(40), ORG_B, "outro-0631", "2026-08-06T10:00:00Z", P_OUTRO)}
  ${versao(id(41), ORG_B, "outro-0631", "2026-10-05T10:00:00Z", null)}
  -- reinstalação: a origem mais recente é a P2
  ${versao(id(50), ORG_B, "re-0631", "2026-08-07T10:00:00Z", P1)}
  ${versao(id(51), ORG_B, "re-0631", "2026-09-24T10:00:00Z", P2)}
  ${versao(id(52), ORG_B, "re-0631", "2026-09-28T10:00:00Z", null)}
  -- .zip reimportado em 01/09, antes de o editor (#1484) existir
  ${versao(id(70), ORG_B, "zip-0631", "2026-08-05T10:00:00Z", P1)}
  ${versao(id(71), ORG_B, "zip-0631", "2026-09-01T10:00:00Z", null)}
`;

const NAMESPACE = `id::text like '0631aaaa-%'`;
const RETRATO = `(select string_agg(id::text || ':' || coalesce(forked_from_version_id::text, '-'), ',' order by id)
                    from public.skill_versions where ${NAMESPACE})`;
const CONTEUDO = `(select md5(string_agg(description || body || matcher::text || manifest::text, '|' order by id))
                     from public.skill_versions where ${NAMESPACE})`;

/** `chave=valor` por linha; o resto da saída do psql (BEGIN, INSERT 0 1, DO…) é descartado. */
let medido: Map<string, string>;

beforeAll(() => {
  seedGov();
  const bloco = blocoDoBaseline();
  const saida = sql(`
    begin;
    ${SEMENTE}
    select 'linhas_antes=' || count(*) from public.skill_versions where ${NAMESPACE};
    select 'conteudo_antes=' || ${CONTEUDO};
    ${bloco}
    select 'v' || substr(id::text, 25)::int || '=' || coalesce(forked_from_version_id::text, 'NULO')
      from public.skill_versions where ${NAMESPACE} and organization_id is not null;
    select 'linhas_depois=' || count(*) from public.skill_versions where ${NAMESPACE};
    select 'conteudo_depois=' || ${CONTEUDO};
    select 'trava=' || tgenabled from pg_trigger
     where tgname = 'trg_skill_versions_immutable' and tgrelid = 'public.skill_versions'::regclass;
    select 'retrato_1=' || ${RETRATO};
    ${bloco}
    select 'retrato_2=' || ${RETRATO};
    do $t$
    begin
      update public.skill_versions set body = 'adulterado' where id = '${id(11)}';
      perform set_config('tri.update', 'ACEITO', true);
    exception when others then
      perform set_config('tri.update', sqlerrm, true);
    end $t$;
    select 'update=' || current_setting('tri.update');
    rollback;
  `);
  medido = new Map(
    saida
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[a-z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as [string, string]),
  );
});

function forked(n: number): string | undefined {
  return medido.get(`v${n}`);
}

describe("o backfill da 0631 executado sobre um histórico semeado", () => {
  it("edição de cópia dentro da janela ganha o vínculo da instalação", () => {
    expect(forked(11)).toBe(P1);
    expect(forked(10)).toBe(P1); // vínculo já gravado não é reescrito
  });

  it("outra organização com o mesmo nome NÃO herda a linhagem alheia", () => {
    expect(forked(30)).toBe("NULO");
  });

  it("reinstalação: herda a origem mais recente da linhagem", () => {
    expect(forked(52)).toBe(P2);
  });

  it("as duas pontas da janela: .zip antes do editor e .zip depois do #1960 ficam nulos", () => {
    expect(forked(71)).toBe("NULO");
    expect(forked(41)).toBe("NULO");
  });

  it("cópia sem linhagem de catálogo fica nula", () => {
    expect(forked(20)).toBe("NULO");
  });

  it("reaplicar (update.sh) não muda nada", () => {
    expect(medido.get("retrato_1")).toBeTruthy();
    expect(medido.get("retrato_2")).toBe(medido.get("retrato_1"));
  });

  it("a trava volta ligada e recusa UPDATE de conteúdo", () => {
    expect(medido.get("trava")).toBe("O");
    expect(medido.get("update")).toMatch(/skill_versions é imutável/);
  });

  it("conteúdo e contagem de linhas não mudam", () => {
    expect(medido.get("linhas_antes")).toBe("14");
    expect(medido.get("linhas_depois")).toBe("14");
    expect(medido.get("conteudo_antes")).toBeTruthy();
    expect(medido.get("conteudo_depois")).toBe(medido.get("conteudo_antes"));
  });
});
