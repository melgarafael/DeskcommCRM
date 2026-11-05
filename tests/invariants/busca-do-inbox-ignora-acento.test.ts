import { beforeAll, describe, expect, it } from "vitest";

import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

import { lastLine, sql } from "./gov-helpers";

/**
 * A BUSCA DO INBOX CASCA SEM ACENTO NO BANCO DE VERDADE (issue #3918, fatia 1).
 *
 * ─── Por que este arquivo existe, se já há um teste de unidade ───────────────
 * O teste de unidade (`tests/unit/busca-do-inbox-ignora-acento.test.ts`) prova a
 * FORMA do filtro que o handler monta — que ele mira `contacts.busca_sem_acento`
 * e manda o termo limpo. Ele não prova que o banco CASA, porque um dublê de
 * Supabase não tem `unaccent`, nem coluna gerada, nem índice. A conclusão da
 * issue ("digitar Andreia acha Andréia") é uma afirmação sobre o Postgres, e é
 * aqui que ela se mede.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 * A busca mandava `display_name.ilike.*Andreia*`. `ILIKE` dobra a CAIXA, não o
 * ACENTO: `lower('Á') = 'á'`, que não é `'a'`. Zero resultados para um contato
 * que existe — e é o caso comum no Brasil, onde a mesma pessoa é escrita com e
 * sem acento e quem digita é o atendente, com pressa.
 *
 * ─── As quatro afirmações que este arquivo faz, e por que cada uma ──────────
 * 1. A coluna existe, é GERADA, e é gerada das TRÊS colunas de nome. Sem isto,
 *    uma coluna que só olhasse `display_name` passaria nos pares abaixo e
 *    perderia `name` e o nome da agenda (#2439).
 * 2. Cada par do relato casa nos DOIS sentidos (com acento ↔ sem acento).
 * 3. A regra do TypeScript e a do banco são a MESMA — matriz de nomes,
 *    comparando `lower(public.f_unaccent(x))` com `termoSemAcento(x)`. É a
 *    classe de defeito que já custou caro neste repo: duas cópias da mesma regra
 *    passam cada uma no próprio teste e divergem no meio.
 * 4. O `%` digitado continua LITERAL, e a coluna gerada não guarda nome de
 *    contato anonimizado (LGPD).
 */

// Ids próprios (prefixo da issue): o `dddddddd-3333-…` já é contato de outros
// invariantes, em OUTRA organização, e o `on conflict (id)` abaixo herdaria a
// organização de quem rodasse antes.
const ORG = "39180000-0000-4000-8000-000000000001";

/** Um contato por par do relato, mais o de `%` e o que será anonimizado. */
const CONTATOS: Array<{
  id: string;
  display: string | null;
  nome: string | null;
  agenda: string | null;
}> = [
  {
    id: "39180000-3333-4000-8000-000000000001",
    display: "Andréia Souza",
    nome: null,
    agenda: null,
  },
  { id: "39180000-3333-4000-8000-000000000002", display: null, nome: "Letícia Lima", agenda: null },
  { id: "39180000-3333-4000-8000-000000000003", display: "João Pereira", nome: null, agenda: null },
  {
    id: "39180000-3333-4000-8000-000000000004",
    display: "Conceição Alves",
    nome: null,
    agenda: null,
  },
  { id: "39180000-3333-4000-8000-000000000005", display: "Julia Ramos", nome: null, agenda: null },
  // O nome da agenda do celular só existe lá (#2439): a busca tem de alcançá-lo.
  {
    id: "39180000-3333-4000-8000-000000000006",
    display: null,
    nome: null,
    agenda: "Joaquim da Agenda",
  },
  // Controle do curinga: um `%` LITERAL no nome. Sem o escape, buscar `%`
  // devolveria a organização inteira.
  {
    id: "39180000-3333-4000-8000-000000000007",
    display: "Maria 100% Certeza",
    nome: null,
    agenda: null,
  },
  // Vai ser anonimizado no último caso.
  {
    id: "39180000-3333-4000-8000-000000000008",
    display: "Titular Anonimizado",
    nome: null,
    agenda: null,
  },
];

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * O padrão como o handler o monta: termo normalizado (sem acento, minúsculo) e
 * curinga escapado com `\`. `%` e `_` são metacaractere do LIKE, e um `%` que o
 * usuário digita não pode virar "case tudo".
 */
function padraoDoHandler(termo: string): string {
  return `%${termoSemAcento(termo).replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
}

/** Ids da organização que casam o termo, na mesma forma que o handler usa. */
function achar(termo: string): string[] {
  const out = sql(`
    select 'C:' || id
      from public.contacts
     where organization_id = ${lit(ORG)}
       and is_anonymized = false
       and busca_sem_acento like ${lit(padraoDoHandler(termo))}
     order by id;
  `);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("C:"))
    .map((l) => l.slice(2));
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values (${lit(ORG)}, 'busca-sem-acento-3918', 'Busca sem acento', 'Busca sem acento')
      on conflict (id) do nothing;
  `);
  for (const c of CONTATOS) {
    sql(`
      insert into public.contacts (id, organization_id, display_name, name, address_book_name)
        values (${lit(c.id)}, ${lit(ORG)}, ${c.display === null ? "null" : lit(c.display)},
                ${c.nome === null ? "null" : lit(c.nome)}, ${c.agenda === null ? "null" : lit(c.agenda)})
        on conflict (id) do update
          set display_name = excluded.display_name,
              name = excluded.name,
              address_book_name = excluded.address_book_name,
              is_anonymized = false;
    `);
  }
});

describe("busca do inbox sem acento — o banco", () => {
  it("a coluna existe, é GERADA, e é gerada das três colunas de nome", () => {
    expect(
      lastLine(
        sql(`select is_generated || ':' || data_type from information_schema.columns
              where table_schema = 'public' and table_name = 'contacts'
                and column_name = 'busca_sem_acento';`),
      ),
      "a coluna `contacts.busca_sem_acento` não nasceu GERADA — uma coluna mantida à mão " +
        "guarda o nome antigo depois da anonimização",
    ).toBe("ALWAYS:text");

    const expressao = lastLine(
      sql(`select pg_get_expr(d.adbin, d.adrelid)
             from pg_attrdef d
             join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
            where d.adrelid = 'public.contacts'::regclass
              and a.attname = 'busca_sem_acento';`),
    );
    // Controle de vacuidade: sem estes três, a coluna poderia estar normalizando
    // um campo só e passar em todos os pares abaixo.
    for (const coluna of ["display_name", "name", "address_book_name"]) {
      expect(expressao, `a coluna gerada ignora \`${coluna}\``).toContain(coluna);
    }
    expect(expressao, "a coluna gerada não passa por `f_unaccent`").toContain("f_unaccent");
  });

  it("⭐ os pares do relato casam nos DOIS sentidos", () => {
    const pares: Array<[semAcento: string, comAcento: string, id: string]> = [
      ["andreia", "Andréia", CONTATOS[0]!.id],
      ["leticia", "Letícia", CONTATOS[1]!.id],
      ["joao", "João", CONTATOS[2]!.id],
      ["conceicao", "Conceição", CONTATOS[3]!.id],
      ["julia", "Júlia", CONTATOS[4]!.id],
      // O nome da agenda do celular (#2439): a lista o mostra, a busca o acha.
      ["joaquim", "Joaquim", CONTATOS[5]!.id],
    ];

    for (const [semAcento, comAcento, id] of pares) {
      expect(achar(semAcento), `"${semAcento}" não achou o contato "${comAcento}"`).toContain(id);
      expect(achar(comAcento), `"${comAcento}" não achou o próprio contato`).toContain(id);
      // A direção que a issue relata como "e o contrário também": maiúscula não
      // pode atrapalhar (o `like` é case-sensitive; a coluna é minúscula).
      expect(
        achar(comAcento.toUpperCase()),
        `"${comAcento.toUpperCase()}" não achou o contato`,
      ).toContain(id);
    }
  });

  it("⭐ a regra do TypeScript e a do banco são a MESMA (matriz de nomes)", () => {
    // Duas cópias da mesma normalização — uma em SQL (coluna gerada), outra em
    // TS (termo) — passam cada uma no próprio teste e divergem no meio. Aqui as
    // duas são comparadas item a item, que é o único jeito de saber.
    const nomes = [
      "Andréia",
      "Letícia",
      "João",
      "Conceição",
      "Júlia",
      "Ávila",
      "Ângela",
      "Antônio",
      "Luís",
      "Íris",
      "Ürsula",
      "Öster",
      "Ñandu",
      "Çedilha",
      "Øyvind",
      "Łukasz",
      "Straße",
      "Ægir",
      "Œuvre",
      "Þór",
      "Mãe d'Água",
      "  espaços  ",
      "MAIÚSCULA",
      "",
    ];

    const divergentes: string[] = [];
    for (const nome of nomes) {
      // ─── Por que HEX, e não a string ────────────────────────────────────────
      // O `sql()` do harness faz `.trim()` na saída inteira, e o psql corta o
      // que parece espaço de moldura: comparar `'  espaços  '` por texto mediu o
      // INSTRUMENTO, não a normalização (divergência de 1 caso, que não existia
      // no banco). Em hex, espaço e string vazia são bytes como qualquer outro.
      const noBanco = lastLine(
        sql(`select encode(convert_to(lower(public.f_unaccent(${lit(nome)})), 'UTF8'), 'hex');`),
      );
      const noTs = Buffer.from(termoSemAcento(nome), "utf8").toString("hex");
      if (noBanco !== noTs) {
        divergentes.push(`${JSON.stringify(nome)} → banco ${noBanco} × TS ${noTs}`);
      }
    }

    expect(
      divergentes,
      "a normalização do banco e a do TypeScript divergiram — o termo limpo não casa mais " +
        "a coluna, e nenhum dos dois lados acusa sozinho",
    ).toEqual([]);
  });

  it("⛔ o `%` digitado continua LITERAL — não abre a busca", () => {
    // Sem escape, `like '%%%'` casa a organização inteira — e "a lista toda" se
    // parece com "a busca funcionou". O controle positivo é o contato cujo nome
    // TEM um `%`: ele é o único que pode aparecer.
    expect(achar("%"), "o `%` virou curinga: a busca passou a casar tudo").toEqual([
      CONTATOS[6]!.id,
    ]);
    expect(achar("_"), "o `_` virou curinga de um caractere").toEqual([]);
    expect(achar("maria 100%"), "o `%` literal dentro do nome não foi achado").toEqual([
      CONTATOS[6]!.id,
    ]);
  });

  it("a coluna gerada não guarda o nome de contato anonimizado (LGPD)", () => {
    // Gatilho que esquecesse a linha deixaria o nome antigo encontrável — o
    // vazamento que a busca já evita com `is_anonymized = false`. Coluna gerada
    // recalcula junto com o campo que a alimenta, e é por isso que ela é gerada.
    const alvo = CONTATOS[7]!.id;
    sql(`
      update public.contacts
         set display_name = null, name = null, address_book_name = null
       where id = ${lit(alvo)};
    `);
    expect(
      lastLine(
        sql(
          `select coalesce(busca_sem_acento, '<nulo>') from public.contacts where id = ${lit(alvo)};`,
        ),
      ),
    ).toBe("");
    expect(
      achar("anonimizado"),
      "o nome antigo continua encontrável depois de apagar o campo",
    ).not.toContain(alvo);
  });

  it("o índice de trigrama serve a consulta (e o limite dele está declarado)", () => {
    // `enable_seqscan = off` dentro de transação é a mesma técnica de
    // `tests/invariants/indices-do-caminho-quente`: existir não basta, o plano
    // precisa alcançar o índice.
    const plano = sql(`
      begin;
      set local enable_seqscan = off;
      explain (costs off) select id from public.contacts where busca_sem_acento like '%andreia%';
      rollback;
    `);
    expect(plano, "o índice existe mas o plano não o alcança").toContain(
      "idx_contacts_busca_sem_acento_trgm",
    );

    // ⚠️ LIMITE MEDIDO, e é por isso que ele está escrito num teste: padrão com
    // menos de 3 caracteres não rende trigrama nenhum, e o índice só varre a si
    // mesmo. O piso da rota é 2 (`PISO_DA_BUSCA`), então termo de 2 letras
    // continua sendo varredura, como antes desta mudança — não é regressão, é o
    // mesmo custo de hoje com o resultado certo.
    const planoCurto = sql(`
      begin;
      set local enable_seqscan = off;
      explain (costs off) select id from public.contacts where busca_sem_acento like '%an%';
      rollback;
    `);
    expect(
      planoCurto,
      "o plano mudou de forma para termo curto — reveja o limite declarado",
    ).toContain("busca_sem_acento");
  });
});
