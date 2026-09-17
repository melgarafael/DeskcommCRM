/**
 * O `baseline.sql` não pode exigir Postgres acima do piso que dizemos suportar.
 *
 * POR QUE ESTE GATE EXISTE
 *
 * O piso real do arquivo é **pg15** — `security_invoker` em view
 * (`baseline.sql:1215`), pg15+. Mesmo assim o projeto passou a exigir **pg17**,
 * e não por decisão de ninguém: o baseline é um `pg_dump --schema-only` tirado
 * de um projeto Supabase gerenciado rodando pg17 (`supabase/migrations/MANIFEST.md:3`),
 * e o dump serializou o ACL das 4 tabelas append-only emitindo `GRANT … MAINTAIN`
 * — privilégio que só existe a partir do pg17. Nove tokens. Nenhum autor os
 * escreveu, nenhum código do projeto usa o privilégio, nenhum teste o assertava.
 *
 * O `supabase/config.toml` então CEDEU ao dump: era `major_version = 15` e foi
 * empurrado para 17 (`docs/testing/HANDOFF-vps-qa.md:61-63`) porque contribuidor
 * rodando `supabase start` pegava pg15 e o baseline quebrava.
 *
 * O acoplamento é de PARSE, não de runtime: `install.sh` aplica o baseline com
 * `ON_ERROR_STOP=1`, então UM token desconhecido aborta o arquivo inteiro e o
 * clone fica sem schema. Não é degradação — é instalação que não acontece.
 *
 * A causa é estrutural e vai se repetir: toda vez que alguém regerar o baseline
 * a partir de um Supabase mais novo, o `pg_dump` pode emitir sintaxe nova sem
 * que ninguém tenha pedido. Prosa não pega isso — o arquivo tem 17 mil linhas e
 * ninguém revisa um dump. Por isso o gate é mecânico.
 *
 * O QUE ELE NÃO É
 *
 * Não é um parser de SQL nem um validador de versão. É uma catraca sobre uma
 * lista de tokens conhecidos, deliberadamente estreita: prefere deixar passar
 * uma construção que ninguém previu a reprovar um dump legítimo por falso
 * positivo. Quando um token novo aparecer, ele entra nesta lista.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "../..");
const BASELINE = path.join(RAIZ, "supabase/baseline.sql");

/**
 * Cada entrada: o que procurar, em que versão apareceu, e o que dizer a quem
 * for consertar. A mensagem importa tanto quanto a detecção — quem topa com
 * isto meses depois não tem o contexto que temos hoje.
 */
const ACIMA_DO_PISO: ReadonlyArray<{
  nome: string;
  desde: string;
  padrao: RegExp;
  saida: string;
}> = [
  {
    nome: "GRANT … MAINTAIN",
    desde: "pg17",
    padrao: /\bMAINTAIN\b/g,
    saida:
      "remova só o token da lista de privilégios (`,MAINTAIN` → nada). " +
      "Ele concede VACUUM/ANALYZE/REINDEX e nenhum código usa; o append-only " +
      "das tabelas de auditoria vem da AUSÊNCIA de UPDATE/DELETE, não daqui.",
  },
  {
    nome: "JSON_TABLE / JSON_VALUE / JSON_QUERY / JSON_EXISTS",
    desde: "pg17",
    padrao: /\bJSON_(TABLE|VALUE|QUERY|EXISTS)\s*\(/gi,
    saida: "reescreva com os operadores jsonb clássicos (`->`, `->>`, `jsonb_path_query`).",
  },
  {
    nome: "random() com dois argumentos",
    desde: "pg17",
    padrao: /\brandom\s*\([^)]+,/gi,
    saida: "use `random()` sem argumentos e faça a escala em SQL.",
  },
  {
    nome: "COPY … ON_ERROR",
    desde: "pg17",
    padrao: /\bON_ERROR\s+(ignore|stop)\b/gi,
    saida: "o baseline não deveria carregar dados por COPY tolerante a erro.",
  },
  {
    nome: "SPLIT PARTITION / MERGE PARTITIONS",
    desde: "pg17",
    padrao: /\b(SPLIT\s+PARTITION|MERGE\s+PARTITIONS)\b/gi,
    saida: "o schema não tem partições; se passar a ter, o piso sobe junto.",
  },
  {
    nome: "uuid_extract_timestamp / to_bin / to_oct / pg_basetype",
    desde: "pg17",
    padrao: /\b(uuid_extract_timestamp|to_bin|to_oct|pg_basetype)\s*\(/gi,
    saida: "calcule na aplicação, não no schema.",
  },
  {
    nome: "SYSTEM_USER",
    desde: "pg16",
    padrao: /\bSYSTEM_USER\b/g,
    saida: "use `current_user` / `session_user`.",
  },
  {
    nome: "pg_input_is_valid",
    desde: "pg16",
    padrao: /\bpg_input_is_valid\s*\(/gi,
    saida: "valide com CHECK explícito ou na aplicação.",
  },
  {
    nome: "any_value / array_shuffle / array_sample",
    desde: "pg16",
    padrao: /\b(any_value|array_shuffle|array_sample)\s*\(/gi,
    saida: "use min()/max() ou ordene na aplicação.",
  },
];

function ocorrencias(sql: string, padrao: RegExp): number[] {
  const linhas: number[] = [];
  sql.split("\n").forEach((linha, i) => {
    // `lastIndex` de um regex /g é estado: sem zerar, a busca da linha N+1
    // começa de onde a da linha N parou e some com achados.
    padrao.lastIndex = 0;
    if (padrao.test(linha)) linhas.push(i + 1);
  });
  return linhas;
}

describe("o baseline fica no piso de Postgres que dizemos suportar", () => {
  const sql = readFileSync(BASELINE, "utf8");

  it("o arquivo foi lido de verdade — controle negativo antes de qualquer conclusão", () => {
    // Um `readFileSync` que devolvesse vazio faria TODOS os casos abaixo
    // passarem, medindo o nada. Duas âncoras: tamanho e um marco conhecido.
    expect(sql.length).toBeGreaterThan(500_000);
    expect(sql).toContain("public.organizations");
  });

  it.each(ACIMA_DO_PISO)("não usa $nome ($desde)", ({ nome, desde, padrao, saida }) => {
    const linhas = ocorrencias(sql, padrao);
    expect(
      linhas,
      linhas.length === 0
        ? ""
        : `supabase/baseline.sql usa ${nome}, que exige ${desde}, nas linhas ` +
          `${linhas.slice(0, 12).join(", ")}${linhas.length > 12 ? ` (+${linhas.length - 12})` : ""}.\n` +
          `O instalador aplica o baseline com ON_ERROR_STOP=1: um token que o servidor ` +
          `não conhece aborta o ARQUIVO INTEIRO e o clone fica sem schema.\n` +
          `Saída: ${saida}`,
    ).toEqual([]);
  });

  it("os padrões estão vivos — controle positivo, senão o gate mede o vazio", () => {
    // Sem isto, um regex quebrado (ou um `ocorrencias` que sempre devolve [])
    // deixaria a suíte verde para sempre. Cada padrão é confrontado com um
    // trecho que ELE tem de reprovar.
    const iscas: Record<string, string> = {
      "GRANT … MAINTAIN": 'GRANT SELECT,MAINTAIN ON TABLE "public"."x" TO "anon";',
      "JSON_TABLE / JSON_VALUE / JSON_QUERY / JSON_EXISTS": "select JSON_VALUE(a, '$.b') from t;",
      "random() com dois argumentos": "select random(1, 10);",
      "COPY … ON_ERROR": "COPY t FROM stdin WITH (ON_ERROR ignore);",
      "SPLIT PARTITION / MERGE PARTITIONS": "ALTER TABLE t SPLIT PARTITION p INTO (x);",
      "uuid_extract_timestamp / to_bin / to_oct / pg_basetype": "select to_bin(42);",
      SYSTEM_USER: "select SYSTEM_USER;",
      pg_input_is_valid: "select pg_input_is_valid('x', 'integer');",
      "any_value / array_shuffle / array_sample": "select any_value(x) from t;",
    };

    for (const { nome, padrao } of ACIMA_DO_PISO) {
      const isca = iscas[nome];
      // `assert` e não `expect(...).toBeDefined()`: só o assert estreita o tipo
      // para o `ocorrencias` abaixo — com o expect, o `undefined` sobrevive ao
      // typecheck e o erro só apareceria no CI.
      assert(isca !== undefined, `falta isca para "${nome}"`);
      expect(
        ocorrencias(isca, padrao),
        `o padrão de "${nome}" não reprovou a própria isca — ele está cego`,
      ).toEqual([1]);
    }
  });

  it("o piso declarado no config.toml acompanha", () => {
    // O config.toml já cedeu ao baseline uma vez (15 → 17). Se ele voltar a
    // divergir, contribuidor roda `supabase start` e pega um servidor que não
    // corresponde ao que o CI testa — foi exatamente o achado M1 de
    // docs/testing/user-journey-map.md.
    //
    // E o e2e FICA no piso de propósito (issue #454): é o job mais caro do CI, e
    // rodá-lo nas duas majors dobraria o custo do que a matriz do `invariants`
    // (`test:db` em pg15 E pg17) já cobre — a major dói no DDL do baseline, que
    // é justamente o que a matriz mede duas vezes.
    const toml = readFileSync(path.join(RAIZ, "supabase/config.toml"), "utf8");
    expect(toml).toMatch(/^\s*major_version\s*=\s*15\s*$/m);
  });

  it("o gate de banco roda no piso, não acima dele", () => {
    // Testar em pg17 um produto que dizemos instalar em pg15 é medir a
    // instalação mais rica que temos à mão, não a mais pobre que prometemos.
    //
    // A partir da #454 a major é PARÂMETRO (`TEST_DB_IMAGE`): a matriz do job
    // `invariants` roda pg15 e pg17, e é assim que a segunda major passa a ser
    // coberta. O que este teste guarda agora é o DEFAULT — quem digita
    // `pnpm test:db` sem pedir nada continua medindo o piso. Default trocado
    // para pg17, ou a forma `${VAR:-default}` perdida (o que desligaria a
    // parametrização sem quebrar nada visível), fica vermelho aqui.
    const script = readFileSync(path.join(RAIZ, "scripts/test-db.sh"), "utf8");
    expect(script).toMatch(
      /^IMAGE="\$\{TEST_DB_IMAGE:-pgvector\/pgvector:pg15\}"$/m,
    );

    // O outro script de banco do repo sobe container pela mesma porta: default
    // diferente do piso criaria a mesma divergência por outro caminho.
    const comDados = readFileSync(
      path.join(RAIZ, "scripts/test-update-com-dados.sh"),
      "utf8",
    );
    expect(comDados).toMatch(
      /^IMAGE="\$\{TEST_DB_IMAGE:-pgvector\/pgvector:pg15\}"$/m,
    );
  });

  it("o CI cobre as DUAS majors, e não só o piso", () => {
    // A #422 baixou o CI inteiro para pg15 e nada ficou no pg17: o piso é a
    // régua da instalação, não a única major que existe (issue #454). Este teste
    // é a catraca dessa cobertura — sem ele, apagar a matriz deixa o produto
    // medindo uma major só, com o CI verde e ninguém avisando.
    const ci = readFileSync(path.join(RAIZ, ".github/workflows/ci.yml"), "utf8");

    // 1. A matriz existe e declara as duas.
    expect(ci).toMatch(/^\s*pg:\s*\[\s*"15"\s*,\s*"17"\s*\]\s*$/m);

    // 2. A major da matriz CHEGA nos scripts. Sem esta linha as duas pernas
    //    sobem pg15 e a cobertura vira verde medindo a mesma coisa duas vezes.
    expect(ci).toMatch(
      /TEST_DB_IMAGE:\s*pgvector\/pgvector:pg\$\{\{\s*matrix\.pg\s*\}\}/,
    );

    // 3. O script que re-aplica o baseline sobre banco COM DADOS é invocado por
    //    um job — ele existia desde 2026-08-27 e nenhum workflow o chamava.
    expect(ci).toMatch(/run:\s*pnpm test:db:update\b/);

    // 4. O check obrigatório `invariants` sobrevive à matriz. A branch
    //    protection da `main` exige esse nome exato, e job de matrix se chama
    //    `invariants-majors (15)`: sem a fachada, nenhum PR mergearia.
    expect(ci).toMatch(
      /^\s{2}invariants:\n\s+if: always\(\)\n\s+needs: \[invariants-majors\]/m,
    );
  });
});
