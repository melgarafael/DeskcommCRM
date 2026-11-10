import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * AS TRÊS CÓPIAS DO MESMO `create extension` — e a que vai mentir primeiro.
 *
 * ─── O defeito, e o preço que esta casa já pagou por ele ────────────────────
 *
 * O passo que habilita as extensões antes do baseline está escrito em TRÊS
 * documentos: `README.md`, `docs/SETUP.md` e `README.en.md`. É o mesmo literal de
 * três linhas, copiado. E é o mesmo defeito que o #817 cobrou caro: o host da
 * Graph vivia em onze linhas de seis arquivos, e cada cópia envelhecia sozinha.
 *
 * A falha aqui não é cosmética. No dia em que o schema passar a exigir uma quarta
 * extensão, alguém atualiza dois arquivos e o terceiro continua ensinando o passo
 * de ontem. O sintoma chega na cara de quem instala, na primeira instrução do
 * produto, e é literalmente `type public.vector does not exist` — um erro de
 * Postgres num documento que se lê como receita. Medido em 2026-11-03: o bloco
 * existe em `README.md` e em `docs/SETUP.md` e NÃO existe em `README.en.md`; a
 * linha em prosa logo acima ("habilite antes as extensões que o schema usa")
 * está lá nos três, prometendo um passo que só dois entregam.
 *
 * ─── Por que isto é cerca estática e não refatoração de doc ──────────────────
 *
 * A tentação é extrair o bloco para um lugar só e linká-lo. Isso muda o produto
 * de quem instala — o README é lido no GitHub e copiado à mão, e um link no meio
 * de um bloco de shell é um passo a mais entre a pessoa e um banco que sobe. A
 * cerca resolve o defeito sem tocar no que a pessoa lê: as cópias continuam,
 * mas a divergência passa a reprovar no CI em vez de aparecer num erro de banco.
 * E ela nasce contra o estado real, não contra um estado ideal (ver a dívida
 * congelada abaixo).
 *
 * ─── O que a extração NÃO usa: número de linha ──────────────────────────────
 *
 * Tudo é lido por CONTEÚDO e medido por índice relativo dentro do arquivo. Número
 * de linha absoluto é a forma mais rápida de uma cerca morrer: qualquer parágrafo
 * novo acima do bloco a deixa apontando para prosa.
 */

const RAIZ = path.resolve(__dirname, "../..");

/** Os documentos que ENSINAM a instalar. É a lista inteira do gênero, não uma amostra. */
const DOCUMENTOS = ["README.md", "docs/SETUP.md", "README.en.md"];

/** O documento que os outros têm de espelhar. Se ele mudar, os outros o seguem. */
const REFERENCIA = "README.md";

/**
 * O que o schema EXIGE e o baseline NÃO cria — ou seja: o passo manual precisa
 * existir. A régua não é opinião: `supabase/baseline.sql` usa `public.vector`,
 * `public.citext` e `public.gin_trgm_ops` muito antes de criar qualquer uma delas.
 * O primeiro `gin_trgm_ops` é o índice `idx_contacts_org_name_trgm`, no começo do
 * dump, e o `create extension pg_trgm with schema public` que o #3936 pôs no
 * apêndice vem dezenas de milhares de linhas depois — tarde demais para quem aplica
 * com `ON_ERROR_STOP=1`. `vector` e `citext` o baseline não cria nunca. `pgcrypto`
 * ele cria sozinho, em `extensions`, e por isso fica fora do passo manual: o teste
 * do caso pgcrypto prova isso em vez de confiar neste comentário.
 */
const EXIGIDAS = ["vector", "citext", "pg_trgm"];

/**
 * DÍVIDA CONGELADA — defeito novo reprovado, dívida velha com prazo e cobrador.
 *
 * Vazia hoje, e a história importa: ela nasceu com UMA entrada — `README.en.md`,
 * que não tinha o bloco de extensões — apontando para o PR #3930. O #3930 foi
 * mergeado em 2026-11-03T20:19Z e o último teste deste arquivo reprovou na hora,
 * exigindo que a entrada saísse. A dívida foi paga no mesmo dia em que foi
 * contraída, e é assim que esta lista deve se comportar: entrada aqui é estado
 * transitório, nunca moradia.
 *
 * O mecanismo fica de pé (e provado) porque a próxima divergência transitória vai
 * precisar dele: a saída é a da casa, o mesmo padrão de `MIGRATIONS_QUE_NAO_RODAM`
 * — lista EXPLÍCITA, com dono, e o último teste cobrando a remoção quando o
 * defeito deixar de existir.
 *
 * Escrever aqui o PR não é burocracia: é o que permite a quem revisar saber, sem
 * `git log`, se a entrada ainda tem motivo para existir.
 */
const DIVERGENCIAS_CONGELADAS: ReadonlyArray<{ arquivo: string; motivo: string }> = [];

/**
 * `create extension [if not exists] <nome> [with schema <schema>]`.
 *
 * `if not exists` é opcional de propósito: a forma sem ele também é uma declaração
 * de dependência, e uma cópia que perca o `if not exists` divergiria em silêncio se
 * a regex só aceitasse a forma canônica. Idempotência é justamente o que torna o
 * baseline reaplicável — a cerca não pode ignorar quem a perde.
 */
const DECLARACAO =
  /create\s+extension\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)(?:\s+with\s+schema\s+([a-z0-9_]+))?/gi;

/** A linha que APLICA o schema. Extensão habilitada depois dela é instrução inútil. */
const APLICA_O_BASELINE = /psql[^\n]*-f\s+supabase\/baseline\.sql/;

interface Declaracao {
  nome: string;
  schema: string | null;
  /** índice 0-based da linha no arquivo — comparado com outro índice, nunca impresso como "linha N". */
  indice: number;
}

function linhas(doc: string): string[] {
  return fs.readFileSync(path.join(RAIZ, doc), "utf8").split("\n");
}

function extensoesDeclaradas(doc: string): Declaracao[] {
  const declaradas: Declaracao[] = [];
  linhas(doc).forEach((linha, indice) => {
    // `matchAll` devolve `undefined` por grupo ausente e o repo tem
    // `noUncheckedIndexedAccess`: o nome é lido com guarda, não com `!`.
    for (const casamento of linha.matchAll(DECLARACAO)) {
      const nome = casamento[1];
      if (!nome) continue;
      declaradas.push({
        nome: nome.toLowerCase(),
        schema: casamento[2]?.toLowerCase() ?? null,
        indice,
      });
    }
  });
  return declaradas;
}

/** Conjunto comparável: nome + schema, ordenado. `public.vector` ≠ `vector` sem schema. */
function conjunto(doc: string): string[] {
  return extensoesDeclaradas(doc)
    .map((d) => `${d.nome}@${d.schema ?? "(sem schema)"}`)
    .sort();
}

function indiceQueAplicaOBaseline(doc: string): number {
  return linhas(doc).findIndex((linha) => APLICA_O_BASELINE.test(linha));
}

function congelado(doc: string): boolean {
  return DIVERGENCIAS_CONGELADAS.some((d) => d.arquivo === doc);
}

describe("o bloco de `create extension` do setup diz o mesmo nos três documentos", () => {
  it("controle: os três documentos existem e a extração acha o bloco", () => {
    // Sem esta asserção a cerca passaria verde lendo zero arquivo (path errado) ou
    // extraindo zero extensão (regex quebrada) — o modo de falha mais barato que
    // existe, e o único que faz um gate morto parecer cobertura.
    for (const doc of DOCUMENTOS) {
      expect(fs.existsSync(path.join(RAIZ, doc)), `documento sumiu: ${doc}`).toBe(true);
      expect(linhas(doc).length, `${doc} está vazio`).toBeGreaterThan(100);
    }

    // A régua viva: a extração no arquivo de referência devolve exatamente o que o
    // doc afirma. Se este `toEqual` quebrar, o problema é a regex — conserte a
    // extração, não o documento.
    expect(conjunto(REFERENCIA).join(" ")).toBe(
      ["citext@public", "pg_trgm@public", "vector@public"].join(" "),
    );

    // Confere que o README.en.md, o último a receber o bloco (#3930), é LIDO: ele
    // tem prosa própria e a régua abaixo é medida nele de verdade.
    expect(linhas("README.en.md").join("\n")).toContain("baseline.sql");
  });

  it("⭐ os documentos que ensinam a instalar declaram o MESMO conjunto de extensões", () => {
    const referencia = conjunto(REFERENCIA).join(" ");

    const divergentes = DOCUMENTOS.filter((doc) => doc !== REFERENCIA && !congelado(doc))
      .filter((doc) => conjunto(doc).join(" ") !== referencia)
      .map((doc) => `${doc} declara [${conjunto(doc).join(", ") || "nada"}]`);

    expect(
      divergentes,
      `o passo de extensões divergiu entre os documentos (referência: ${REFERENCIA} = [${referencia}]):\n` +
        `${divergentes.join("\n")}\n` +
        "As cópias são literais e não podem envelhecer separadas: iguale o bloco inteiro, " +
        "incluindo o `with schema`, ou registre em DIVERGENCIAS_CONGELADAS com o PR que conserta.",
    ).toEqual([]);
  });

  it("cada documento cobre o que o schema exige, e com o MESMO schema", () => {
    const faltando: string[] = [];
    const schemaErrado: string[] = [];

    for (const doc of DOCUMENTOS) {
      if (congelado(doc)) continue; // coberto pela dívida congelada, cobrada no último teste
      const declaradas = extensoesDeclaradas(doc);
      const nomes = declaradas.map((d) => d.nome);

      for (const exigida of EXIGIDAS) {
        if (!nomes.includes(exigida)) faltando.push(`${doc} → falta \`${exigida}\``);
      }

      for (const d of declaradas) {
        // As três moram em `public` nesta instalação, e é de lá que o baseline as
        // referencia (`public.gin_trgm_ops`, `"public"."vector"`). Habilitar em
        // `extensions` faria o doc ensinar um caminho que o schema não usa.
        if (d.schema !== "public") schemaErrado.push(`${doc} → \`${d.nome}\` com schema ${d.schema ?? "nenhum"}`);
      }
    }

    expect(faltando, `extensão exigida pelo schema e ausente do passo manual:\n${faltando.join("\n")}`).toEqual([]);
    expect(
      schemaErrado,
      `extensão habilitada fora de \`public\` — o baseline a referencia em public:\n${schemaErrado.join("\n")}`,
    ).toEqual([]);
  });

  it("⭐ o bloco aparece ANTES da linha que aplica o baseline", () => {
    // Ordem errada é o defeito que a igualdade entre arquivos NÃO pega: as três
    // cópias podem ser idênticas e todas estarem do lado errado do `psql -f`. E aí
    // a instrução é inútil por construção — o baseline para no primeiro tipo que
    // não existe, e o passo que o habilitaria vem depois do erro.
    const problemas: string[] = [];

    for (const doc of DOCUMENTOS) {
      const bloco = extensoesDeclaradas(doc);
      const baseline = indiceQueAplicaOBaseline(doc);

      if (bloco.length === 0) {
        if (!congelado(doc)) problemas.push(`${doc} → não declara extensão nenhuma`);
        continue; // arquivo congelado sem bloco: a ordem não tem o que medir
      }

      if (baseline === -1) {
        problemas.push(`${doc} → declara extensões mas nunca aplica \`supabase/baseline.sql\`: bloco órfão`);
        continue;
      }

      const primeiro = Math.min(...bloco.map((d) => d.indice));
      if (primeiro >= baseline) {
        problemas.push(
          `${doc} → o bloco (índice ${primeiro}) vem DEPOIS da aplicação do baseline (índice ${baseline})`,
        );
      }
    }

    expect(
      problemas,
      `o passo de extensões não está onde precisa estar:\n${problemas.join("\n")}\n` +
        "Extensão habilitada depois do `psql -f supabase/baseline.sql` não habilita nada: o baseline " +
        "já parou em `type public.vector does not exist`.",
    ).toEqual([]);
  });

  it("⭐ extensão que o baseline cria em OUTRO schema não entra no passo manual (o caso pgcrypto)", () => {
    // O doc mente de dois jeitos: esquecendo o passo que existe e ANUNCIANDO um passo
    // que ninguém precisa. O baseline cria `pgcrypto WITH SCHEMA extensions` por
    // conta própria — pedir que a pessoa crie antes é ensinar trabalho
    // inútil, e pior: se um dia ele mudar de schema, sobra uma linha no doc criando
    // a extensão no lugar errado, que é o que faz o baseline falhar depois.
    //
    // O recorte é `fora do public` de propósito, e ele foi MEDIDO, não escolhido no
    // gosto: em 2026-11-03, horas depois desta cerca nascer, o `#3936` passou a criar
    // `pg_trgm with schema public` no próprio baseline (o índice trigram da busca sem
    // acento). A versão anterior desta asserção reprovava os três documentos por
    // citarem `pg_trgm` — e era falso positivo: as linhas do doc continuam VERDADEIRAS
    // (com `if not exists`, criar em `public` quando já existe em `public` é no-op, e
    // criar quando não existe é exatamente o que o índice precisa). O que o doc não
    // pode fazer é anunciar como passo manual uma extensão que o baseline instala num
    // schema que o doc não menciona — aí a instrução manda a pessoa para o lugar errado.
    //
    // A lista é CALCULADA do baseline, não escrita à mão: a próxima extensão que ele
    // criar fora de `public` entra nesta regra sozinha.
    const criadasForaDoPublic = extensoesDeclaradas("supabase/baseline.sql")
      .filter((d) => d.schema !== null && d.schema !== "public")
      .map((d) => d.nome);
    expect(criadasForaDoPublic, "o baseline não cria mais `pgcrypto` fora de `public` — a régua desta cerca mudou").toContain(
      "pgcrypto",
    );

    const anunciadas: string[] = [];
    for (const doc of DOCUMENTOS) {
      for (const d of extensoesDeclaradas(doc)) {
        if (criadasForaDoPublic.includes(d.nome)) {
          anunciadas.push(`${doc} → \`${d.nome}\` (o baseline já a cria, e fora de \`public\`)`);
        }
      }
    }

    expect(
      anunciadas,
      `passo manual para extensão que o baseline habilita sozinho em outro schema:\n${anunciadas.join("\n")}\n` +
        "Remova a linha do doc; `pgcrypto` fica de fora do bloco de propósito.",
    ).toEqual([]);
  });

  it("`unaccent` fica de fora do bloco, e o teste guarda o motivo", () => {
    // `unaccent` NÃO é passo manual do setup, por um motivo estrutural: quem precisa
    // dela é a migration `20261103150000_9098_busca_do_inbox_sem_acento.sql` (PR
    // #3924), e essa migration a habilita INLINE com `create extension if not exists
    // unaccent;` — quem aplica a migration num banco existente ganha a extensão
    // junto, sem depender de doc nenhum. Exigi-la aqui faria o setup ensinar uma
    // dependência que o schema não tem (medido: `git grep unaccent origin/main --
    // supabase/` devolve 0 no dia em que esta cerca nasceu).
    //
    // Hoje o apêndice do `baseline.sql` cria `unaccent` (em `public`, quando ela
    // ainda não existe em lugar nenhum) antes de qualquer uso dela. Por estar em
    // `public`, ela NÃO cai na regra do teste acima, que só barra o que o baseline
    // cria fora de `public`. O motivo de ficar fora do bloco é outro: o baseline já a
    // cria antes de precisar dela, coisa que não acontece com o `pg_trgm`.
    const comUnaccent = DOCUMENTOS.flatMap((doc) =>
      extensoesDeclaradas(doc)
        .filter((d) => d.nome === "unaccent")
        .map(() => `${doc} → \`unaccent\``),
    );

    expect(
      comUnaccent,
      `\`unaccent\` entrou no passo manual:\n${comUnaccent.join("\n")}\n` +
        "Ela vem pela própria migration 9098 (`create extension if not exists unaccent`), inline.",
    ).toEqual([]);

    // Onde a justificativa é verificável, ela é verificada: se a migration 9098 já
    // está no tree (o #3924 mergeou), ela tem de criar a extensão por conta própria.
    const migration9098 = "supabase/migrations/20261103150000_9098_busca_do_inbox_sem_acento.sql";
    if (fs.existsSync(path.join(RAIZ, migration9098))) {
      const texto = fs.readFileSync(path.join(RAIZ, migration9098), "utf8");
      expect(
        texto,
        `${migration9098} deixou de habilitar \`unaccent\` inline — aí o doc precisa do passo manual de volta`,
      ).toMatch(/create\s+extension\s+if\s+not\s+exists\s+unaccent/i);
    }
  });

  it("⭐ a dívida congelada se cobra: quem deixou de divergir exige a entrada FORA da lista", () => {
    // Esta é a metade que impede a lista de virar cemitério. O padrão oposto — só
    // ignorar o arquivo listado — faz a exceção sobreviver ao defeito, e daqui a um
    // ano ninguém sabe se a linha ainda tem motivo. Aqui, a lista é uma promessa com
    // vencimento: foi o que aconteceu com o #3930 — ele entrou, este teste reprovou
    // e a entrada saiu no mesmo dia. É de propósito.
    const referencia = conjunto(REFERENCIA).join(" ");
    const pagas: string[] = [];

    for (const { arquivo, motivo } of DIVERGENCIAS_CONGELADAS) {
      expect(motivo, `${arquivo} está congelado sem citar o PR/issue que paga a dívida`).toMatch(/#\d+/);

      if (!fs.existsSync(path.join(RAIZ, arquivo))) continue; // o controle já reprova arquivo sumido

      if (conjunto(arquivo).join(" ") === referencia) {
        pagas.push(`${arquivo} → já declara [${referencia}]`);
      }
    }

    expect(
      pagas,
      `dívida paga: o arquivo congelado deixou de divergir — remova a entrada de DIVERGENCIAS_CONGELADAS:\n` +
        `${pagas.join("\n")}\n` +
        "A exceção existe para o intervalo em que o PR está aberto, não para sempre.",
    ).toEqual([]);
  });

  it("nenhuma entrada congelada é de arquivo que ainda diverge por motivo diferente do registrado", () => {
    // Fecha o buraco do teste anterior por baixo: um arquivo pode DIVERGIR e a
    // entrada continuar válida — mas só se ele não declarar NADA. Se ele declarar um
    // subconjunto (alguém colou metade do bloco), a dívida virou outro defeito: não
    // é mais "o bloco não chegou", é "o bloco chegou errado", e a exceção deixaria
    // isso passar verde para sempre.
    const meioBloco = DIVERGENCIAS_CONGELADAS.filter(({ arquivo }) => {
      if (!fs.existsSync(path.join(RAIZ, arquivo))) return false;
      const declaradas = extensoesDeclaradas(arquivo);
      return declaradas.length > 0 && conjunto(arquivo).join(" ") !== conjunto(REFERENCIA).join(" ");
    }).map(({ arquivo }) => `${arquivo} declara [${conjunto(arquivo).join(", ")}]`);

    expect(
      meioBloco,
      `arquivo congelado com bloco PARCIAL — a exceção tolera ausência, não divergência parcial:\n` +
        `${meioBloco.join("\n")}\n` +
        "Complete o bloco (copie de README.md inteiro) ou corrija o documento.",
    ).toEqual([]);
  });
});
