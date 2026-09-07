import { describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * O que a migration 0088 promete, cobrado no banco que o CLONE recebe.
 *
 * Este arquivo lê o Postgres descartável que nasce do `supabase/baseline.sql`
 * (`TEST_DB_CONTAINER`, via `scripts/test-db.sh`), nunca o banco de dev — e essa
 * escolha É o teste. A migration é o caminho de quem já tem banco; o baseline é o
 * destino de quem clona. Uma tabela que existe só na primeira não chega ao
 * self-hoster e nada reclama: ele descobre quando a tela de templates responde
 * `42P01` no primeiro sync.
 *
 * O que está sob prova, e por que cada coisa importa:
 *
 *  1. **Isolamento nas duas direções.** `meta_templates` guarda o nome comercial dos
 *     templates de um tenant — vazamento aqui é vazamento de estratégia de campanha.
 *     Ler é metade: o `with check` (org B escrevendo COM o `organization_id` da org A)
 *     é o lado que uma policy escrita só com `using` deixa passar, e é o lado que
 *     nenhuma tela exercita.
 *
 *  2. **A chave é `(name, language)`.** `pedido_confirmado` em `pt_BR` e em `pt` são
 *     DOIS templates na Meta, com aprovação e corpo independentes. A prova tem os
 *     DOIS lados: mesmo par colide (senão o sync duplica a linha a cada rodada) e
 *     idioma diferente convive (senão o segundo idioma sobrescreve o primeiro e o
 *     envio passa a escolher por sorte de qual sincronizou por último).
 *
 *  3. **`status` sem CHECK é decisão, não lacuna.** O caso grava um valor que a Meta
 *     ainda não inventou. Ele passar é o ponto: vocabulário aberto com CHECK viraria
 *     `23514` no meio do sync e quebraria o `update.sh` do clone que já gravou o
 *     valor legado. Se alguém "completar" o schema com um CHECK, este caso vermelha
 *     e explica por quê.
 */

// Namespace pela MIGRATION (`0088aaaa`/`0088bbbb`), seguindo a convenção de
// `0070aaaa`/`0071aaaa`/`0072aaaa`. Os arquivos de invariante rodam em PARALELO
// contra o MESMO container, então UUID reusado não é colisão teórica: a primeira
// versão deste arquivo escolheu `dddddddd-…` e virou um terceiro membro da org B
// de `gov-1b-team-manager-read.test.ts`, que a reprovou (3 onde espera 2). O
// número da migration é único por construção — nome de cor não é.
const MT_ORG_A = "0088aaaa-0000-4000-8000-000000000001";
const MT_ORG_B = "0088bbbb-0000-4000-8000-000000000002";
const MT_MEMBER_A = "0088aaaa-1111-4000-8000-000000000001";
const MT_MEMBER_B = "0088bbbb-1111-4000-8000-000000000002";
const WABA = "waba-inv-0088";

function seed(): void {
  sql(`
    insert into auth.users (id, email) values
      ('${MT_MEMBER_A}', 'mt-member-a@invariant.test'),
      ('${MT_MEMBER_B}', 'mt-member-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${MT_ORG_A}', 'mt-inv-a', 'Meta Templates Inv A', 'MT Inv A'),
      ('${MT_ORG_B}', 'mt-inv-b', 'Meta Templates Inv B', 'MT Inv B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MT_MEMBER_A}', '${MT_ORG_A}', 'manager', now()),
      ('${MT_MEMBER_B}', '${MT_ORG_B}', 'manager', now())
      on conflict do nothing;
  `);
}

/** Colunas mínimas de uma linha de template — só o que é NOT NULL sem default. */
function values(org: string, name: string, language: string, status = "APPROVED"): string {
  return `('${org}', '${WABA}', '${name}', '${language}', '${status}', '[]'::jsonb, 'hash-${name}-${language}')`;
}

const COLS = "(organization_id, waba_id, name, language, status, components, contract_hash)";

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    // execFileSync joga o stderr do psql em `stderr`; a mensagem do Error só traz o exit.
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("o INSERT passou — a trava não existe neste banco");
}

describe("0088 · o espelho de templates da Meta chega ao clone", () => {
  it("a tabela nasce com RLS ligada e a policy de tenant", () => {
    seed();
    expect(sql(`select relrowsecurity from pg_class where relname = 'meta_templates'`)).toBe("t");
    expect(
      sql(`select policyname from pg_policies
            where schemaname = 'public' and tablename = 'meta_templates' and permissive = 'PERMISSIVE' order by 1`),
    ).toBe("tenant_isolation_meta_templates_all");
  });

  it("membro da org A escreve na própria org e lê de volta", () => {
    expect(
      writeCountAs(
        MT_MEMBER_A,
        `insert into public.meta_templates ${COLS} values ${values(MT_ORG_A, "pedido_confirmado", "pt_BR")}`,
      ),
    ).toBe(1);
    expect(
      countAs(
        MT_MEMBER_A,
        `select count(*) from public.meta_templates where organization_id = '${MT_ORG_A}';`,
      ),
    ).toBe(1);
  });

  it("membro da org B NÃO vê o template da org A", () => {
    expect(
      countAs(
        MT_MEMBER_B,
        `select count(*) from public.meta_templates where organization_id = '${MT_ORG_A}';`,
      ),
    ).toBe(0);
  });

  it("membro da org B NÃO escreve COM o organization_id da org A (o lado `with check`)", () => {
    expect(
      writeCountAs(
        MT_MEMBER_B,
        `insert into public.meta_templates ${COLS} values ${values(MT_ORG_A, "invadido", "pt_BR")}`,
      ),
    ).toBe(0);
    // E a linha não existe nem para quem bypassa RLS — 0 aqui separa "foi barrado"
    // de "foi gravado e o SELECT é que não enxerga".
    expect(sql(`select count(*) from public.meta_templates where name = 'invadido'`)).toBe("0");
  });

  it("o MESMO (org, waba, name, language) colide — senão o sync duplica a cada rodada", () => {
    const erro = erroDe(() =>
      sql(
        `insert into public.meta_templates ${COLS} values ${values(MT_ORG_A, "pedido_confirmado", "pt_BR")};`,
      ),
    );
    expect(erro).toContain("meta_templates_org_waba_name_lang_uniq");
  });

  it("o MESMO nome em OUTRO idioma convive — pt_BR e pt são templates distintos", () => {
    sql(
      `insert into public.meta_templates ${COLS} values ${values(MT_ORG_A, "pedido_confirmado", "pt")};`,
    );
    expect(
      sql(
        `select count(*) from public.meta_templates
          where organization_id = '${MT_ORG_A}' and name = 'pedido_confirmado'`,
      ),
    ).toBe("2");
  });

  it("status aceita valor que a Meta ainda não inventou — o CHECK ausente é a decisão", () => {
    sql(
      `insert into public.meta_templates ${COLS} values ${values(MT_ORG_A, "estado_futuro", "pt_BR", "LIMIT_EXCEEDED")};`,
    );
    expect(
      sql(`select status from public.meta_templates where name = 'estado_futuro'`),
    ).toBe("LIMIT_EXCEEDED");
  });
});
