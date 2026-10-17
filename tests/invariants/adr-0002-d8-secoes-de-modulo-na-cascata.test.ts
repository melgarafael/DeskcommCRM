/**
 * D8 DA ADR-0002 — A ANONIMIZAÇÃO ALCANÇA AS SEÇÕES DE MÓDULO, E PULA O MÓDULO AUSENTE.
 *
 * ─── O que a ADR decide e este arquivo mede ───────────────────────────────────────────────────
 * "Anonimização e retenção alcançam as tabelas do módulo por SQL dinâmico protegido por
 * `to_regclass`: onde o módulo não está instalado, pulam sem erro. Uma cascata que citasse a
 * tabela pelo nome abortaria a anonimização inteira em toda instalação sem o módulo — medido."
 * (ADR-0002, D8)
 *
 * A cascata `fn_lgpd_cascade_redact_contact` é a função única do NÚCLEO e continua sendo —
 * ela cresce a cada tabela nova do núcleo (0119 → 0482) e é lida por dois invariantes que
 * cobram exatamente isso. O que ela NÃO pode dar é isto: um módulo opcional só existe em
 * algumas instalações, e um passo escrito com o nome da tabela de um módulo não instalado
 * abortaria a anonimização INTEIRA ali — a rota devolveria erro, o SLA pararia, e o pedido do
 * titular ficaria sem resposta. Por isso a D8 pede um mecanismo declarado: o módulo registra
 * as suas seções (migration 0485, `modulo_secoes_lgpd`) e a anonimização as alcança por SQL
 * dinâmico, resolvendo cada tabela com `to_regclass` antes de tocar em qualquer coisa.
 *
 * ─── Os quatro lados que este arquivo cobre ───────────────────────────────────────────────────
 *   1. AUSENTE — seção declarada para tabela que não existe: a anonimização PASSA, sem erro.
 *      É o núcleo da D8 e é o que uma cascata nomeada por tabela não consegue dar.
 *   2. PRESENTE — seção declarada para tabela que existe: as colunas da PESSOA são redigidas,
 *      e SÓ as linhas do contato que está sendo anonimizado (o vizinho fica inteiro).
 *   3. DECLARAÇÃO ERRADA — coluna que não existe: ERRO ALTO (`modulo_secao_invalida`), nunca
 *      redação pela metade com sucesso devolvido. Silenciar aqui seria entregar anonimização
 *      COM SUCESSO com a pessoa legível, que é o modo de falha que a LGPD não tolera.
 *   4. SUPERFÍCIE — o registro é escrito só por quem aplica o schema, e o gatilho não é
 *      executável nem por `anon` nem por `authenticated` (D4, mesma régua da provisionadora).
 *
 * ─── O módulo de MENTIRA deste arquivo ────────────────────────────────────────────────────────
 * Nenhum módulo oficial declara seção hoje: honorários não tem texto livre sobre a pessoa,
 * decisão escrita na própria migration 0480, e a tabela `modulo_secoes_lgpd` nasce VAZIA (o
 * caso 1 abaixo mede isso). A seção que redige existe SÓ aqui — é o mesmo desenho da onda 1
 * (`provisionadora-de-modulo.test.ts` nasce com o conjunto vazio e prova o instrumento com
 * função de mentira): mecanismo sem consumidor ainda precisa de instrumento medido, senão o
 * dia em que o primeiro módulo declarar é o dia em que ninguém sabe se a coisa funciona.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const ORG = "7a5f0011-0000-4000-8000-00000000000a";
const DONO = "7a5f0011-1111-4000-8000-000000000001";
/** Contato anonimizado com a seção AUSENTE declarada (módulo não instalado). */
const AUSENTE = "7a5f0011-2222-4000-8000-000000000001";
/** Contato anonimizado com a seção PRESENTE declarada (módulo instalado). */
const ALVO = "7a5f0011-2222-4000-8000-000000000002";
/** Nunca anonimizado: serve de prova de que só as linhas do contato saem. */
const VIZINHO = "7a5f0011-2222-4000-8000-000000000003";
/** Anonimizado com a seção QUEBRADA declarada — tem de falhar alto. */
const ERROU = "7a5f0011-2222-4000-8000-000000000004";

/**
 * O rótulo NÃO é mais `substring(id, 1, 8)` (issue #2342): a cascata gera um sufixo OPACO
 * e o grava no contato no passo 1, e o gatilho de seções reusa este MESMO valor. O teste
 * lê o que o banco guardou — a prova de que o sufixo não é mais o id está em
 * `tests/invariants/lgpd-rotulo-opaco-e-external-id.test.ts`.
 */
function rotuloDe(contactId: string): string {
  return sql(`select name from public.contacts where id = '${contactId}';`).trim().split("\n").at(-1) ?? "";
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${DONO}', 'd8-secoes@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'secoes-modulo-lgpd', 'Seções de Módulo', 'Seções de Módulo')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, name) values
      ('${AUSENTE}', '${ORG}', 'Ana Ausente'),
      ('${ALVO}',    '${ORG}', 'Maria Alvo'),
      ('${VIZINHO}', '${ORG}', 'Joao Vizinho'),
      ('${ERROU}',   '${ORG}', 'Rita Errada')
      on conflict (id) do nothing;

    -- A tabela de MENTIRA: guarda texto livre sobre a pessoa, como faria um módulo real.
    -- Existe SÓ no banco deste arquivo (cada invariante tem o seu), então nenhum outro gate
    -- a enxerga — em particular o de decisão por tabela, que deriva do catálogo de FKs.
    create table if not exists public.sonda_secao_modulo (
      id uuid primary key default gen_random_uuid(),
      organization_id uuid not null references public.organizations(id) on delete cascade,
      contact_id uuid references public.contacts(id) on delete cascade,
      nome_livre text,
      apelido text
    );

    insert into public.sonda_secao_modulo (organization_id, contact_id, nome_livre, apelido)
    select '${ORG}', c.id, 'O nome de ' || c.name, 'querido ' || c.name
      from public.contacts c
     where c.id in ('${AUSENTE}', '${ALVO}', '${VIZINHO}', '${ERROU}');
  `);
});

/** Linha da tabela de mentira: `nome_livre|apelido`, com `<null>` para nulo. */
function linhaDe(contato: string): string {
  return sql(`
    select coalesce(nome_livre, '<null>') || '|' || coalesce(apelido, '<null>')
      from public.sonda_secao_modulo where contact_id = '${contato}';
  `);
}

/** Roda um script esperando FALHA; devolve o texto do erro, ou "" se passou. */
function tentar(script: string): string {
  try {
    sql(script);
    return "";
  } catch (e) {
    const erro = e as { stderr?: string; message?: string };
    return `${erro.stderr ?? ""}${erro.message ?? ""}`;
  }
}

function anonimizar(contato: string): void {
  sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${contato}', gen_random_uuid());`);
}

describe("D8 — a anonimização alcança as seções de módulo declaradas", () => {
  it("o mecanismo existe e nasce com o registro VAZIO (nenhum módulo declara ainda)", () => {
    expect(sql(`select (to_regclass('public.modulo_secoes_lgpd') is not null)::text;`)).toBe("true");
    expect(
      sql(`select count(*) from pg_proc where proname = 'fn_lgpd_redigir_secoes_de_modulo'
             and pronamespace = 'public'::regnamespace;`),
    ).toBe("1");
    expect(
      sql(`select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
             where c.relname = 'contacts' and t.tgname = 'trg_lgpd_secoes_de_modulo'
               and not t.tgisinternal;`),
    ).toBe("1");
    // O registro nasce vazio de propósito — e é a prova de que a migration não inventou
    // dado de LGPD para um módulo que não pediu (honorários, 0480).
    expect(sql(`select count(*) from public.modulo_secoes_lgpd;`)).toBe("0");
    // E o guard é o da D8, lido do catálogo (não do arquivo): o corpo tem de resolver a
    // tabela com to_regclass antes de qualquer comando.
    expect(sql(`
      select pg_get_functiondef(p.oid) from pg_proc p
       where p.proname = 'fn_lgpd_redigir_secoes_de_modulo'
         and p.pronamespace = 'public'::regnamespace;
    `)).toContain("to_regclass(");
  });

  it("MÓDULO NÃO INSTALADO: a seção declarada para tabela ausente PULA, sem erro", () => {
    // É o núcleo da D8. Sem o to_regclass, este `update` abortaria a anonimização inteira
    // de um contato numa instalação que nunca instalou o módulo.
    sql(`
      insert into public.modulo_secoes_lgpd (modulo, tabela, ligacao, colunas, colunas_rotulo)
      values ('sonda_desligado', 'sonda_tabela_de_modulo_ausente',
              'organization_id = $1 and contact_id = $2',
              '{nome_livre}'::text[], '{apelido}'::text[]);
    `);
    // Controle de seed: a linha existe e está legível ANTES — sem isto, "não mudou" seria
    // verde por ausência de linha.
    expect(linhaDe(AUSENTE)).toBe("O nome de Ana Ausente|querido Ana Ausente");

    expect(() => anonimizar(AUSENTE)).not.toThrow();
    expect(sql(`select is_anonymized::text from public.contacts where id = '${AUSENTE}';`)).toBe("true");
    // A seção apontava para uma tabela que não existe: nada foi tocado, e o contato foi
    // anonimizado do mesmo jeito. É esta a frase da D8.
    expect(linhaDe(AUSENTE)).toBe("O nome de Ana Ausente|querido Ana Ausente");
    expect(
      sql(`select count(*) from public.modulo_secoes_lgpd where modulo = 'sonda_desligado';`),
    ).toBe("1");
  });

  it("MÓDULO INSTALADO: a seção redige as colunas da PESSOA, e só as linhas do contato", () => {
    // Antes: o texto está legível — sem este controle, as asserções de baixo ficariam verdes
    // por ausência de linha.
    expect(linhaDe(ALVO)).toBe("O nome de Maria Alvo|querido Maria Alvo");

    sql(`
      insert into public.modulo_secoes_lgpd (modulo, tabela, ligacao, colunas, colunas_rotulo)
      values ('sonda', 'sonda_secao_modulo',
              'organization_id = $1 and contact_id = $2',
              '{nome_livre}'::text[], '{apelido}'::text[]);
    `);

    anonimizar(ALVO);

    expect(linhaDe(ALVO)).toBe(`<null>|${rotuloDe(ALVO)}`);
    // O vizinho é da MESMA organização e da MESMA tabela — e não é tocado.
    expect(linhaDe(VIZINHO)).toBe("O nome de Joao Vizinho|querido Joao Vizinho");
  });

  it("DECLARAÇÃO ERRADA: coluna que não existe é ERRO ALTO, nunca sucesso pela metade", () => {
    sql(`
      insert into public.modulo_secoes_lgpd (modulo, tabela, ligacao, colunas, colunas_rotulo)
      values ('sonda_quebrado', 'sonda_secao_modulo',
              'organization_id = $1 and contact_id = $2',
              '{coluna_que_nao_existe}'::text[], '{}'::text[]);
    `);

    const erro = tentar(
      `select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ERROU}', gen_random_uuid());`,
    );
    expect(
      erro,
      "a anonimização devolveu SUCESSO com uma seção declarada errada — a pessoa ficaria " +
        "legível e o SLA seria marcado como cumprido",
    ).toContain("modulo_secao_invalida");
    expect(erro).toContain("sonda_quebrado");
    // A falha abortou a transação inteira: o contato NÃO foi anonimizado pela metade.
    expect(sql(`select is_anonymized::text from public.contacts where id = '${ERROU}';`)).toBe("false");

    sql(`delete from public.modulo_secoes_lgpd where modulo = 'sonda_quebrado';`);
  });

  it("SUPERFÍCIE: o registro e o gatilho ficam fora do papel de cliente (D4)", () => {
    expect(
      sql(`
        select case when to_regrole('anon') is null then 'sem-role'
                    when has_table_privilege('anon', 'public.modulo_secoes_lgpd', 'insert') then 'exposta'
                    else 'fechada' end;
      `),
    ).toBe("fechada");
    expect(
      sql(`
        select case when to_regrole('authenticated') is null then 'sem-role'
                    when has_table_privilege('authenticated', 'public.modulo_secoes_lgpd', 'insert') then 'exposta'
                    else 'fechada' end;
      `),
    ).toBe("fechada");
    for (const papel of ["anon", "authenticated"]) {
      expect(
        sql(`
          select case when to_regrole('${papel}') is null then 'sem-role'
                      when has_function_privilege('${papel}',
                             'public.fn_lgpd_redigir_secoes_de_modulo()', 'execute') then 'exposta'
                      else 'fechada' end;
        `),
        `gatilho de LGPD executável por ${papel}`,
      ).toBe("fechada");
    }
  });

  it("a segunda anonimização não redige de novo (o gatilho é a virada false → true)", () => {
    // A guarda `when (new.is_anonymized and not old.is_anonymized)` — repetir a chamada não
    // pode ser erro nem mudar o que já foi redigido.
    expect(() => anonimizar(ALVO)).not.toThrow();
    expect(linhaDe(ALVO)).toBe(`<null>|${rotuloDe(ALVO)}`);
    expect(linhaDe(VIZINHO)).toBe("O nome de Joao Vizinho|querido Joao Vizinho");
  });

  it("a contagem fecha: o que este arquivo cuida é isto, e não um subconjunto", () => {
    expect(sql(`select count(*) from public.sonda_secao_modulo;`)).toBe("4");
    expect(sql(`select count(*) from public.contacts where organization_id = '${ORG}';`)).toBe("4");
  });
});
