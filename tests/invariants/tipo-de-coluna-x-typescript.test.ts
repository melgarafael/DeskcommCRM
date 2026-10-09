import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * O **TIPO** da coluna no banco e o tipo declarado no TypeScript falam o mesmo idioma.
 *
 * Irmão de `vocabulario-banco-x-typescript.test.ts` (que compara o vocabulário do
 * `CHECK`), este invariante cobre a OUTRA metade do contrato — a que o irmão
 * declara como lacuna própria: "esta classe — **tipo** de coluna contra tipo
 * declarado — não é coberta por nada" (issue #533, achado da triagem do #513).
 *
 * O defeito que nasceu disso, citado na issue:
 *
 * ```
 * supabase/baseline.sql:1203    "models_available" "text"[],   ← banco
 * hooks/ai/useCredentials.ts    models_available: number       ← TypeScript
 * CredentialCard.tsx            <dd>{credential.models_available ?? "—"}</dd>
 * ```
 *
 * O `tsc` não podia pegar, e o motivo é estrutural: o valor atravessa
 * `as unknown as CredentialRow[]` (`app/app/ai/credentials/page.tsx:47`), que
 * desliga a checagem na hora exata em que o dado entra. Passa no `typecheck`,
 * passa no `lint`, passa no unitário — e a tela imprime `claude-a,claude-b`
 * onde deveria imprimir `2`. É o mesmo perfil de falha silenciosa que o irmão
 * descreve para o CHECK, uma camada acima: ali o banco rejeita com `23514`, aqui
 * o banco aceita e o ERRO SÓ EXISTE NA TELA.
 *
 * Duas réguas, e cada uma mede um lado:
 *
 *  1. **tipo** — para cada campo declarado na interface de cada cobertura, o
 *     tipo lido do `supabase/baseline.sql` (coluna, nulidade incluída) tem de
 *     corresponder ao tipo declarado no TypeScript.
 *  2. **cast** — nenhum arquivo de produção pode materializar um tipo de
 *     `COBERTURAS` atrás de `as unknown as`: é o que transforma o compilador em
 *     testemunha ocular. `as CredentialRow[]` continua sendo asserção, mas é
 *     VERIFICÁVEL — o `tsc` recusa se os dois lados não forem comparáveis.
 *
 * As duas réguas falham por motivos diferentes e as duas são necessárias: sem a
 * régua 1, um cast honesto protege uma interface que já mente sobre o banco;
 * sem a régua 2, uma interface correta é atribuída a qualquer coisa.
 *
 * ⚠️ **Nada aqui é transcrito.** O tipo do banco sai do `baseline.sql` versionado
 * e o tipo do TypeScript sai do arquivo da interface — mesma regra dos `PARES` do
 * irmão: uma lista manual de tipos seria a TERCEIRA fonte de mentira, e seria
 * ela própria o defeito que este invariante existe para pegar.
 *
 * ⚠️ **Toda falha de extração ESTOURA.** Se o regex parar de casar, o extrator
 * lança em vez de devolver tipo vazio: comparação por vacuidade diria "banco e
 * TypeScript concordam" quando o que aconteceu foi o instrumento parar de ler.
 */

/** Onde ficam os tipos de linha consumidos pela UI. Escaneados, não transcritos. */
const RAIZES_DE_TIPO = ["lib", "hooks", "components", "app", "workers"];

/** O que este invariante cobre: uma interface × uma tabela (ou view) do baseline. */
const COBERTURAS: Array<{
  /** Tabela OU view do `supabase/baseline.sql` — view é resolvida para a fonte. */
  tabela: string;
  /** Arquivo que DECLARA a interface. */
  arquivo: string;
  /** Nome da interface. */
  simbolo: string;
}> = [
  {
    tabela: "ai_provider_credentials_safe",
    arquivo: "hooks/ai/useCredentials.ts",
    simbolo: "CredentialRow",
    // A view é a ÚNICA superfície de leitura da tela de Credenciais (o `revoke`
    // em `ai_provider_credentials` impede o acesso direto), e é exatamente por
    // ali que o dado de `models_available` entrou tipado como `number`. Os três
    // `as unknown as CredentialRow[]` do repo estão nos três arquivos que leem
    // esta view.
  },
];

// ---------------------------------------------------------------------------
// Banco: supabase/baseline.sql → tipo da coluna
// ---------------------------------------------------------------------------

let baselineEmMemoria: string | null = null;

function baseline(): string {
  if (baselineEmMemoria === null) {
    try {
      baselineEmMemoria = readFileSync("supabase/baseline.sql", "utf8");
    } catch {
      throw new Error(
        "extrator de tipo: não consegui ler supabase/baseline.sql. " +
          "O vitest precisa rodar com o repositório como diretório corrente " +
          "(é assim que scripts/test-db.sh o chama). Corrigir o caminho é o " +
          "conserto; abrir exceção NÃO.",
      );
    }
  }
  return baselineEmMemoria;
}

/** O bloco `CREATE TABLE IF NOT EXISTS "public"."x" (` … `);`, ou null se não existe. */
function blocoDeTabela(tabela: string): string | null {
  const cabeca = `CREATE TABLE IF NOT EXISTS "public"."${tabela}" (`;
  const inicio = baseline().indexOf(cabeca);
  if (inicio < 0) return null;
  const fim = baseline().indexOf("\n);", inicio);
  if (fim < 0) {
    throw new Error(
      `extrator de tipo: achei o CREATE TABLE de ${tabela} mas não achei o \\n); ` +
        `que fecha o bloco. O DDL mudou de formato — ensine o extrator.`,
    );
  }
  return baseline().slice(inicio, fim);
}

/**
 * De onde a view lê: `create or replace view X as select a, b from Y` → `Y`.
 *
 * Só aceita seleção POR COLUNA de coluna simples. Expressão no select
 * (`count(*)`, `a || b`) não tem tipo que se copie de um lado para o outro, e
 * escolher um lado seria inventar — então isto lança.
 */
function fonteDaView(view: string): { tabela: string; colunas: string[] } {
  const re = new RegExp(
    'CREATE OR REPLACE VIEW\\s+(?:"public"\\."(\\w+)"|public\\.(\\w+))' +
      "([\\s\\S]*?)\\bAS\\b([\\s\\S]*?)\\bFROM\\s+(?:\"public\"\\.\"(\\w+)\"|public\\.(\\w+))",
    "gi",
  );
  for (const m of baseline().matchAll(re)) {
    const nome = m[1] ?? m[2];
    if (nome !== view) continue;
    const selecao = (m[4] ?? "").trim().replace(/^select\s+/i, "");
    const tabela = m[5] ?? m[6];
    if (!tabela) break;
    const colunas = selecao
      .split(",")
      .map((c) => c.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    const naoEhColuna = colunas.find((c) => !/^[A-Za-z_]\w*$/.test(c));
    if (colunas.length === 0 || naoEhColuna) {
      throw new Error(
        `extrator de tipo: a view ${view} não é um select por coluna ` +
          `(trecho problemático: ${JSON.stringify(naoEhColuna ?? selecao.slice(0, 60))}). ` +
          `Sem coluna simples não há tipo para copiar da fonte — ensine o extrator.`,
      );
    }
    return { tabela, colunas };
  }
  throw new Error(
    `extrator de tipo: não achei o DDL da view ${view} em supabase/baseline.sql. ` +
      `A view mudou de nome? Corrigir o caminho é o conserto; apagar a cobertura NÃO.`,
  );
}

/** `NOT NULL` na linha inteira decide a nulidade — o tipo truncado não. */
function colunaDaTabela(tabela: string, coluna: string): { tipo: string; nulo: boolean } {
  const bloco = blocoDeTabela(tabela);
  if (bloco === null) {
    throw new Error(
      `extrator de tipo: não achei CREATE TABLE de "${tabela}" no baseline. ` +
        `A tabela sumiu ou mudou de nome? Corrigir a cobertura é o conserto; ` +
        `deixar isto passar em silêncio devolveria "sem tipo" e o par passaria sem ler nada.`,
    );
  }
  const linha = bloco.split("\n").find((l) => l.trimStart().startsWith(`"${coluna}" `));
  if (!linha) {
    throw new Error(
      `extrator de tipo: a coluna "${coluna}" não existe na tabela ${tabela} do baseline. ` +
        `Interface declarando campo que o banco não tem — ou a coluna mudou de nome.`,
    );
  }
  const bruto = linha.trim().slice(coluna.length + 3).trim();
  // O tipo termina antes da primeira palavra-chave de restrição. `DEFAULT` vem
  // depois do tipo em toda linha do baseline (`"uuid" DEFAULT "gen_random_uuid"()`).
  const corte = bruto.search(
    /\s+(?:NOT\s+NULL|NULL|DEFAULT|CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|REFERENCES|COLLATE|GENERATED)\b/i,
  );
  const tipo = (corte >= 0 ? bruto.slice(0, corte) : bruto)
    .trim()
    .replace(/,+$/, "")
    .replace(/"/g, "")
    .trim();
  if (!tipo) {
    throw new Error(`extrator de tipo: ${tabela}.${coluna} veio sem tipo — linha: ${linha}`);
  }
  return { tipo, nulo: !/\bNOT\s+NULL\b/i.test(linha) && !/\bPRIMARY\s+KEY\b/i.test(linha) };
}

/** Tipo da coluna no baseline, resolvendo view → tabela quando preciso. */
function tipoDaColunaNoBanco(tabela: string, coluna: string): { tipo: string; nulo: boolean } {
  const direto = blocoDeTabela(tabela);
  if (direto === null) {
    const fonte = fonteDaView(tabela);
    if (!fonte.colunas.includes(coluna)) {
      throw new Error(
        `extrator de tipo: a view ${tabela} não projeta a coluna "${coluna}" ` +
          `(projeta: ${fonte.colunas.join(", ")}). Campo declarado na interface que a ` +
          `view não devolve — o SELECT da tela cairia em undefined.`,
      );
    }
    return colunaDaTabela(fonte.tabela, coluna);
  }
  return colunaDaTabela(tabela, coluna);
}

/** De SQL para o tipo que o cliente supabase-js entrega em JavaScript. */
const SQL_PARA_TS: Record<string, string> = {
  text: "string",
  varchar: "string",
  "character varying": "string",
  uuid: "string",
  inet: "string",
  citext: "string",
  name: "string",
  boolean: "boolean",
  smallint: "number",
  integer: "number",
  bigint: "number",
  numeric: "number",
  decimal: "number",
  real: "number",
  "double precision": "number",
  // O cliente supabase-js entrega timestamp como texto ISO, nunca como Date —
  // é o contrato do PostgREST, e é o que toda interface deste repo declara.
  date: "string",
  timestamp: "string",
  "timestamp without time zone": "string",
  timestamptz: "string",
  "timestamp with time zone": "string",
};

/** Base (sem array, sem aspas) + se é array. */
function separaArray(tipo: string): { base: string; array: boolean } {
  const t = tipo.trim().replace(/"/g, "").trim();
  if (t.endsWith("[]")) return { base: t.slice(0, -2).trim(), array: true };
  return { base: t, array: false };
}

function tipoTsDoBanco(tipoSql: string): string {
  const { base, array } = separaArray(tipoSql);
  const semPrecisao = base.replace(/\([^)]*\)$/, "").trim();
  const ts = SQL_PARA_TS[semPrecisao];
  if (!ts) {
    throw new Error(
      `extrator de tipo: não sei traduzir o tipo de banco "${tipoSql}". ` +
        `Ensinando SQL_PARA_TS é o conserto — devolver vazio compararia por vacuidade ` +
        `e diria que banco e TypeScript concordam sem ter lido nada.`,
    );
  }
  return array ? `${ts}[]` : ts;
}

// ---------------------------------------------------------------------------
// TypeScript: interface → tipo declarado no campo
// ---------------------------------------------------------------------------

function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** O corpo `{ ... }` de `interface X` / `type X = { ... }`, com chaves aninhadas. */
function corpoDaInterface(fonte: string, simbolo: string): string {
  const sem = semComentarios(fonte);
  const m =
    new RegExp(`interface\\s+${simbolo}\\s*(?:extends[^{]*)?\\{`, "s").exec(sem) ??
    new RegExp(`type\\s+${simbolo}\\s*=\\s*\\{`, "s").exec(sem);
  if (!m) {
    throw new Error(
      `extrator de tipo: não achei \`interface ${simbolo}\` nem \`type ${simbolo} = {\` no ` +
        `arquivo. Mudou de nome ou de arquivo? Corrigir a cobertura é o conserto; ` +
        `apagar a cobertura NÃO — seria trocar o guard pelo defeito.`,
    );
  }
  const inicio = m.index + m[0].length;
  let nivel = 1;
  for (let i = inicio; i < sem.length; i++) {
    if (sem[i] === "{") nivel++;
    else if (sem[i] === "}") {
      nivel--;
      if (nivel === 0) return sem.slice(inicio, i);
    }
  }
  throw new Error(`extrator de tipo: o corpo de ${simbolo} não fecha — ensine o extrator.`);
}

function camposDaInterface(arquivo: string, simbolo: string): Map<string, string> {
  let fonte: string;
  try {
    fonte = readFileSync(arquivo, "utf8");
  } catch {
    throw new Error(
      `extrator de tipo: não consegui ler ${arquivo} (interface ${simbolo}). ` +
        `O arquivo mudou de lugar? Corrigir o caminho é o conserto.`,
    );
  }
  const corpo = corpoDaInterface(fonte, simbolo);
  const campos = new Map<string, string>();
  for (const m of corpo.matchAll(/^\s*([A-Za-z_]\w*)\s*\??\s*:\s*([^;\n]+)/gm)) {
    campos.set(m[1]!, m[2]!.trim());
  }
  if (campos.size === 0) {
    throw new Error(
      `extrator de tipo: ${simbolo} (${arquivo}) não rendeu campo nenhum. ` +
        `Isto é falha do INSTRUMENTO, não interface vazia.`,
    );
  }
  return campos;
}

/** Cache: o walk de cada raiz é feito uma vez só, não por campo e por chamada. */
const arquivosPorRaiz = new Map<string, string[]>();

function arquivosDeTipo(raiz: string): string[] {
  const emCache = arquivosPorRaiz.get(raiz);
  if (emCache) return emCache;
  let lista: string[] = [];
  try {
    lista = (readdirSync(raiz, { recursive: true, encoding: "utf8" }) as string[]).filter(
      (r) => r.endsWith(".ts") || r.endsWith(".tsx"),
    );
  } catch {
    lista = [];
  }
  arquivosPorRaiz.set(raiz, lista);
  return lista;
}

/** O initializer de `const X = …;` (até o `;` de nível zero), em algum arquivo de tipo. */
function iniciaisDe(nomeConst: string): string | null {
  for (const raiz of RAIZES_DE_TIPO) {
    for (const rel of arquivosDeTipo(raiz)) {
      const caminho = `${raiz}/${rel}`;
      let fonte: string;
      try {
        fonte = semComentarios(readFileSync(caminho, "utf8"));
      } catch {
        continue;
      }
      const decl = new RegExp(`\\b(?:export\\s+)?const\\s+${nomeConst}\\s*=`).exec(fonte);
      if (!decl) continue;
      return iniciaisAtePontoEVirgula(fonte, decl.index + decl[0].length);
    }
  }
  return null;
}

/**
 * O texto do initializer de uma constante, com os `...SPREAD` expandidos.
 *
 * `[...PROVEDORES, ...PROVEDORES_DE_DECISAO] as const` não contém nenhum literal
 * — eles estão nas constantes espalhadas. Expandir é LER a fonte; recusar seria
 * devolver lista vazia e comparar por vacuidade.
 */
function textoExpandido(nomeConst: string, vista: Set<string> = new Set()): string {
  if (vista.has(nomeConst)) return "";
  vista.add(nomeConst);
  const corpo = iniciaisDe(nomeConst);
  if (corpo === null) return "";
  let saida = corpo;
  for (const sp of corpo.matchAll(/\.\.\.([A-Za-z_]\w*)/g)) {
    saida += textoExpandido(sp[1]!, vista);
  }
  return saida;
}

/** Os literais de `campo` dentro do initializer de `nomeConst` (com spread expandido). */
function literaisDeCampo(nomeConst: string, campo: string): string[] {
  return [...textoExpandido(nomeConst).matchAll(new RegExp(`\\b${campo}\\s*:\\s*"([^"]*)"`, "g"))].map(
    (x) => x[1]!,
  );
}

function iniciaisAtePontoEVirgula(fonte: string, desde: number): string {
  let nivel = 0;
  for (let i = desde; i < fonte.length; i++) {
    const c = fonte[i]!;
    if (c === "[" || c === "{" || c === "(") nivel++;
    else if (c === "]" || c === "}" || c === ")") nivel--;
    else if (c === ";" && nivel <= 0) return fonte.slice(desde, i);
  }
  return fonte.slice(desde);
}

/** Um membro de união → o primitivo dele, ou LANÇA (ver `alargaIdentificador`). */
function alargaMembro(id: string, membro: string, rhs: string): string {
  if (/^"[^"]*"$/.test(membro)) return "string";
  if (/^-?\d+(\.\d+)?$/.test(membro)) return "number";

  // (typeof C)[number]["campo"]
  const t = /^\(typeof\s+(\w+)\)\s*\[\s*number\s*\]\s*\[\s*"(\w+)"\s*\]$/.exec(membro);
  if (t) {
    const literais = literaisDeCampo(t[1]!, t[2]!);
    if (literais.length === 0) {
      throw new Error(
        `extrator de tipo: ${id} deriva de (typeof ${t[1]})[number]["${t[2]}"], mas não ` +
          `achei nenhum literal de ${t[2]} nas constantes citadas. Lista vazia aqui seria ` +
          `comparação por vacuidade — ensine o extrator.`,
      );
    }
    if (literais.every((v) => typeof v === "string")) return "string";
    throw new Error(
      `extrator de tipo: ${id} não é união de string e este extritor não sabe alargar ` +
        `o tipo — ensine, em vez de chutar.`,
    );
  }

  // typeof C, com `const C = "literal"` (ex.: `typeof PROVEDOR_POR_ASSINATURA`)
  const c = /^typeof\s+(\w+)$/.exec(membro);
  if (c) {
    const corpo = iniciaisDe(c[1]!)?.trim() ?? null;
    if (corpo !== null && /^"[^"]*"(\s+as\s+const)?$/.test(corpo)) return "string";
  }

  throw new Error(
    `extrator de tipo: não sei alargar \`${id}\` (= \`${rhs.slice(0, 80)}\`). ` +
      `Ensinando alargaIdentificador é o conserto: chutar \`string\` faria o par ` +
      `passar por palpite, que é o defeito que este invariante existe para pegar.`,
  );
}

/**
 * Alarga um IDENTIFICADOR ao primitivo que ele representa.
 *
 * `ProvedorComChave = (typeof PROVEDORES_COM_CHAVE)[number]["id"]` é string
 * (toda união de literais de string é string), mas saber disso exige seguir a
 * cadeia até os literais. O que este extrator SABE fazer:
 *
 *  - união de literais de string (`"a" | "b"`) → `string`;
 *  - `(typeof C)[number]["campo"]` → lê os literais de `campo` nas constantes
 *    citadas (com expansão de spread) e, se todos forem string, → `string`;
 *  - `typeof C`, com `C` constante de literal de string → `string`;
 *  - união dos anteriores, quando todos alargam ao mesmo primitivo;
 *  - primitivo direto (`string`, `number`, …) → ele mesmo.
 *
 * Qualquer outra forma LANÇA. Devolver `string` por palpite transformaria o
 * invariante na terceira lista manuscrita que ele existe para proibir.
 */
function alargaIdentificador(id: string): string {
  if (/^(string|number|boolean)$/.test(id)) return id;
  for (const raiz of RAIZES_DE_TIPO) {
    for (const rel of arquivosDeTipo(raiz)) {
      const caminho = `${raiz}/${rel}`;
      let fonte: string;
      try {
        fonte = semComentarios(readFileSync(caminho, "utf8"));
      } catch {
        continue;
      }
      const decl = new RegExp(`\\b(?:export\\s+)?type\\s+${id}\\s*=\\s*([^;]+);`).exec(fonte);
      if (!decl) continue;
      const rhs = decl[1]!.replace(/\s+/g, " ").trim();

      // Uma união alarga quando TODO membro alarga ao MESMO primitivo. O `|`
      // inicial da forma multilinha produz um membro vazio, que não é membro.
      const membros = rhs.split("|").map((s) => s.trim()).filter(Boolean);
      const primitivos = new Set(membros.map((m) => alargaMembro(id, m, rhs)));
      if (primitivos.size === 1) return [...primitivos][0]!;
      throw new Error(
        `extrator de tipo: ${id} (= \`${rhs.slice(0, 80)}\`) une primitivos diferentes ` +
          `(${[...primitivos].join(", ")}) — não sei alargar sem chutar. Ensine o extrator.`,
      );
    }
  }
  throw new Error(`extrator de tipo: não achei a declaração de \`${id}\` em nenhuma raiz.`);
}

/** Tipo declarado no campo → primitivo alargado + nulidade declarada. */
function tipoTs(declarado: string): { ts: string; nulo: boolean } {
  const bruto = declarado.trim();
  const membros = bruto.split("|").map((s) => s.trim()).filter(Boolean);
  const semNulo = membros.filter((m) => m !== "null" && m !== "undefined");
  const nulo = semNulo.length !== membros.length;
  if (semNulo.length === 0) {
    throw new Error(`extrator de tipo: \`${bruto}\` não tem tipo nenhum além de null.`);
  }
  if (semNulo.length > 1) {
    throw new Error(
      `extrator de tipo: \`${bruto}\` é união de tipos diferentes — não sei alargar ` +
        `sem chutar. Ensine o extrator.`,
    );
  }
  let um = semNulo[0]!.replace(/^\(|\)$/g, "").trim();
  let array = false;
  if (um.endsWith("[]")) {
    array = true;
    um = um.slice(0, -2).trim();
  }
  const base = /^(string|number|boolean)$/.test(um) ? um : alargaIdentificador(um);
  return { ts: array ? `${base}[]` : base, nulo };
}

// ---------------------------------------------------------------------------
// Régua 2: o cast que desliga a checagem
// ---------------------------------------------------------------------------

/** Arquivos de produção que materializam `simbolo` atrás de `as unknown as`. */
function sitesComCastDesconhecido(simbolo: string): string[] {
  const achados: string[] = [];
  for (const raiz of RAIZES_DE_TIPO) {
    for (const rel of arquivosDeTipo(raiz)) {
      const caminho = `${raiz}/${rel}`;
      let fonte: string;
      try {
        fonte = readFileSync(caminho, "utf8");
      } catch {
        continue;
      }
      if (fonte.includes(`as unknown as ${simbolo}`)) achados.push(caminho);
    }
  }
  return achados.sort();
}

// ---------------------------------------------------------------------------

describe("tipo de coluna: banco × TypeScript", () => {
  it("a lista de coberturas não pode vir vazia", () => {
    // Sem esta guarda, esvaziar COBERTURAS faria a suíte passar sem verificar
    // nada — verde vácuo no nível do arquivo.
    expect(COBERTURAS.length).toBeGreaterThan(0);
  });

  for (const cobertura of COBERTURAS) {
    const campos = camposDaInterface(cobertura.arquivo, cobertura.simbolo);

    it(`${cobertura.simbolo} declara campo nenhum?`, () => {
      expect(
        campos.size,
        `extrator de tipo: ${cobertura.simbolo} não rendeu campo — falha do INSTRUMENTO`,
      ).toBeGreaterThan(0);
    });

    for (const [campo, declarado] of campos) {
      it(`${cobertura.tabela}.${campo} tem o mesmo tipo que ${cobertura.simbolo} declara`, () => {
        const noBanco = tipoDaColunaNoBanco(cobertura.tabela, campo);
        const esperado = tipoTsDoBanco(noBanco.tipo);
        const noTs = tipoTs(declarado);

        expect(
          noTs.ts,
          `divergência de TIPO — o compilador NÃO pega esta, porque o valor entra por ` +
            `\`as unknown as\`:\n` +
            `  banco (${cobertura.tabela}.${campo}): ${noBanco.tipo} → ${esperado}\n` +
            `  ${cobertura.simbolo} (${cobertura.arquivo}) declara: ${declarado} → ${noTs.ts}`,
        ).toBe(esperado);

        expect(
          noTs.nulo,
          `divergência de NULIDADE em ${cobertura.tabela}.${campo}: o banco diz ` +
            `${noBanco.nulo ? "nullable" : "NOT NULL"}, o TypeScript declara ` +
            `${noTs.nulo ? "nullable" : "obrigatório"} (\`${declarado}\`). ` +
            `O lado que mente é o do TypeScript — o baseline é a fonte.`,
        ).toBe(noBanco.nulo);
      });
    }

    it(`${cobertura.simbolo} não é materializado atrás de \`as unknown as\``, () => {
      const sites = sitesComCastDesconhecido(cobertura.simbolo);
      expect(
        sites,
        `\`as unknown as ${cobertura.simbolo}[]\` desliga a checagem na hora em que o dado ` +
          `entra — foi assim que \`models_available: number\` sobreviveu ao typecheck e ` +
          `chegou à tela (#533). Use a asserção verificável (\`as ${cobertura.simbolo}[]\`): ` +
          `o tsc recusa se os dois lados não forem comparáveis.\n` +
          `  sites: ${sites.join(", ") || "(nenhum)"}`,
      ).toEqual([]);
    });
  }
});
