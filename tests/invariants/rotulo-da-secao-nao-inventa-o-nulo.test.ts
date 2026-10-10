/**
 * O EFEITO de `colunas_rotulo` sobre uma coluna NULA — issue #2656.
 *
 * ─── O que a issue mede ────────────────────────────────────────────────────────────────────
 * A redação por seção declarada de módulo (`modulo_secoes_lgpd`, 0485) gravava o rótulo de
 * anonimizado em TODA linha alcançada, inclusive onde a coluna era `NULL`:
 *
 *     select string_agg(format('%I = %L', c, v_rotulo), ', ' order by c) into v_rotulos
 *
 * Um campo que nunca foi preenchido passava a dizer `Cliente Anonimizado #N`: a linha afirma
 * que havia um texto ali, e o dado é inventado. Na triagem do #1907 isto apareceu como
 * `cancel_reason` preenchido numa comanda finalizada sem cancelamento.
 *
 * ─── A régua ───────────────────────────────────────────────────────────────────────────────
 * Uma linha com a coluna nula CONTINUA NULA; uma preenchida VIRA o rótulo do contato que foi
 * anonimizado. O nulo é o estado anterior da pessoa e a anonimização não pode dar conteúdo a
 * ele — é o mesmo predicado que `colunas_redigidas` aplica desde a 0619 (`case when … is null
 * then null else …`) e que o passo 6c da cascata aplicava quando a comanda ainda era função
 * do núcleo.
 *
 * ─── Por que um arquivo novo ───────────────────────────────────────────────────────────────
 * `tests/invariants/comanda-anonimizada-pela-secao.test.ts` é o molde (mesma porta, mesmo
 * `sql`, mesmo formato de asserção), mas ele mede a comanda com `colunas_redigidas`/
 * `colunas_agora` — outro modo, outro escopo. Aqui o alvo é `colunas_rotulo`, que nenhum
 * módulo da `main` declara não vazio hoje: a seção é de mentira, como na D8, e o banco deste
 * arquivo é o único que a enxerga.
 *
 * Caminho: `pnpm test:db tests/invariants/rotulo-da-secao-nao-inventa-o-nulo.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const ORG = "26560000-6666-4000-8000-000000000001";
const ALVO = "26560000-5555-4000-8000-000000000001"; // motivo preenchido + motivo nulo
const SEM = "26560001-5555-4000-8000-000000000002"; // idem, rótulo de número diferente
const VIZ = "26560000-5555-4000-8000-000000000003"; // nunca anonimizado

/** Rótulo por contato: `substring(id::text from 1 for 8)`, como a própria função monta. */
const ROTULO_ALVO = "Cliente Anonimizado #26560000";
const ROTULO_SEM = "Cliente Anonimizado #26560001";

/** Linhas da tabela de mentira: uma com motivo preenchido e uma nula, por contato. */
const P_CHEIA = "26560000-3333-4000-8000-000000000001";
const P_NULA = "26560000-3333-4000-8000-000000000004";
const S_CHEIA = "26560001-3333-4000-8000-000000000002";
const S_NULA = "26560001-3333-4000-8000-000000000005";
const P_VIZ = "26560000-3333-4000-8000-000000000003";

/** `motivo|nota`, com `NULL` escrito — mesmo formato do molde (comanda-anonimizada-pela-secao). */
function linha(id: string): string {
  return sql(`
    select concat_ws('|', coalesce(motivo, 'NULL'), coalesce(nota, 'NULL'))
      from public.sonda_rotulo_lgpd where id = '${id}';
  `);
}

describe("o rótulo da seção não inventa dado onde a coluna era nula", () => {
  it("uma linha com a coluna nula CONTINUA nula, e a preenchida vira o rótulo", () => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG}', 'rotulo-2656', 'Rotulo 2656', 'Rotulo 2656') on conflict (id) do nothing;
      insert into public.contacts (id, organization_id, name) values
        ('${ALVO}', '${ORG}', 'Ana Alvo'),
        ('${SEM}',  '${ORG}', 'Bia Sem Motivo'),
        ('${VIZ}',  '${ORG}', 'Caio Vizinho')
        on conflict (id) do nothing;

      -- A tabela de MENTIRA do arquivo: texto livre sobre a pessoa, como faria um módulo real.
      create table if not exists public.sonda_rotulo_lgpd (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id) on delete cascade,
        contact_id uuid references public.contacts(id) on delete cascade,
        motivo text,
        nota text
      );
      insert into public.sonda_rotulo_lgpd (id, organization_id, contact_id, motivo, nota)
      values
        ('${P_CHEIA}', '${ORG}', '${ALVO}', 'Ana desistiu da proposta', 'ligou e pediu retorno'),
        ('${P_NULA}',  '${ORG}', '${ALVO}', null,                      null),
        ('${S_CHEIA}', '${ORG}', '${SEM}',  'Bia nao quis mais',       null),
        ('${S_NULA}',  '${ORG}', '${SEM}',  null,                      null),
        ('${P_VIZ}',   '${ORG}', '${VIZ}',  'motivo da vizinha',       'nota da vizinha');

      -- A seção, declarada como a migration do módulo faria: 'motivo' ganha rótulo, 'nota' vira nulo.
      insert into public.modulo_secoes_lgpd (modulo, tabela, ligacao, colunas, colunas_rotulo)
      values ('sonda_rotulo', 'sonda_rotulo_lgpd',
              'organization_id = $1 and contact_id = $2',
              '{nota}'::text[], '{motivo}'::text[]);
    `);

    // Controle de seed: antes de anonimizar, o nulo é nulo e o preenchido é o texto da pessoa.
    expect(linha(P_CHEIA)).toBe("Ana desistiu da proposta|ligou e pediu retorno");
    expect(linha(P_NULA)).toBe("NULL|NULL");
    expect(sql(`select is_anonymized::text from public.contacts where id = '${ALVO}';`)).toBe("false");

    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO}', gen_random_uuid());`);
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${SEM}', gen_random_uuid());`);

    // 1. O nulo NÃO ganha rótulo — é este o defeito da #2656, o dado inventado.
    expect(
      linha(P_NULA),
      "a coluna nula recebeu o rótulo — a linha passou a afirmar que havia texto ali",
    ).toBe("NULL|NULL");
    expect(linha(S_NULA), "o mesmo vale para o segundo contato").toBe("NULL|NULL");

    // 2. A preenchida CONTINUA virando o rótulo: preservar o nulo não apaga o efeito.
    expect(linha(P_CHEIA), "a coluna preenchida deixou de receber o rótulo").toBe(`${ROTULO_ALVO}|NULL`);
    expect(linha(S_CHEIA), "o rótulo é o do CONTATO anonimizado, não o de outro").toBe(`${ROTULO_SEM}|NULL`);

    // 3. `colunas` (nota) segue virando nulo nos dois lados.
    expect(linha(P_CHEIA)).toContain("|NULL");
    expect(linha(P_NULA)).toBe("NULL|NULL");

    // A vizinha — mesma tabela, mesma organização, outro contato — fica intocada.
    expect(linha(P_VIZ)).toBe("motivo da vizinha|nota da vizinha");
    expect(
      sql(`select count(*) from public.contacts where organization_id = '${ORG}' and is_anonymized;`),
    ).toBe("2");
  });
});
