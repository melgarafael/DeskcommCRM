/**
 * O BACKFILL ANCORADO NA AUDITORIA (#1976) EXECUTADO NUM POSTGRES COM DADOS.
 *
 * `tests/unit/vinculo-do-catalogo-ancorado-na-auditoria.test.ts` prende a LETRA
 * do bloco (migration × `supabase/baseline.sql`) e reimplementa a regra em
 * TypeScript. Aqui o bloco é EXTRAÍDO do `supabase/baseline.sql` — o que o
 * self-hoster aplica no install e em cada `update.sh` — e EXECUTADO sobre um
 * histórico semeado, numa transação revertida.
 *
 * O histórico semeado sai no estado em que a 0644 deixa o banco (é o que uma
 * instalação real tem hoje): a edição feita na janela do defeito já está curada
 * e o `.zip` reimportado por cima de uma cópia do catálogo já recebeu o vínculo
 * que nunca teve. Sobre esse estado a 0808 tem de:
 *
 *   - curar a cópia editada na janela E editada de novo depois do #1960, que a
 *     0644 não alcançou (a segunda edição herdou o nulo e caiu fora da janela);
 *   - soltar o vínculo de quem foi `.zip` por cima do catálogo, dentro e fora da
 *     janela, e o das edições que herdaram esse vínculo;
 *   - NÃO tocar em cópia manual sem linhagem (controle negativo);
 *   - NÃO tocar em cópia com vínculo legítimo de instalação (controle);
 *   - NÃO curar quando falta prova: versão sem linha de auditoria, e cadeia com
 *     um elo importado no meio (ambíguo fica nulo, e é reportado no notice);
 *   - não mexer em conteúdo, religar a trava de imutabilidade e ser idempotente.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, seedGov, sql } from "./gov-helpers";

/** O bloco da 0808 no apêndice: `do $$ … end $$;` único que desliga e religa a trava. */
function blocoDoBaseline(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const achou = baseline.match(/do \$\$\ndeclare\n  v_soltas integer;[\s\S]*?end \$\$;/);
  if (!achou) {
    throw new Error("bloco da 0808 não achado em supabase/baseline.sql (extração quebrada)");
  }
  return achou[0];
}

// Namespace pela migration (0808), como manda meta-templates-rls.test.ts.
const ORG_B = "0808bbbb-0000-4000-8000-000000000001";
const id = (n: number) => `0808aaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P1 = id(1);
const P2 = id(2);
const P_OUTRO = id(3);

function versao(
  vid: string,
  org: string | null,
  nome: string,
  quando: string,
  fk: string | null,
): string {
  return `insert into public.skill_versions
      (id, organization_id, name, description, body, matcher, created_at, forked_from_version_id)
    values ('${vid}', ${org ? `'${org}'` : "null"}, '${nome}', 'd', 'corpo', '{"any_keywords":["x"]}',
            '${quando}', ${fk ? `'${fk}'` : "null"});`;
}

/** A trilha que o `audit()` grava para cada versão criada. */
function auditar(vid: string, action: string, quando: string): string {
  return `insert into public.api_audit_log
      (organization_id, action, resource_type, resource_id, metadata, created_at)
    values ('${GOV_ORG}', '${action}', 'skill_versions', '${vid}', '{}'::jsonb, '${quando}');`;
}

const SEMENTE = `
  insert into public.organizations (id, slug, legal_name, display_name)
    values ('${ORG_B}', 'org-b-0808', 'Org B 0808', 'Org B 0808') on conflict do nothing;
  ${versao(P1, null, "pb-0808", "2026-08-01T10:00:00Z", null)}
  ${versao(P2, null, "pb-0808", "2026-10-10T10:00:00Z", null)}
  ${versao(P_OUTRO, null, "outro-0808", "2026-08-01T10:00:00Z", null)}

  -- 10: instalada do catálogo (o vínculo legítimo, intocado)
  ${versao(id(10), GOV_ORG, "pb-0808", "2026-08-05T10:00:00Z", P1)}
  ${auditar(id(10), "ai.skill_installed", "2026-08-05T10:00:00Z")}
  -- 11: editada na janela (a 0644 já curou) e 12: de novo depois do #1960, herdando o NULO
  --     → o caso que a 0644 não alcança: 12 tem de ser curada.
  ${versao(id(11), GOV_ORG, "pb-0808", "2026-09-25T10:00:00Z", P1)}
  ${auditar(id(11), "ai.skill_saved", "2026-09-25T10:00:00Z")}
  ${versao(id(12), GOV_ORG, "pb-0808", "2026-10-05T10:00:00Z", null)}
  ${auditar(id(12), "ai.skill_saved", "2026-10-05T10:00:00Z")}

  -- outro: instalada, .zip POR CIMA na janela (a 0644 pôs vínculo que o import nunca gravou)
  ${versao(id(20), GOV_ORG, "x-0808", "2026-08-06T10:00:00Z", P_OUTRO)}
  ${auditar(id(20), "ai.skill_installed", "2026-08-06T10:00:00Z")}
  ${versao(id(21), GOV_ORG, "x-0808", "2026-09-26T10:00:00Z", P_OUTRO)}
  ${auditar(id(21), "ai.skill_imported", "2026-09-26T10:00:00Z")}

  -- amb-0808: instalada, .zip ANTES da janela e edição DEPOIS do #1960 que herdou o vínculo
  -- (o vínculo da edição veio da linhagem, mas a cópia é manual desde o .zip) → solta.
  ${versao(id(30), GOV_ORG, "amb-0808", "2026-08-07T10:00:00Z", P_OUTRO)}
  ${auditar(id(30), "ai.skill_installed", "2026-08-07T10:00:00Z")}
  ${versao(id(31), GOV_ORG, "amb-0808", "2026-09-01T10:00:00Z", null)}
  ${auditar(id(31), "ai.skill_imported", "2026-09-01T10:00:00Z")}
  ${versao(id(32), GOV_ORG, "amb-0808", "2026-10-05T10:00:00Z", P_OUTRO)}
  ${auditar(id(32), "ai.skill_saved", "2026-10-05T10:00:00Z")}

  -- manual-0808: .zip sem catálogo na linhagem (controle negativo) → continua nula
  ${versao(id(40), GOV_ORG, "manual-0808", "2026-09-24T10:00:00Z", null)}
  ${auditar(id(40), "ai.skill_imported", "2026-09-24T10:00:00Z")}

  -- semprova-0808: linhagem de catálogo, edição sem NENHUMA linha de auditoria → fica nula
  ${versao(id(50), GOV_ORG, "semprova-0808", "2026-08-05T10:00:00Z", P1)}
  ${auditar(id(50), "ai.skill_installed", "2026-08-05T10:00:00Z")}
  ${versao(id(51), GOV_ORG, "semprova-0808", "2026-10-05T10:00:00Z", null)}

  -- elonop-0808: cadeia com um .zip NO MEIO (instalada → .zip → edição) → edição fica nula
  ${versao(id(60), GOV_ORG, "elonop-0808", "2026-08-05T10:00:00Z", P1)}
  ${auditar(id(60), "ai.skill_installed", "2026-08-05T10:00:00Z")}
  ${versao(id(61), GOV_ORG, "elonop-0808", "2026-09-10T10:00:00Z", null)}
  ${auditar(id(61), "ai.skill_imported", "2026-09-10T10:00:00Z")}
  ${versao(id(62), GOV_ORG, "elonop-0808", "2026-10-05T10:00:00Z", null)}
  ${auditar(id(62), "ai.skill_saved", "2026-10-05T10:00:00Z")}
`;

const NAMESPACE = `id::text like '0808aaaa-%'`;
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
    select 'retrato_antes=' || ${RETRATO};
    ${bloco}
    select 'v' || substr(id::text, 25)::int || '=' || coalesce(forked_from_version_id::text, 'NULO')
      from public.skill_versions where ${NAMESPACE} and organization_id is not null;
    select 'retrato_1=' || ${RETRATO};
    ${bloco}
    select 'retrato_2=' || ${RETRATO};
    select 'linhas_depois=' || count(*) from public.skill_versions where ${NAMESPACE};
    select 'conteudo_depois=' || ${CONTEUDO};
    select 'trava=' || tgenabled::text from pg_trigger
     where tgname = 'trg_skill_versions_immutable' and tgrelid = 'public.skill_versions'::regclass;
    do $t$
    begin
      update public.skill_versions set body = 'adulterado' where id = '${id(12)}';
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

describe("o backfill ancorado na auditoria (0808) sobre um histórico semeado", () => {
  it("cura a cópia editada na janela e editada de novo depois do #1960", () => {
    // 12 herdou o nulo da 11: é o caso que a janela da 0644 não alcança.
    expect(forked(12)).toBe(P1);
    expect(forked(11)).toBe(P1);
  });

  it("solta o vínculo de quem recebeu .zip por cima do catálogo", () => {
    expect(forked(21)).toBe("NULO");
  });

  it("solta o vínculo herdado por edição depois de um .zip na linhagem", () => {
    expect(forked(32)).toBe("NULO");
    expect(forked(31)).toBe("NULO");
  });

  it("não toca na cópia manual sem linhagem de catálogo", () => {
    expect(forked(40)).toBe("NULO");
  });

  it("não toca no vínculo legítimo da instalação", () => {
    expect(forked(10)).toBe(P1);
  });

  it("não cura sem prova: sem linha de auditoria, ou com .zip no meio da cadeia", () => {
    expect(forked(51)).toBe("NULO"); // edição sem auditoria nenhuma
    expect(forked(62)).toBe("NULO"); // elo importado entre a âncora e a edição
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
    expect(medido.get("linhas_antes")).toBe("17");
    expect(medido.get("linhas_depois")).toBe("17");
    expect(medido.get("conteudo_antes")).toBeTruthy();
    expect(medido.get("conteudo_depois")).toBe(medido.get("conteudo_antes"));
  });
});
