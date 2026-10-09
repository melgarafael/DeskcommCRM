import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMAS } from "@/lib/i18n/idiomas";
import { IDIOMAS_EM_CONSTRUCAO } from "@/lib/i18n/registro";

import {
  AREAS_DE_PRODUTO,
  RAIZ_DAS_FIXTURES,
  buracosDeEspanhol,
  varrerChavesDeI18n,
} from "./helpers/chave-dinamica";
import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * O ESPANHOL COBRE A TELA, E O PORTUGUÊS NÃO MUDA UM BYTE.
 *
 * ─── Por que um guarda, e não uma conferida a olho ─────────────────────────
 *
 * i18n falha de um jeito MUDO nas duas direções, e as duas já aconteceram
 * neste repo:
 *
 *   1. **Sobra texto cru.** Um `<span>Salvar</span>` que ninguém envolveu em
 *      `t()` renderiza "Salvar" para quem escolheu espanhol. Nada quebra,
 *      nenhum teste fica vermelho, e quem descobre é o cliente na Colômbia.
 *      Conferir por amostragem não fecha: são 2.725 chamadas em 348 arquivos, e
 *      o que escapa é justamente a tela que ninguém abriu.
 *
 *   2. **Envolver em `t()` MUDA o português.** Medido, três vezes, no PR #352:
 *      `Buscar...` (três pontos ASCII) virou `t("Buscar…")` com reticência
 *      unicode, e o `sr-only` "Close" de `dialog`/`sheet` — inglês herdado do
 *      shadcn — virou `t("Fechar")`. Ou seja: uma feature que promete só
 *      ACRESCENTAR um idioma alterou a tela de quem já usava o produto. Esse é
 *      o único jeito de traduzir piorar alguma coisa, e é invisível no diff de
 *      346 arquivos.
 *
 * ─── O que cada parte prova, e o que NÃO prova ─────────────────────────────
 *
 * `a chave é o texto em português` prova a direção 2 no DICIONÁRIO: nenhuma
 * entrada pode declarar `pt-BR`, então `traduzir(k, "pt-BR")` devolve `k` para
 * toda chave. Não prova que a CHAVE escrita no componente é o texto que estava
 * lá antes — isso é uma mudança de código-fonte, e quem a pega é a revisão do
 * diff. (Este parágrafo citava também `scripts/i18n-auditar-portugues.mjs`, que
 * nunca existiu no repositório — `git log --all` sobre o caminho sai vazio.)
 *
 * `toda chave usada tem espanhol` prova a direção 1 para o texto que JÁ passa
 * por `t()` — cobertura de 100% das chamadas, não amostra.
 *
 * `nenhuma prosa em português fora de t()` prova a direção 1 para o texto que
 * NÃO passa por `t()` — que é onde o vazamento realmente mora. Ele varre o AST
 * de toda tela, então alcança arquivo que ainda não existe.
 *
 * O que nenhum dos três prova: texto que vem do BANCO (nome de funil, rótulo de
 * etapa, conteúdo de mensagem) sai como o operador cadastrou, em qualquer
 * idioma. Isso é dado, não interface, e traduzir seria errado. Nem a frase que
 * chega à tela pela resposta de uma rota: pastas `api` ficam fora da varredura
 * (`PASTAS_IGNORADAS`), e o que nasce como `throw` em `lib/**` e vira
 * `t(err.message)` não é literal — issue #1046.
 *
 * ─── Só o espanhol é cobrado aqui, e é de propósito ────────────────────────
 *
 * O nível de cada idioma mora em `lib/i18n/registro.ts`. O espanhol é
 * `completo`: toda frase de tela precisa dele, e isto reprova. Idioma
 * `em_construcao` não reprova ninguém — a chave sem tradução cai no português —,
 * e as mensagens abaixo dizem isso a quem contribui, com o nome do idioma lido
 * do registro, para a frase não envelhecer.
 */

const RAIZ = join(__dirname, "..", "..");

/**
 * O que a mensagem de falha diz a quem contribui. Curto e ANTES da lista de
 * ofensores, que pode ter centenas de linhas e empurrar o conserto para fora
 * da tela. Só cita comando e arquivo que existem.
 */
const EM_CONSTRUCAO =
  IDIOMAS_EM_CONSTRUCAO.map((idioma) => idioma.nomeNativo).join(", ") || "nenhum hoje";
const COMO_CONSERTAR =
  'Conserto: uma linha em lib/i18n/dicionario.ts, no formato "texto em português": { es: "texto en español" }. ' +
  "Não fala espanhol? Mande o PR assim mesmo e diga isso na descrição. " +
  `Idiomas em construção (${EM_CONSTRUCAO}) não reprovam: a frase sem tradução aparece em português. ` +
  "Confira com: pnpm test:unit tests/unit/i18n-espanhol-cobre-a-tela.test.ts";

/** Diretórios cuja saída um cliente vê. `api` não renderiza tela. */
const AREAS = ["app", "components"];
const PASTAS_IGNORADAS = new Set(["api", "node_modules"]);

/**
 * Telas que NÃO são produto — vitrines internas de desenvolvimento, ambas com
 * `robots: noindex`, ambas fora de `lib/navigation/registry.ts` e portanto sem
 * porta na navegação do cliente. Quem as abre é quem desenvolve o design
 * system, digitando a URL. Traduzi-las custaria manutenção para ninguém.
 *
 * Esta lista SÓ ENCOLHE: entrada nova aqui precisa do mesmo argumento — a tela
 * não é alcançável por quem usa o produto.
 */
const FORA_DO_PRODUTO: Record<string, string> = {
  "app/design": "vitrine do design system: rota noindex, sem porta na navegação",
  "app/vitrine-agenda": "vitrine do kit visual da Agenda: dado de mentira, noindex",
};

/**
 * Textos que ficam em português DE PROPÓSITO, um a um, com o motivo escrito.
 *
 * Cada entrada é um par arquivo + texto: uma exceção que vale para a linha
 * exata, não para o arquivo inteiro. Como a lista SÓ ENCOLHE, entrada nova
 * precisa do argumento — e o argumento tem de ser "traduzir estaria errado",
 * nunca "não deu tempo".
 */
const EM_PORTUGUES_DE_PROPOSITO: { arquivo: string; texto: string; motivo: string }[] = [
  {
    arquivo: "app/app/settings/tenant/pipelines/_stages.tsx",
    texto: "nenhum",
    motivo: "valor de wire do papel da etapa; o rótulo visível já sai por t(ROTULO_DO_PAPEL[p])",
  },
];

function ehExcecaoDeclarada(arquivo: string, texto: string): boolean {
  return EM_PORTUGUES_DE_PROPOSITO.some((e) => e.arquivo === arquivo && e.texto === texto);
}

/**
 * Marcadores ORTOGRÁFICOS do português que o espanhol não tem.
 *
 * Escolhidos por serem impossíveis em espanhol — `ç`, `ã`, `õ`, os circunflexos
 * e os dígrafos `lh`/`nh` —, mais um punhado de palavras funcionais que só
 * existem em português. É derivado da língua, não de uma lista de rótulos do
 * produto: rótulo novo não precisa entrar em lugar nenhum para ser vigiado.
 *
 * Falso NEGATIVO é aceito de propósito: "Total" é igual nos dois idiomas e não
 * dispara. Falso POSITIVO é o que não pode acontecer, porque tornaria o guarda
 * um imposto — daí só caractere e palavra sem ambiguidade.
 */
const MARCA_DE_PORTUGUES =
  /[çãõêôàáéíóúâ]|(lh|nh)[aeiouáéíóúãõ]|\b(não|você|está|estão|são|também|através|então|aqui|desta|deste|nesta|neste|dele|dela|quem|quando|onde|para|pelo|pela|com|sem|mais|menos|todos|todas|cada|ainda|já|só|muito|entre|sobre|antes|depois|agora|nunca|sempre|seu|sua|isso|este|essa|esse)\b/iu;

/** Atributos cujo valor chega ao olho — ou ao leitor de tela — de quem usa. */
const ATRIBUTOS_VISIVEIS = new Set([
  "placeholder",
  "title",
  "alt",
  "label",
  "description",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "emptyMessage",
  "tooltip",
  "helperText",
]);

/** Duas letras seguidas: descarta "—", "⌘K", "/", "1", "·". */
const TEM_PALAVRA = /\p{L}\p{L}/u;

/**
 * Endereço de rede — e-mail, domínio ou URL — não é prosa, é exemplo técnico.
 *
 * `placeholder="alice@empresa.com"` e `"https://meusistema.com/webhook"` são
 * amostras de formato: traduzi-las não ajudaria ninguém, e cobrá-las faria o
 * guarda mandar traduzir um domínio.
 */
const ENDERECO_DE_REDE =
  /^(https?:\/\/\S+|[^\s@]+@[^\s@]+\.[^\s@]+|[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?)$/i;

/**
 * Padrão de FORMATAÇÃO do date-fns (`"EEEE, d 'de' MMMM 'às' HH:mm"`), não prosa.
 *
 * A dívida que este bloco declarava — a data saindo em português para quem
 * escolheu espanhol — FOI PAGA, e quem a vigia agora é
 * `tests/unit/i18n-a-data-segue-o-idioma.test.ts`: existe uma camada
 * (`lib/i18n/datas.ts`), e nenhuma tela pode importar o locale do date-fns
 * direto nem fixar `"pt-BR"` dentro de `toLocaleDateString`.
 *
 * O padrão de formato em si continua fora da conta AQUI, e por outro motivo:
 * `"EEEE, d 'de' MMMM"` é gramática do date-fns, não frase. Traduzi-lo faria a
 * data parar de sair.
 */
function ehPadraoDeData(texto: string): boolean {
  // Fora das aspas simples, um padrão do date-fns só tem token de formato e
  // pontuação. O que está DENTRO delas é literal da língua ('de', 'às') e por
  // isso é removido antes de decidir.
  const semLiterais = texto.replace(/'[^']*'/g, "");
  return semLiterais.trim().length > 0 && /^[EdMyHhmsaGQwWkKSzZXx\s,.:/-]+$/.test(semLiterais);
}

/** Um placeholder pode listar VÁRIOS endereços, um por linha. Todos têm de ser. */
function soEnderecosDeRede(texto: string): boolean {
  const linhas = texto
    .split(/[\n,;]/)
    .map((l) => l.trim())
    .filter(Boolean);
  return linhas.length > 0 && linhas.every((l) => ENDERECO_DE_REDE.test(l));
}

function telas(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (PASTAS_IGNORADAS.has(e.name) || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) telas(p, acc);
    else if (e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx")) acc.push(p);
  }
  return acc;
}

function estaForaDoProduto(rel: string): boolean {
  const posix = rel.split(sep).join("/");
  return Object.keys(FORA_DO_PRODUTO).some((p) => posix === p || posix.startsWith(`${p}/`));
}

/**
 * O literal está em posição de FILHO de um elemento JSX — ou seja, sai na tela?
 *
 * Sobe até a `JsxExpression` mais próxima e confirma que o pai dela é um
 * elemento/fragmento, não um atributo. Assim `{cond ? "Salvar" : "Salvando…"}`
 * entra e `className={vazio ? "hidden" : "flex"}` fica de fora — o segundo é
 * CSS, não texto, e cobrá-lo transformaria a guarda num imposto.
 */
function emPosicaoDeFilhoJsx(no: ts.Node): boolean {
  for (let p = no.parent; p; p = p.parent) {
    if (ts.isJsxExpression(p)) {
      const pai = p.parent;
      return ts.isJsxElement(pai) || ts.isJsxFragment(pai) || ts.isJsxSelfClosingElement(pai);
    }
    // Uma vez dentro de atributo ou de função, a expressão não é mais filha
    // direta: parar aqui evita afirmar sobre o que não se mediu.
    if (ts.isJsxAttribute(p) || ts.isFunctionLike(p)) return false;
  }
  return false;
}

/**
 * O literal é operando de uma comparação (`x === "nenhum"`)?
 *
 * Texto que sai na tela nunca é comparado por igualdade — quem é comparado é
 * VALOR DE WIRE, e valor de wire não se traduz (traduzi-lo quebraria a
 * condição). Sem este corte o guarda acusaria `motivoDoModelo ===
 * "nenhum_com_ferramentas"`, que casa o dígrafo `nh` por acidente.
 */
function ehOperandoDeComparacao(no: ts.Node): boolean {
  const pai = no.parent;
  if (!pai || !ts.isBinaryExpression(pai)) return false;
  const op = pai.operatorToken.kind;
  return (
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken
  );
}

function dentroDeChamadaDeTraducao(no: ts.Node): boolean {
  for (let p = no.parent; p; p = p.parent) {
    if (ts.isCallExpression(p)) {
      const alvo = p.expression;
      const nome = ts.isIdentifier(alvo)
        ? alvo.text
        : ts.isPropertyAccessExpression(alvo)
          ? alvo.name.text
          : "";
      if (nome === "t" || nome === "traduzir") return true;
    }
  }
  return false;
}

type Achado = { local: string; texto: string; origem: string };

/** Percorre o AST de toda tela e devolve o texto de UI que não passa por `t()`. */
function textoCruDasTelas(): Achado[] {
  const achados: Achado[] = [];
  for (const area of AREAS) {
    for (const arq of telas(join(RAIZ, area))) {
      const rel = relative(RAIZ, arq);
      if (estaForaDoProduto(rel)) continue;
      const fonte = ts.createSourceFile(
        arq,
        readFileSync(arq, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const local = (no: ts.Node) =>
        `${rel.split(sep).join("/")}:${fonte.getLineAndCharacterOfPosition(no.getStart()).line + 1}`;

      const visita = (no: ts.Node): void => {
        if (ts.isJsxText(no)) {
          const texto = no.text.replace(/\s+/g, " ").trim();
          if (texto && TEM_PALAVRA.test(texto) && !soEnderecosDeRede(texto)) {
            achados.push({ local: local(no), texto, origem: "texto na tela" });
          }
        }
        // `{cond ? "Salvando…" : "Salvar"}` também renderiza texto, e não é
        // JsxText: é um literal DENTRO de uma expressão JSX em posição de
        // filho. Sem este ramo a guarda teria um ponto cego exatamente onde o
        // rótulo muda de estado — que é onde a prosa costuma se esconder.
        if (
          (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) &&
          !dentroDeChamadaDeTraducao(no) &&
          !ehOperandoDeComparacao(no) &&
          TEM_PALAVRA.test(no.text) &&
          !soEnderecosDeRede(no.text) &&
          !ehPadraoDeData(no.text) &&
          emPosicaoDeFilhoJsx(no)
        ) {
          achados.push({ local: local(no), texto: no.text, origem: "literal renderizado" });
        }
        if (ts.isJsxAttribute(no) && no.initializer) {
          const nome = no.name.getText(fonte);
          if (ATRIBUTOS_VISIVEIS.has(nome)) {
            const init = no.initializer;
            const lit = ts.isStringLiteral(init)
              ? init
              : ts.isJsxExpression(init) &&
                  init.expression &&
                  (ts.isStringLiteral(init.expression) ||
                    ts.isNoSubstitutionTemplateLiteral(init.expression))
                ? init.expression
                : null;
            if (
              lit &&
              TEM_PALAVRA.test(lit.text) &&
              !soEnderecosDeRede(lit.text) &&
              !dentroDeChamadaDeTraducao(lit)
            ) {
              achados.push({ local: local(lit), texto: lit.text, origem: nome });
            }
          }
        }
        ts.forEachChild(no, visita);
      };
      visita(fonte);
    }
  }
  return achados;
}

/**
 * Tabelas de rótulo `const X = {...}` / `const X = [...]` declaradas no TOPO
 * do módulo — o padrão que vira `t(X[chave])` ou `t(X.chave)` quando o rótulo
 * depende de um enum (status, severidade, tipo).
 *
 * Resolve só o caso ESTÁTICO: literal de objeto/array, no mesmo arquivo, sem
 * `require`/import remontando o valor. Isso alcança a maioria dos casos reais
 * (issue #651) sem virar um type-checker — cross-module e wrapper (`const t =
 * (texto) => traduzir(texto, idioma)`, ~200 ocorrências) ficam de fora de
 * propósito: resolver esses exigiria inferência de tipo completa, e a issue
 * #603 (proibir `t(<variável>)` na origem) é o caminho para o resto.
 */
function tabelasDeModulo(fonte: ts.SourceFile): Map<string, ts.Expression> {
  const tabelas = new Map<string, ts.Expression>();
  for (const stmt of fonte.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if ((stmt.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      let init = decl.initializer;
      // `as const satisfies Record<...>` é o padrão de tabela fechada do
      // projeto (ex.: SCORE_BAND_LABELS) — as duas camadas precisam cair para
      // o literal aparecer.
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
        tabelas.set(decl.name.text, init);
      }
    }
  }
  return tabelas;
}

/** Todo literal string dentro de uma tabela de rótulo — cada um é um rótulo possível. */
function valoresDaTabela(tabela: ts.Expression): ts.StringLiteralLike[] {
  const valores: ts.StringLiteralLike[] = [];
  const coleta = (no: ts.Expression) => {
    if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) valores.push(no);
  };
  if (ts.isObjectLiteralExpression(tabela)) {
    for (const prop of tabela.properties)
      if (ts.isPropertyAssignment(prop)) coleta(prop.initializer);
  } else if (ts.isArrayLiteralExpression(tabela)) {
    for (const el of tabela.elements) coleta(el);
  }
  return valores;
}

/** Toda chave literal — ou vinda de tabela de módulo resolvível — passada a `t()` / `traduzir()`. */
function chavesUsadas(): Map<string, string[]> {
  const usadas = new Map<string, string[]>();
  const areas = ["app", "components", "hooks", "lib"];
  for (const area of areas) {
    const arquivos: string[] = [];
    const anda = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (PASTAS_IGNORADAS.has(e.name) || e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) anda(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) arquivos.push(p);
      }
    };
    anda(join(RAIZ, area));
    for (const arq of arquivos) {
      const rel = relative(RAIZ, arq).split(sep).join("/");
      if (rel === "lib/i18n/dicionario.ts") continue;
      const src = readFileSync(arq, "utf8");
      if (!/\bt\(|\btraduzir\(/.test(src)) continue;
      const fonte = ts.createSourceFile(arq, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const tabelas = tabelasDeModulo(fonte);
      const registra = (texto: string, no: ts.Node) => {
        const linha = fonte.getLineAndCharacterOfPosition(no.getStart()).line + 1;
        usadas.set(texto, [...(usadas.get(texto) ?? []), `${rel}:${linha}`]);
      };
      const visita = (no: ts.Node): void => {
        if (ts.isCallExpression(no) && no.arguments.length > 0) {
          const alvo = no.expression;
          const nome = ts.isIdentifier(alvo)
            ? alvo.text
            : ts.isPropertyAccessExpression(alvo)
              ? alvo.name.text
              : "";
          if (nome === "t" || nome === "traduzir") {
            const a = no.arguments[0];
            if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) {
              registra(a.text, a);
            } else if (a && ts.isElementAccessExpression(a) && ts.isIdentifier(a.expression)) {
              const tabela = tabelas.get(a.expression.text);
              if (tabela) for (const v of valoresDaTabela(tabela)) registra(v.text, a);
            } else if (a && ts.isPropertyAccessExpression(a) && ts.isIdentifier(a.expression)) {
              const tabela = tabelas.get(a.expression.text);
              if (tabela) for (const v of valoresDaTabela(tabela)) registra(v.text, a);
            }
          }
        }
        ts.forEachChild(no, visita);
      };
      visita(fonte);
    }
  }
  return usadas;
}

describe("a chave é o texto em português, e o português não muda", () => {
  it("nenhuma entrada do dicionário declara pt-BR", () => {
    // Se uma entrada trouxesse `"pt-BR": "outra coisa"`, `traduzir()` passaria a
    // devolver texto DIFERENTE do que a tela mostrava — a feature que promete só
    // acrescentar espanhol mudaria o produto de quem nunca pediu nada.
    const declaramPt = Object.entries(DICIONARIO)
      .filter(([, v]) => Object.prototype.hasOwnProperty.call(v, "pt-BR"))
      .map(([k]) => k);
    expect(declaramPt).toEqual([]);
  });

  /**
   * ⚠️ ESTA ASSERÇÃO NÃO PODE FALHAR SOZINHA HOJE — medido por sabotagem.
   *
   * `traduzir()` devolve `texto` num curto-circuito ANTES de olhar o
   * dicionário (`if (idioma === "pt-BR") return texto`). Declarei uma entrada
   * `"pt-BR": "Sabotagem"` e só a asserção de cima ficou vermelha; esta seguiu
   * verde. Ela só acorda quando o curto-circuito SAI — sabotei os dois juntos e
   * aí ela reprovou.
   *
   * Fica, então, como a rede para esse dia: se alguém "simplificar" `traduzir`
   * fazendo o português passar pelo dicionário, o português volta a poder mudar
   * — e é aqui que isso vira vermelho. O que ela NÃO é: prova independente. Está
   * escrito para ninguém contar duas vezes a mesma garantia.
   */
  it("traduzir() devolve a própria chave em português, para TODA chave", () => {
    const mudaram = Object.keys(DICIONARIO).filter((k) => traduzir(k, "pt-BR") !== k);
    expect(mudaram).toEqual([]);
  });

  it("todo idioma servido, exceto o padrão, tem coluna no dicionário", () => {
    // Guarda contra o defeito que originou esta feature: o seletor oferecia
    // `en-US` e nenhuma tradução existia — escolher não mudava uma letra.
    const outros = IDIOMAS.filter((i) => i !== "pt-BR");
    for (const idioma of outros) {
      const comEsse = Object.values(DICIONARIO).filter((v) =>
        Object.prototype.hasOwnProperty.call(v, idioma),
      );
      expect(
        comEsse.length,
        `o idioma "${idioma}" é oferecido mas não tem NENHUMA tradução no dicionário`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("toda chave usada na tela tem espanhol", () => {
  it("nenhuma chamada t() cai no português por falta de tradução", () => {
    const semEspanhol = [...chavesUsadas().entries()]
      .filter(([chave]) => !DICIONARIO[chave]?.es)
      .map(([chave, onde]) => `${onde[0]} → t(${JSON.stringify(chave)})`);
    expect(
      semEspanhol,
      `${semEspanhol.length} chamada(s) t() sem tradução em espanhol: a tela cai no português. ${COMO_CONSERTAR}`,
    ).toEqual([]);
  });
});

describe("nenhuma prosa em português escapa de t()", () => {
  it("toda tela de produto passa o texto por t() antes de renderizar", () => {
    const vazando = textoCruDasTelas()
      .filter((a) => MARCA_DE_PORTUGUES.test(a.texto))
      .filter((a) => !ehExcecaoDeclarada(a.local.split(":")[0] ?? "", a.texto))
      .map((a) => `${a.local} [${a.origem}] ${JSON.stringify(a.texto.slice(0, 90))}`);
    expect(
      vazando,
      `${vazando.length} texto(s) em português renderizam crus — quem escolheu espanhol vê isto em português. ` +
        `Passe cada um por t(). ${COMO_CONSERTAR}`,
    ).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * CHAVE DINÂMICA RESOLVIDA FORA DO ARQUIVO — o segundo furo da #603.
 *
 * A catraca acima resolve a tabela de rótulo declarada NO MESMO arquivo
 * (`tabelasDeModulo`) e mais nada. Ficavam cegos, então, os quatro desenhos que
 * a tela de fato usa e que moram em OUTRO módulo:
 *
 *   t(TRIGGER_LABELS[gatilho])    ← app/app/webhooks/_components/labels.ts
 *   t(ACTION_LABELS[tipo])        ← app/app/webhooks/_components/labels.ts
 *   t(SEVERITY_LABEL[gravidade])  ← lib/ai/agent-inbox-copy.ts
 *   t(ROTULO_DO_PAPEL[papel])     ← lib/auth/types.ts
 *
 * Não é hipótese: é a dívida medida na `main` de 18/08/2026 — 103 chamadas
 * resolvidas, 196 valores exigidos do dicionário, 9 deles ausentes em 3 arquivos
 * (5 chamadas). Esses 9 foram congelados na `DIVIDA_CONGELADA` abaixo e pagos
 * no #1808; a lista vazia é o estado a manter.
 *
 * Os outros 615 sítios dinâmicos seguem não resolvidos DE PROPÓSITO: o argumento
 * é dado de runtime (identificador solto, `algo.campo`, `TABELA[x] ?? x`), e
 * cobrar isso é o passo 2 da issue — proibir `t()` sobre dado do operador. Chutar
 * o conjunto de valores ali seria falso positivo, e falso positivo em catraca
 * nova custa a confiança dela.
 * ══════════════════════════════════════════════════════════════════════════════ */

/** Só o que o dicionário promete: a coluna `es`. */
const temEspanholNoDicionario = (chave: string): boolean => Boolean(DICIONARIO[chave]?.es);

const COMO_CONSERTAR_CHAVE_DINAMICA =
  "Conserto: uma linha em lib/i18n/dicionario.ts para CADA valor que a expressão pode assumir — " +
  '"texto em português": { es: "texto en español" }. A chave vem de uma tabela de rótulo: traduza todos os valores dela. ' +
  "Não fala espanhol? Mande o PR assim mesmo e diga isso na descrição. " +
  "Se o valor não é texto de tela (identificador de wire, chave técnica), ele não deveria passar por t(): conserte a chamada. " +
  "É dívida de antes e não é do seu PR? Escreva o motivo em DIVIDA_CONGELADA, neste arquivo, com o par arquivo + valor. " +
  "Confira com: pnpm test:unit tests/unit/i18n-espanhol-cobre-a-tela.test.ts";

/**
 * A dívida de HOJE, congelada — um par arquivo + valor por linha.
 *
 * Como a `EM_PORTUGUES_DE_PROPOSITO` acima, esta lista SÓ ENCOLHE: pagar a
 * tradução (ou tirar o valor de `t()`) faz a entrada deixar de casar, e aí a
 * catraca fica vermelha pedindo a remoção daqui. Entrada nova precisa do
 * argumento escrito — e o argumento nunca é "não deu tempo".
 *
 * Casa por arquivo + valor, não por linha: rebase alheio que sobe três linhas
 * não tem de pintar vermelho quem não mexeu em tradução.
 */
const DIVIDA_CONGELADA: { arquivo: string; chave: string; motivo: string }[] = [];

function ehDividaCongelada(arquivo: string, chave: string): boolean {
  return DIVIDA_CONGELADA.some((e) => e.arquivo === arquivo && e.chave === chave);
}

describe("chave dinâmica: o valor que sai de tabela também tem de ter espanhol", () => {
  /**
   * Uma varredura só para o `describe` inteiro: cada uma lê e parseia centenas
   * de arquivos, e repetir por `it()` seria caro sem cobrar nada a mais.
   */
  const varredura = varrerChavesDeI18n(AREAS_DE_PRODUTO);
  const buracos = buracosDeEspanhol(varredura, temEspanholNoDicionario);

  it("a varredura enxerga de verdade — o verde abaixo não é vacuidade", () => {
    expect(
      varredura.arquivosVarridos,
      "nenhum arquivo varrido: o caminho das áreas mudou?",
    ).toBeGreaterThan(300);
    expect(
      varredura.dinamicos.length,
      "nenhuma chave dinâmica resolvida: a regra deixou de casar com o produto",
    ).toBeGreaterThan(50);
    const conhecido = varredura.dinamicos.find(
      (d) =>
        d.arquivo === "app/app/webhooks/_components/RuleEditor.tsx" &&
        d.valores.includes("No aniversário de um contato"),
    );
    expect(
      conhecido,
      "o sítio t(TRIGGER_LABELS[gatilho]) saiu de app/app/webhooks/_components/RuleEditor.tsx",
    ).toBeDefined();
    expect(
      conhecido?.procedencia,
      "a resolução parou de atravessar módulo: voltou a ser cega para tabela importada",
    ).toContain("labels.ts");
  });

  it("nenhum valor de chave dinâmica cai no português fora da dívida congelada", () => {
    const foraDaLista = buracos
      .filter((b) => !ehDividaCongelada(b.arquivo, b.chave))
      .map((b) => `${b.locais.join(" ")} → ${JSON.stringify(b.chave)}\n      ${b.procedencia}`);
    expect(
      foraDaLista,
      `${foraDaLista.length} valor(es) de chave dinâmica sem espanhol: quem escolheu espanhol vê isto em português. ` +
        COMO_CONSERTAR_CHAVE_DINAMICA,
    ).toEqual([]);
  });

  it("a dívida congelada só encolhe: entrada que deixou de casar é vermelho", () => {
    const pagas = DIVIDA_CONGELADA.filter(
      (e) => !buracos.some((b) => b.arquivo === e.arquivo && b.chave === e.chave),
    ).map((e) => `${e.arquivo} → ${JSON.stringify(e.chave)} (motivo declarado: ${e.motivo})`);
    expect(
      pagas,
      `${pagas.length} entrada(s) da DIVIDA_CONGELADA não casam mais com buraco nenhum: o valor foi traduzido, ` +
        "ou a chamada saiu de t(), ou o valor mudou de arquivo. Remova a entrada deste arquivo — a lista só encolhe.",
    ).toEqual([]);
  });
});

describe("dente da catraca: a fixture prova os dois lados", () => {
  /** A linha do `t(...)` na fixture, lida do arquivo — para não mentir sobre o local. */
  const linhaDoT = (caso: string): number => {
    const linhas = readFileSync(join(RAIZ, RAIZ_DAS_FIXTURES, caso, "painel.tsx"), "utf8").split(
      "\n",
    );
    const achou = linhas.findIndex((l) => l.includes("t(ROTULO_DA_ETAPA["));
    expect(achou, `a fixture ${caso} perdeu a chamada t(ROTULO_DA_ETAPA[...])`).toBeGreaterThan(-1);
    return achou + 1;
  };

  it("fixture VERDE passa: tabela de outro módulo, todos os valores com espanhol", () => {
    const varredura = varrerChavesDeI18n([`${RAIZ_DAS_FIXTURES}/verde`]);
    expect(
      varredura.dinamicos.length,
      "a fixture verde não produziu chave dinâmica nenhuma: a regra sob teste não foi exercitada",
    ).toBe(1);
    expect(buracosDeEspanhol(varredura, temEspanholNoDicionario)).toEqual([]);
  });

  it("fixture VERMELHA reprova no valor que falta, com arquivo:linha e o que fazer", () => {
    const varredura = varrerChavesDeI18n([`${RAIZ_DAS_FIXTURES}/vermelha`]);
    expect(
      varredura.dinamicos.length,
      "a fixture vermelha não produziu chave dinâmica nenhuma: a regra sob teste não foi exercitada",
    ).toBe(1);
    const buracos = buracosDeEspanhol(varredura, temEspanholNoDicionario);
    expect(buracos.map((b) => `${b.locais.join(" ")} → ${JSON.stringify(b.chave)}`)).toEqual([
      `${RAIZ_DAS_FIXTURES}/vermelha/painel.tsx:${linhaDoT("vermelha")} → "Rótulo que a fixture vermelha deixou sem tradução"`,
    ]);
    // A mensagem de falha é parte do gate: ela diz ONDE consertar e COMO conferir.
    expect(COMO_CONSERTAR_CHAVE_DINAMICA).toContain("lib/i18n/dicionario.ts");
    expect(COMO_CONSERTAR_CHAVE_DINAMICA).toContain("pnpm test:unit");
  });

  it("fixture VERDE de Object.entries/values passa, e o `.map` de dado de runtime não é chutado", () => {
    const varredura = varrerChavesDeI18n([`${RAIZ_DAS_FIXTURES}/iteracao-verde`]);
    expect(
      varredura.dinamicos.map((d) => d.expressao),
      "a fixture verde devia resolver `rotulo` de entries() e de values()",
    ).toEqual(["rotulo", "rotulo"]);
    expect(buracosDeEspanhol(varredura, temEspanholNoDicionario)).toEqual([]);
    // `itens.map((item) => t(item))` é dado de runtime: fora do alcance, e contado à parte.
    expect(varredura.naoResolvidos.map((n) => n.expressao)).toEqual(["item"]);
  });

  it("fixture VERMELHA de Object.entries/values reprova o valor que falta, nos dois sítios", () => {
    const varredura = varrerChavesDeI18n([`${RAIZ_DAS_FIXTURES}/iteracao-vermelha`]);
    const linhas = readFileSync(
      join(RAIZ, RAIZ_DAS_FIXTURES, "iteracao-vermelha", "painel.tsx"),
      "utf8",
    ).split("\n");
    const locais = linhas
      .map((l, i) => (l.includes("{t(rotulo)}") ? i + 1 : 0))
      .filter((n) => n > 0)
      .map((n) => `${RAIZ_DAS_FIXTURES}/iteracao-vermelha/painel.tsx:${n}`);
    expect(locais, "a fixture vermelha perdeu um dos dois `t(rotulo)`").toHaveLength(2);
    const buracos = buracosDeEspanhol(varredura, temEspanholNoDicionario);
    expect(buracos).toHaveLength(1);
    expect(buracos[0]?.chave).toBe("Rótulo que a fixture vermelha deixou sem tradução");
    expect(buracos[0]?.locais).toEqual(locais);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * DADO DO OPERADOR — o CEGO C da #603, o que a issue chama de "o pior".
 *
 * Os blocos acima cobrem a CHAVE: se o texto está escrito no código, ele tem
 * de ter espanhol. Este cobre o inverso, que é onde o defeito já aconteceu:
 * nada impedia `t()` sobre o que o OPERADOR digitou. Foi o PR #600
 * (`08257eed`): o nome que o operador deu a um tipo de atendimento passou
 * pelo dicionário e a tela passou a mostrar "Seguimiento" para quem tinha
 * escrito "Retorno".
 *
 * Dado de operador não é chave de dicionário: traduzi-lo MUDA o dado.
 *
 * ─── O que a regra pega ─────────────────────────────────────────────────────
 *
 *   t(<identificador que é parâmetro livre>)   → REPROVA
 *   t("literal")                               → passa, é texto do código
 *   t(TABELA[chave]) / t(CONSTANTE)            → passa, conjunto fechado
 *   (texto) => t(texto), o wrapper passa-adireto → passa, com razão escrita
 *
 * Medido em `b6d1141e8` (28/09) com esta mesma regra: 343 identificadores que são
 * parâmetro de função, 304 deles repasse puro (wrapper) e 39 sítio real. Os
 * 39 estão congelados em DADO_DO_OPERADOR_CONGELADO abaixo, um a um, com a
 * razão escrita — a issue proíbe allowlist sem motivo, e este arquivo tem um
 * teste só para isso.
 *
 * ─── O que a regra NÃO pega — recorte declarado ──────────────────────────────
 *
 * `t(obj.campo)`, `t(err.message)`, template com interpolação e
 * `TABELA[x] ?? x` também têm origem de runtime e seguem FORA desta fatia:
 * são 835 sítios não resolvidos na mesma varredura (medição), e congelá-los
 * aqui viraria uma lista grande demais para caber num PR sem afrouxar o
 * gate. Ficam declarados como continuação desta mesma issue.
 *
 * Callback de iteração — `lista.map((x) => t(x))` — fica isento pelo
 * passa-adireto, porque o corpo é chamada: 11 medidos na main `93713e10f`
 * (ex.: CredentialCard.tsx:194, PainelDeProvedores.tsx:297). Continuação da #603.
 * ══════════════════════════════════════════════════════════════════════════════ */

/** Um `t(<identificador que é parâmetro>)`: o valor veio de quem chamou. */
interface SitioDeDadoDeOperador {
  /** Caminho relativo à raiz, em barra normal. */
  readonly arquivo: string;
  /** 1-based. */
  readonly linha: number;
  /** `arquivo:linha` — é assim que a mensagem de falha aponta o conserto. */
  readonly local: string;
  /** O nome do parâmetro como está escrito no código (`tipo`, `rotulo`). */
  readonly expressao: string;
  /** `t` ou `traduzir`; os dois são cobrados. */
  readonly chamada: string;
  /** De onde o parâmetro vem, para quem for conferir. */
  readonly procedencia: string;
}

interface VarreduraDeDadoDeOperador {
  readonly sitios: readonly SitioDeDadoDeOperador[];
  /** Quantos arquivos foram de fato lidos — controle de não-vacuidade. */
  readonly arquivosVarridos: number;
}

/** `as const`, `satisfies`, parênteses e `as Tipo` não mudam valor nem escopo. */
function desembrulharNo(no: ts.Node): ts.Node {
  let atual = no;
  while (
    ts.isAsExpression(atual) ||
    ts.isSatisfiesExpression(atual) ||
    ts.isParenthesizedExpression(atual) ||
    ts.isTypeAssertionExpression(atual)
  ) {
    atual = atual.expression;
  }
  return atual;
}

/** O parâmetro está mesmo declarado aqui — identificador ou binding pattern? */
function declaraParametro(fn: ts.SignatureDeclaration, nome: string): boolean {
  return fn.parameters.some((p) => {
    const alvo = desembrulharNo(p.name);
    if (ts.isIdentifier(alvo)) return alvo.text === nome;
    if (ts.isArrayBindingPattern(alvo) || ts.isObjectBindingPattern(alvo)) {
      let achou = false;
      const anda = (el: ts.Node): void => {
        if (!ts.isBindingElement(el)) return;
        const nomeDoEl = desembrulharNo(el.name);
        if (ts.isIdentifier(nomeDoEl)) achou = achou || nomeDoEl.text === nome;
        if (ts.isArrayBindingPattern(nomeDoEl) || ts.isObjectBindingPattern(nomeDoEl)) {
          nomeDoEl.elements.forEach(anda);
        }
      };
      alvo.elements.forEach(anda);
      return achou;
    }
    return false;
  });
}

/**
 * PASSA-ADIRETO — a exceção da regra, e a razão dela.
 *
 * `const t = (texto) => traduzir(texto, idioma)` e os callbacks que só
 * encaminham (`(texto) => traduzir(texto, locale)`) são a ENTRADA da
 * tradução, não uma tela escolhendo o que mostrar: o parâmetro ali é a
 * própria chave que `t()` recebe de quem chama, e quem chama é cobrado no
 * ponto de chamada. São 304 dos 343 sítios medidos.
 *
 * O corte é o CORPO: se a função que declara o parâmetro devolve uma chamada
 * de função, o valor só atravessa; se devolve JSX, a tela está escolhendo
 * mostrar aquele valor — e aí é sítio real. Por isso o wrapper de `app/api/
 * external-db/_falha.ts` (corpo em ternário) entra na lista congelada.
 */
function ehPassaAdireto(fn: ts.SignatureDeclaration): boolean {
  const corpo = (fn as ts.SignatureDeclaration & { body?: ts.ConciseBody | ts.Block }).body;
  if (!corpo) return false;
  return ts.isCallExpression(desembrulharNo(corpo));
}

/** De onde o parâmetro vem, escrito para quem for consertar. */
function procedenciaDoParametro(fn: ts.SignatureDeclaration, fonte: ts.SourceFile): string {
  const linha = fonte.getLineAndCharacterOfPosition(fn.getStart()).line + 1;
  const ligacao = fn.parent;
  if (ligacao && ts.isVariableDeclaration(ligacao) && ts.isIdentifier(ligacao.name)) {
    return `parâmetro de \`${ligacao.name.text}\` (linha ${linha})`;
  }
  if (fn.name && ts.isIdentifier(fn.name))
    return `parâmetro de \`${fn.name.text}\` (linha ${linha})`;
  return `parâmetro de uma função declarada na linha ${linha}`;
}

/** A função mais próxima que declara este identificador como parâmetro. */
function funcaoQueDeclara(no: ts.Identifier): ts.SignatureDeclaration | null {
  for (let p: ts.Node | undefined = no.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p) && declaraParametro(p, no.text)) return p;
  }
  return null;
}

/**
 * Toda chamada `t(<parâmetro livre>)` nas raízes pedidas, menos o que é
 * repasse puro. As raízes são caminhos RELATIVOS à raiz do repo, como em
 * `arquivosDeCodigo`.
 */
function dadoDoOperador(raizes: readonly string[]): VarreduraDeDadoDeOperador {
  const sitios: SitioDeDadoDeOperador[] = [];
  let arquivosVarridos = 0;

  for (const arquivo of arquivosDeCodigo(raizes)) {
    const rel = caminhoRelativo(arquivo);
    // O dicionário declara as chaves; a função que as traduz não as usa.
    if (rel === "lib/i18n/dicionario.ts") continue;
    const src = readFileSync(arquivo, "utf8");
    if (!/\bt\(|\btraduzir\(/.test(src)) continue;
    arquivosVarridos++;
    const fonte = ts.createSourceFile(
      arquivo,
      src,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const visita = (no: ts.Node): void => {
      if (ts.isCallExpression(no) && no.arguments.length > 0) {
        const alvo = no.expression;
        const chamada = ts.isIdentifier(alvo)
          ? alvo.text
          : ts.isPropertyAccessExpression(alvo)
            ? alvo.name.text
            : "";
        if (chamada === "t" || chamada === "traduzir") {
          const primeiro = no.arguments[0];
          if (!primeiro) return;
          const arg = desembrulharNo(primeiro);
          if (ts.isIdentifier(arg)) {
            const dono = funcaoQueDeclara(arg);
            if (dono && !ehPassaAdireto(dono)) {
              const linha = fonte.getLineAndCharacterOfPosition(arg.getStart()).line + 1;
              sitios.push({
                arquivo: rel,
                linha,
                local: `${rel}:${linha}`,
                expressao: arg.text,
                chamada,
                procedencia: procedenciaDoParametro(dono, fonte),
              });
            }
          }
        }
      }
      ts.forEachChild(no, visita);
    };
    visita(fonte);
  }
  return { sitios, arquivosVarridos };
}

const COMO_CONSERTAR_DADO_DE_OPERADOR =
  "Dado que o operador digitou não é chave de dicionário: traduzi-lo muda o dado na tela. " +
  'Conserto: escreva o literal em cada ramo (condicao ? t("A") : t("B")) ou tire a chamada de t(). ' +
  "É dívida de antes e não é do seu PR? Escreva a razão em DADO_DO_OPERADOR_CONGELADO, neste arquivo, " +
  "com o par arquivo + expressão — a lista só encolhe. " +
  "Confira com: pnpm test:unit tests/unit/i18n-espanhol-cobre-a-tela.test.ts";

/**
 * A dívida de HOJE, congelada — um par arquivo + expressão por linha, cobrindo
 * os 39 sítios medidos na `main` de 28/09/2026.
 *
 * Casa por ARQUIVO + EXPRESSÃO, nunca por linha: rebase alheio que sobe três
 * linhas não tem de pintar vermelho quem não mexeu em tradução. Como as
 * outras listas desta casa, esta SÓ ENCOLHE — pagar o conserto (escrever o
 * literal, ou tirar a chamada de `t()`) faz a entrada deixar de casar, e aí a
 * catraca fica vermelha pedindo a remoção dela. Entrada nova precisa de
 * medição nova e de razão escrita; razão nunca é "não deu tempo".
 */
const DADO_DO_OPERADOR_CONGELADO: { arquivo: string; expressao: string; motivo: string }[] = [
  {
    arquivo: "app/api/v1/external-db/_falha.ts",
    expressao: "texto",
    motivo:
      "wrapper de tradução da rota de API: o corpo é um ternário (idioma ? traduzir(texto, idioma) : texto), " +
      "então a regra de passa-adireto não o alcança; é repasse da própria função e app/api não renderiza tela",
  },
  {
    arquivo: "app/app/ai/agents/[id]/_components/AgentForm.tsx",
    expressao: "rotulo",
    motivo:
      "rótulo de papel do array as const iterado na linha 746: conjunto fechado declarado no próprio arquivo",
  },
  {
    arquivo: "app/app/ai/agents/[id]/_components/RunTrace.tsx",
    expressao: "emptyMessage",
    motivo:
      "prop emptyMessage do componente, com padrão literal em português na declaração (linha 56): " +
      "texto de tela escolhido por quem monta a tela",
  },
  {
    arquivo: "app/app/ai/cases/_components/CaseChatPanel.tsx",
    expressao: "s",
    motivo:
      "sugestão de pergunta da constante SUGESTOES (linha 60): conjunto fechado, e o comentário no código " +
      "explica por que esta chamada passa por t()",
  },
  {
    arquivo: "app/app/ai/followups/[id]/_components/forms/ActionForm.tsx",
    expressao: "rotulo",
    motivo:
      "rótulo de opção de MODOS_DA_ACAO, tabela fechada do módulo, iterada via opcoes() na linha 181",
  },
  {
    arquivo: "app/app/ai/followups/[id]/_components/forms/ClassifyForm.tsx",
    expressao: "rotulo",
    motivo:
      "rótulo de opção de ALVOS_DA_CLASSIFICACAO, tabela fechada do módulo, iterada via opcoes() na linha 125",
  },
  {
    arquivo: "app/app/ai/followups/[id]/_components/forms/CollectForm.tsx",
    expressao: "rotulo",
    motivo:
      "rótulo de opção de TIPOS_DE_CAMPO, tabela fechada do módulo, iterada via opcoes() na linha 127",
  },
  {
    arquivo: "app/app/ai/followups/[id]/_components/forms/ConditionForm.tsx",
    expressao: "rotulo",
    motivo:
      "rótulo de opção de COMBINADORES, tabela fechada do módulo, iterada via opcoes() nas linhas 212 e 297",
  },
  {
    arquivo: "app/app/ai/followups/[id]/_components/forms/EndForm.tsx",
    expressao: "rotulo",
    motivo:
      "rótulo de opção de RESULTADOS_DO_FIM, tabela fechada do módulo, iterada via opcoes() nas linhas 123 e 161",
  },
  {
    arquivo: "app/app/ai/followups/[id]/_components/forms/WaitForm.tsx",
    expressao: "rotulo",
    motivo:
      "rótulo de opção de MODOS_DE_ESPERA, tabela fechada do módulo, iterada via opcoes() na linha 79",
  },
  {
    arquivo: "app/app/ai/providers/_components/PainelDeProvedores.tsx",
    expressao: "a",
    motivo:
      "aviso que o servidor devolve em ponto.avisos (catálogo fechado do backend), iterado na linha 538: " +
      "texto de produto, não frase do operador",
  },
  {
    arquivo: "app/app/metrics/_components/PerdasPanel.tsx",
    expressao: "titulo",
    motivo: "prop titulo do bloco interno, preenchida com literal na chamada (linhas 108-109)",
  },
  {
    arquivo: "app/app/metrics/_components/PerdasPanel.tsx",
    expressao: "coluna",
    motivo:
      "prop coluna do bloco interno, também preenchida com literal na chamada (linhas 108-109)",
  },
  {
    arquivo: "app/app/prospecting/_client.tsx",
    expressao: "label",
    motivo: "par do array as const literal declarado nas linhas 636-639",
  },
  {
    arquivo: "app/app/settings/conversoes/_linksRastreaveis.tsx",
    expressao: "h",
    motivo:
      "cabeçalho de tabela: o array já sai traduzido na linha 138 e o t(h) é a segunda passagem pelo " +
      "dicionário sobre o mesmo valor",
  },
  {
    arquivo: "app/app/settings/tenant/financeiro/_client.tsx",
    expressao: "r",
    motivo: "valor de Object.entries(TIPO_DE_CONTA), tabela fechada do módulo iterada na linha 115",
  },
  {
    arquivo: "app/onboarding/done/_client.tsx",
    expressao: "passo",
    motivo:
      "passo de p.comoFunciona, texto de produto do módulo de onboarding iterado na linha 128",
  },
  {
    arquivo: "components/agenda/AgendaInterativa.tsx",
    expressao: "razao",
    motivo:
      "razão do bloqueio de agenda (razaoDoBloco), a mesma família que lib/i18n/dicionario.ts já declara " +
      "à mão desde o PR #773",
  },
  {
    arquivo: "components/agenda/DetalheDoCompromisso.tsx",
    expressao: "label",
    motivo: "par do array as const dos status de decisão, declarado nas linhas 300-302",
  },
  {
    arquivo: "components/agenda/estados.tsx",
    expressao: "motivo",
    motivo:
      "prop motivo do estado de erro da agenda: mensagem vinda da camada de dados, exibida como texto de tela " +
      "(linha 107)",
  },
  {
    arquivo: "components/agenda/PainelDeMarcacao.tsx",
    expressao: "tipo",
    motivo:
      "tipo do compromisso cadastrado pelo operador — é EXATAMENTE o defeito do #600 (08257eed, " +
      '"Retorno" virando "Seguimiento"); o conserto por literal em cada ramo segue pendente',
  },
  {
    arquivo: "components/ai/ChaveDeConhecimento.tsx",
    expressao: "a",
    motivo:
      "aviso do servidor de catálogo fechado, como o próprio código declara nas linhas 127-130",
  },
  {
    arquivo: "components/branding/CampoDeLogo.tsx",
    expressao: "origemDoHerdado",
    motivo:
      "prop origemDoHerdado da peça (linha 100): texto de descrição vindo de quem monta a tela",
  },
  {
    arquivo: "components/branding/CampoDeLogo.tsx",
    expressao: "rotulo",
    motivo: "rótulo do par de aparências que já sai traduzido na construção (linhas 419-420)",
  },
  {
    arquivo: "components/connections/CanalVozClient.tsx",
    expressao: "fallback",
    motivo:
      "parâmetro fallback da função auxiliar errMsg (linha 37), texto de erro repassado por quem a chama",
  },
  {
    arquivo: "components/connections/ConnectionsClient.tsx",
    expressao: "fallback",
    motivo:
      "parâmetro fallback da função auxiliar errMsg (linha 67), texto de erro repassado por quem a chama",
  },
  {
    arquivo: "components/empty/EmptyState.tsx",
    expressao: "headline",
    motivo:
      "prop headline do componente de estado vazio: texto de tela escolhido por quem monta a tela",
  },
  {
    arquivo: "components/empty/EmptyState.tsx",
    expressao: "subcopy",
    motivo: "prop subcopy do componente de estado vazio: mesmo caso do headline (linha 43)",
  },
  {
    arquivo: "components/extensions/ExtensionsManager.tsx",
    expressao: "message",
    motivo:
      "parâmetro message do callback invalidateContext (linha 146), frase de erro repassada por quem o chama",
  },
  {
    arquivo: "components/inbox/CRMSidePanel.tsx",
    expressao: "vazio",
    motivo: "prop vazio do estado sem lista (linha 283): texto de tela passado pelo componente pai",
  },
  {
    arquivo: "components/inbox/media/MediaUnavailable.tsx",
    expressao: "kind",
    motivo:
      "prop kind: identificador técnico de mídia exibido no sr-only (linha 18) — valor de wire, não frase",
  },
  {
    arquivo: "components/kanban/ContatoDoNegocio.tsx",
    expressao: "rotulo",
    motivo: "par de TIPOS_DE_LINK, tabela fechada do módulo, iterada na linha 181",
  },
  {
    arquivo: "components/shell/NavHub.tsx",
    expressao: "title",
    motivo: "prop title do hub (linha 27), vinda do registro de portais do produto",
  },
  {
    arquivo: "components/shell/NavHub.tsx",
    expressao: "subtitle",
    motivo: "prop subtitle do hub (linha 28), mesma origem do title",
  },
  {
    arquivo: "components/shell/NavHub.tsx",
    expressao: "section",
    motivo: "seção devolvida por hubSections (linha 84): conjunto fechado do registro de navegação",
  },
];

function ehDadoCongelado(sitio: SitioDeDadoDeOperador): boolean {
  return DADO_DO_OPERADOR_CONGELADO.some(
    (e) => e.arquivo === sitio.arquivo && e.expressao === sitio.expressao,
  );
}

describe("dado do operador: t() não traduz o que o operador digitou", () => {
  /** Uma varredura só para o describe inteiro: relê centenas de arquivos. */
  const varredura = dadoDoOperador(AREAS_DE_PRODUTO);

  it("a varredura enxerga — os verdes abaixo não são vacuidade", () => {
    expect(
      varredura.arquivosVarridos,
      "nenhum arquivo varrido: o caminho das áreas mudou?",
    ).toBeGreaterThan(300);
    // O dente da regra é provado pela fixture VERMELHA e pelo "só encolhe" — não ancorar na dívida que a lista manda pagar.
  });

  it("nenhuma chamada t() recebe parâmetro livre fora da dívida congelada", () => {
    const foraDaLista = varredura.sitios
      .filter((s) => !ehDadoCongelado(s))
      .map((s) => `${s.local} ${s.chamada}(${s.expressao}) ← ${s.procedencia}`);
    expect(
      foraDaLista,
      `${foraDaLista.length} chamada(s) t() sobre dado que o operador digitou: dado de usuário não é chave ` +
        `de dicionário. ${COMO_CONSERTAR_DADO_DE_OPERADOR}`,
    ).toEqual([]);
  });

  it("a dívida congelada só encolhe: entrada que deixou de casar é vermelho", () => {
    const pagas = DADO_DO_OPERADOR_CONGELADO.filter(
      (e) => !varredura.sitios.some((s) => s.arquivo === e.arquivo && s.expressao === e.expressao),
    ).map((e) => `${e.arquivo} → t(${e.expressao}) (razão declarada: ${e.motivo})`);
    expect(
      pagas,
      `${pagas.length} entrada(s) de DADO_DO_OPERADOR_CONGELADO não casam mais com sítio nenhum: o literal ` +
        "foi escrito, ou a chamada saiu de t(), ou o parâmetro mudou de nome. Remova a entrada deste " +
        "arquivo — a lista só encolhe.",
    ).toEqual([]);
  });

  it("toda entrada tem razão escrita — lista sem motivo é fraude de gate", () => {
    const semRazao = DADO_DO_OPERADOR_CONGELADO.filter((e) => e.motivo.trim().length < 20).map(
      (e) => `${e.arquivo} → t(${e.expressao})`,
    );
    expect(
      semRazao,
      "entrada de allowlist sem razão escrita: a issue #603 proíbe allowlist sem motivo",
    ).toEqual([]);
    expect(
      DADO_DO_OPERADOR_CONGELADO.length,
      "a lista nasceu com 35 entradas (39 sítios) e só pode encolher: entrada nova exige medição nova",
    ).toBeLessThanOrEqual(35);
  });

  /** A linha do `t(...)` na fixture, lida do arquivo — para não mentir sobre o local. */
  const linhaDoT = (caso: string, chamada: string): number => {
    const linhas = readFileSync(join(RAIZ, RAIZ_DAS_FIXTURES, caso, "painel.tsx"), "utf8").split(
      "\n",
    );
    const achou = linhas.findIndex((l) => l.includes(chamada));
    expect(achou, `a fixture ${caso} perdeu a chamada ${chamada}`).toBeGreaterThan(-1);
    return achou + 1;
  };

  it("fixture VERMELHA reprova o t() sobre o que o operador digitou, com arquivo:linha", () => {
    const sitio = dadoDoOperador([`${RAIZ_DAS_FIXTURES}/dado-do-operador-vermelha`]);
    expect(
      sitio.sitios.map((s) => `${s.local} ${s.chamada}(${s.expressao})`),
      "o guardião deixou de reprovar t(tipo) sobre parâmetro livre: o cego C voltou",
    ).toEqual([
      `${RAIZ_DAS_FIXTURES}/dado-do-operador-vermelha/painel.tsx:${linhaDoT(
        "dado-do-operador-vermelha",
        "t(tipo)",
      )} t(tipo)`,
    ]);
  });

  it("fixture VERDE passa: literal, tabela de módulo e wrapper passa-adireto", () => {
    const sitio = dadoDoOperador([`${RAIZ_DAS_FIXTURES}/dado-do-operador-verde`]);
    expect(sitio.arquivosVarridos, "a fixture verde não foi lida: o caminho mudou?").toBe(1);
    expect(
      sitio.sitios.map((s) => `${s.local} ${s.chamada}(${s.expressao})`),
      "a fixture verde reprovou um desenho legítimo: falso positivo em catraca nova custa a confiança dela",
    ).toEqual([]);
  });

  it("a mensagem de falha diz o conserto e o comando de conferência", () => {
    expect(COMO_CONSERTAR_DADO_DE_OPERADOR).toContain("literal");
    expect(COMO_CONSERTAR_DADO_DE_OPERADOR).toContain("DADO_DO_OPERADOR_CONGELADO");
    expect(COMO_CONSERTAR_DADO_DE_OPERADOR).toContain("pnpm test:unit");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * CHAVE CONSTRUÍDA EM RUNTIME — as DUAS FORMAS de argumento que os dois guards
 * acima não alcançam. Fecha o que a issue #603 chama de "o guardião não vê
 * chave dinâmica nem t() sobre dado".
 *
 * Cada bloco cobre uma forma de CHAMADA:
 *
 *   passo 1 (#1172)  t(TABELA[k]) / t(TABELA.k)  → resolve e cobra espanhol
 *   cego C (#1867)   t(<parâmetro livre>)        → reprova (dado do operador)
 *   ESTE bloco       t(`prefixo.${x}`)           → reprova (chave montada)
 *                    t(<variável que não é parâmetro>) → reprova
 *
 * Medido em `origin/main` (`87593afda`) com esta mesma regra, sobre
 * `app/`, `components/`, `hooks/` e `lib/` (858 arquivos com `t()`, 9.817
 * chamadas): **5** sítios de template com interpolação e **29** de variável
 * que não é parâmetro e não resolve — 34 no total, congelados em
 * `CHAVE_DE_RUNTIME_CONGELADA` abaixo como 31 entradas (arquivo + expressão),
 * uma por motivo escrito. Os 9 sítios em que a variável É const de topo ou
 * importada resolvem pelo passo 1 e não entram na lista.
 *
 * Por que reprova em vez de só avisar: `traduzir()` devolve a PRÓPRIA chave
 * quando ela não está no dicionário (`DICIONARIO[texto]?.[idioma] ?? texto`,
 * lib/i18n/dicionario.ts:14271). A frase montada em runtime não está em
 * lugar nenhum, então quem escolheu espanhol recebe PORTUGUÊS — e o gate
 * ficava verde sobre a ausência. É o mesmo silêncio do defeito que o #600
 * achou vivo na `main` (`08257eed`).
 *
 * ─── Recorte declarado: o que ESTE bloco não pega ────────────────────────────
 *
 * - `t(<parâmetro livre>)` — é a fatia do cego C (#1867), com a lista e o
 *   próprio teste de "só encolhe" ali. Aqui entram só identificadores que NÃO
 *   são parâmetro, para a mesma chamada não ter duas listas.
 * - `t(obj.campo)`, `t(err.message)`, `TABELA[x] ?? x` — seguem fora, como o
 *   bloco do cego C já declara (são a maioria dos ~905 sítios não resolvidos).
 * - Callback anônimo `lista.map((x) => t(x))`: isento pelo passa-adireto do
 *   cego C porque o corpo é chamada. Medido na mesma varredura: **12** sítios
 *   anônimos não resolvidos (os outros 331 passa-adireto são a definição
 *   `const t = (texto) => traduzir(texto, idioma)`). Continuação da #603.
 * ══════════════════════════════════════════════════════════════════════════════ */

/** As duas formas de argumento que ninguém enxergava. */
type FormaDeRuntime = "variavel" | "template";

interface SitioDeChaveDeRuntime {
  /** Caminho relativo à raiz, em barra normal. */
  readonly arquivo: string;
  /** 1-based. */
  readonly linha: number;
  /** `arquivo:linha` — é assim que a mensagem de falha aponta o conserto. */
  readonly local: string;
  /** O argumento EXATAMENTE como está escrito no código. */
  readonly expressao: string;
  readonly forma: FormaDeRuntime;
  /** `t` ou `traduzir`; os dois são cobridos. */
  readonly chamada: string;
}

/**
 * Todo `t(<variável que não é parâmetro>)` e `t(\`prefixo.${x}\`)` das raízes.
 *
 * As raízes são caminhos RELATIVOS à raiz do repo, como em `arquivosDeCodigo`.
 *
 * O corte de "não é parâmetro" é o que divide este bloco do cego C: o
 * identificador que é parâmetro de uma função envolvente já é coberto (e
 * congelado) ali, e reportá-lo duas vezes obrigraria a mesma chamada a ter duas
 * razões escritas. Template com interpolação não tem esse conflito: nunca é
 * declaração de parâmetro.
 */
function chaveDeRuntime(raizes: readonly string[]): {
  readonly sitios: SitioDeChaveDeRuntime[];
  readonly arquivosVarridos: number;
} {
  const sitios: SitioDeChaveDeRuntime[] = [];
  let arquivosVarridos = 0;

  for (const arquivo of arquivosDeCodigo(raizes)) {
    const rel = caminhoRelativo(arquivo);
    // O dicionário declara as chaves; a função que as traduz não as usa.
    if (rel === "lib/i18n/dicionario.ts") continue;
    const src = readFileSync(arquivo, "utf8");
    if (!/\bt\(|\btraduzir\(/.test(src)) continue;
    arquivosVarridos++;
    const fonte = ts.createSourceFile(arquivo, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const visita = (no: ts.Node): void => {
      if (ts.isCallExpression(no) && no.arguments.length > 0) {
        const alvo = no.expression;
        const chamada = ts.isIdentifier(alvo)
          ? alvo.text
          : ts.isPropertyAccessExpression(alvo)
            ? alvo.name.text
            : "";
        if (chamada === "t" || chamada === "traduzir") {
          const primeiro = no.arguments[0];
          if (!primeiro) return;
          // A linha é lida do argumento BRUTO, igualzinho à catraca de chave
          // dinâmica: o join com `naoResolvidos` é por `arquivo:linha`, e
          // desembrulhar antes mudaria a posição em parêntese multilinha.
          const linha = fonte.getLineAndCharacterOfPosition(primeiro.getStart()).line + 1;
          const arg = desembrulharNo(primeiro);
          const forma: FormaDeRuntime | null = ts.isTemplateExpression(arg)
            ? "template"
            : ts.isIdentifier(arg) && funcaoQueDeclara(arg) === null
              ? "variavel"
              : null;
          if (forma) {
            sitios.push({
              arquivo: rel,
              linha,
              local: `${rel}:${linha}`,
              expressao: arg.getText(fonte),
              forma,
              chamada,
            });
          }
        }
      }
      ts.forEachChild(no, visita);
    };
    visita(fonte);
  }
  return { sitios, arquivosVarridos };
}

/**
 * Cruza as duas formas com o que a catraca de chave dinâmica NÃO resolve.
 *
 * Assimetria declarada, do mesmo jeito que os guards anteriores: o argumento
 * que o passo 1 resolve (const de topo, tabela importada, `Object.values()`) já
 * é cobrado em espanhol NAQUELE bloco, então reprovar aqui seria dupla cobrança
 * sobre o mesmo sítio — e o que ele NÃO resolve é justamente o valor que
 * ninguém sabe ler: a lista `semCobertura` é a que a allowlist congela.
 */
function varrerChaveDeRuntime(raizes: readonly string[]) {
  const forma = chaveDeRuntime(raizes);
  const semResolvedor = new Set(
    varrerChavesDeI18n(raizes).naoResolvidos.map((n) => n.local),
  );
  return {
    arquivosVarridos: forma.arquivosVarridos,
    sitios: forma.sitios,
    semCobertura: forma.sitios.filter((s) => semResolvedor.has(s.local)),
    resolvidas: forma.sitios.filter((s) => !semResolvedor.has(s.local)),
  };
}

const COMO_CONSERTAR_DE_RUNTIME =
  "Chave montada em runtime não está em nenhum dicionário: traduzir() devolve a frase em português. " +
  'Conserto: escreva o literal em cada ramo (condicao ? t("A") : t("B")) ou troque a interpolação por ' +
  'placeholder no literal (t("Meta de {indicador}").replace("{indicador}", valor)); se o valor é o que o ' +
  "operador digitou, tire a chamada de t(). " +
  "É dívida de antes e não é do seu PR? Escreva a razão em CHAVE_DE_RUNTIME_CONGELADA, neste arquivo, " +
  "com o par arquivo + expressão — a lista só encolhe. " +
  "Confira com: pnpm test:unit tests/unit/i18n-espanhol-cobre-a-tela.test.ts";

/**
 * A dívida de HOJE, congelada — os 34 sítios medidos na `main` `87593afda`
 * (04/10/2026), como 31 entradas arquivo + expressão.
 *
 * Casa por ARQUIVO + EXPRESSÃO, nunca por linha: rebase alheio que sobe três
 * linhas não pinta vermelho quem não mexeu em tradução. Como as outras listas
 * desta casa, esta SÓ ENCOLHE — consertar a chamada (literal, ou `t()` fora)
 * faz a entrada deixar de casar, e a catraca fica vermelha pedindo a remoção.
 * Entrada nova exige medição nova e razão escrita; razão nunca é "não deu
 * tempo". Esta fatia é decisão de produto declarada na issue #603, não
 * decidida aqui: nenhuma tradução foi acrescentada ou mudada por este PR.
 */
const CHAVE_DE_RUNTIME_CONGELADA: { arquivo: string; expressao: string; motivo: string }[] = [
  {
    arquivo: "app/api/v1/agenda/horarios-livres/route.ts",
    expressao: "`O período não pode passar de ${MAXIMO_DE_DIAS} dias.`",
    motivo:
      "erro de validação de rota: o número é a constante MAXIMO_DE_DIAS, mas a frase é montada em runtime " +
      "e não pode ser chave de dicionário; virar literal com placeholder é decisão de escopo (issue #603)",
  },
  {
    arquivo: "app/api/v1/ai/providers/route.ts",
    expressao: "`\"${corpo.default_model}\" não está no catálogo de ${corpo.provider}`",
    motivo:
      "rota de API que monta o erro com modelo e provedor vindos do CORPO da requisição: dado de runtime " +
      "no meio da frase, e app/api não renderiza tela",
  },
  {
    arquivo: "app/api/v1/ai/providers/route.ts",
    expressao:
      "`o catálogo de ${corpo.provider} ainda não foi sincronizado nesta instalação, então não deu para conferir \"${corpo.default_model}\" — se o identificador estiver errado, todo ponto que herda o padrão vai falhar.`",
    motivo:
      "mesma rota: aviso montado com corpo.provider e corpo.default_model — nenhum valor está escrito no " +
      "código, então nenhuma entrada do dicionário pode conter a frase inteira",
  },
  {
    arquivo: "app/api/v1/proposals/[id]/send/route.ts",
    expressao: "`Item sem preço definido: ${semPreco.join(\", \")}. Defina o preço antes de enviar.`",
    motivo:
      "erro que lista os itens sem preço devolvidos pelo banco: a lista é dado de runtime, e a frase " +
      "montada serve só à rota que dispara o envio",
  },
  {
    arquivo: "components/theme/theme-toggle.tsx",
    expressao: "`Tema: ${theme}. Cmd+Shift+L para alternar.`",
    motivo:
      "aria-label do alternador de tema montado com o nome do tema em runtime — tela de produto, e o " +
      "conserto (literal em cada ramo, claro/escuro) é decisão de produto declarada na issue #603",
  },
  {
    arquivo: "app/api/v1/ai/jev/route.ts",
    expressao: "soObserva",
    motivo:
      "valor lido de TAREFAS_DO_JEV no corpo da rota (linha 654), não é const de topo: é a recusa da " +
      "própria rota, não frase de tela",
  },
  {
    arquivo: "app/api/v1/conversations/[id]/drafts/route.ts",
    expressao: "mensagem",
    motivo:
      "mensagem montada no corpo da rota antes do throw (linha 126), a partir do dado que o validador " +
      "da requisição rejeitou",
  },
  {
    arquivo: "app/app/ads/meta/_components/MetaAdsClient.tsx",
    expressao: "aviso",
    motivo:
      "STATUS_DA_CONTA[c.status] atribuído DENTRO do componente (linha 163): conjunto fechado, mas o " +
      "resolvedor indexa só const de topo",
  },
  {
    arquivo: "app/app/ads/meta/_components/TabelaDeCampanhas.tsx",
    expressao: "rotulo",
    motivo:
      "rotuloDoIndicador(linha.resultado.indicador), helper chamado dentro do componente (linha 234): " +
      "conjunto fechado que o resolvedor não abre",
  },
  {
    arquivo: "app/app/ai/agents/[id]/_components/RunTrace.tsx",
    expressao: "errMsgBruto",
    motivo:
      "mensagem de erro devolvida pelo servidor (s.error.message, linha 71): dado de runtime — traduzir " +
      "erro de terceiro mudaria o texto do erro",
  },
  {
    arquivo: "app/app/ai/cases/_components/CaseReplyPanel.tsx",
    expressao: "disabledReason",
    motivo:
      "CASE_REPLY_DISABLED_REASON[status] atribuído dentro do componente (linha 28): tabela fechada " +
      "fora do índice de const de topo",
  },
  {
    arquivo: "app/app/ai/cases/avisos/_components/AlertasDoAviso.tsx",
    expressao: "rotulo",
    motivo:
      "ROTULO_DO_LINK[aviso.codigo] atribuído dentro do componente (linha 103): tabela fechada fora do " +
      "alcance do resolvedor",
  },
  {
    arquivo: "app/app/ai/cases/avisos/_components/AvisoNoWhatsApp.tsx",
    expressao: "frase",
    motivo:
      "frase montada no corpo do componente (linha 205) a partir do resultado do envio do aviso de teste",
  },
  {
    arquivo: "app/app/ai/cases/avisos/_components/EntregasDoAviso.tsx",
    expressao: "frase",
    motivo:
      "fraseDoErro(entrega.erro_codigo), helper chamado dentro do componente (linha 101): o código vem " +
      "do servidor, não do código",
  },
  {
    arquivo: "app/app/ai/providers/_components/CartaoDoJev.tsx",
    expressao: "aoDecidir",
    motivo:
      "registro?.aoDecidir lido dentro do componente (linha 857): frase do registro do Jev, e o índice " +
      "do registro é dado de runtime",
  },
  {
    arquivo: "app/app/ai/providers/_components/CartaoDoJev.tsx",
    expressao: "oQueFazer",
    motivo:
      "frasesDeFalha[falha.motivo] atribuído dentro do componente (linha 829): tabela fechada usada " +
      "como variável local",
  },
  {
    arquivo: "app/app/ai/providers/_components/CartaoDoJev.tsx",
    expressao: "efeito",
    motivo:
      "doRegistro(tarefa.id)?.aoConfirmarDecidir (linha 1183): texto do registro da tarefa, origem de " +
      "runtime para o resolvedor",
  },
  {
    arquivo: "app/app/ai/providers/_components/CartaoDoJev.tsx",
    expressao: "escolhida",
    motivo:
      "frase escolhida pela contagem de mensagens (linha 1288) e passada por t() antes do replace de " +
      "{dias}: a chave existe só depois da escolha",
  },
  {
    arquivo: "app/app/metrics/_components/PerdasPanel.tsx",
    expressao: "canonico",
    motivo:
      "rotuloDoMotivoDePerda(motivo) chamado dentro do componente (linha 104): o próprio código compara " +
      "o rótulo com o valor antes de decidir se traduz",
  },
  {
    arquivo: "app/app/settings/atualizacao/_components/UpdatePanel.tsx",
    expressao: "contaDoBanco",
    motivo:
      "textoDaRodadaDoBanco(data.run?.rodada_do_banco) (linha 166): texto derivado de dado do banco, " +
      "usado nas linhas 189 e 230",
  },
  {
    arquivo: "app/onboarding/funil/_client.tsx",
    expressao: "explicacao",
    motivo:
      "explicacaoDoPasso(etapa.passo) (linha 124): helper chamado dentro do componente sobre o passo " +
      "vindo do dado da etapa",
  },
  {
    arquivo: "components/admin/ImpersonateButton.tsx",
    expressao: "rawMsg",
    motivo:
      "message de erro devolvida pela API (linha 59): dado de runtime — a mensagem do servidor não é " +
      "chave de dicionário",
  },
  {
    arquivo: "components/ai/BudgetCard.tsx",
    expressao: "AVISO_DE_MEDICAO",
    motivo:
      "const de topo cujo valor é concatenação de literais com `+` (linha 155): forma que o resolvedor " +
      "não abre; texto fixo do produto, sem dado nenhum no meio",
  },
  {
    arquivo: "components/ai/CitationsPanel.tsx",
    expressao: "sourceLabel",
    motivo:
      "SOURCE_LABEL[c.source_type] atribuído dentro do componente (linha 48): tabela fechada fora do " +
      "índice de const de topo",
  },
  {
    arquivo: "components/ai/SourceStatusBadge.tsx",
    expressao: "label",
    motivo:
      "desestruturação de MAP[derived] dentro do componente (linha 58): tabela fechada do módulo, mas o " +
      "identificador é variável local",
  },
  {
    arquivo: "components/auth/PasswordStrength.tsx",
    expressao: "label",
    motivo:
      "array literal de rótulos indexado por score DENTRO do componente (linha 16): conjunto fechado; a " +
      "chamada aparece nas linhas 25 e 35",
  },
  {
    arquivo: "components/contacts/TimelineView.tsx",
    expressao: "reasonTrim",
    motivo:
      "it.reason vindo do payload da linha do tempo (linha 114): dado gravado, não frase de tela",
  },
  {
    arquivo: "components/inbox/MessageBubble.tsx",
    expressao: "senderLabel",
    motivo:
      "rótulo do remetente calculado por IIFE dentro do componente (linha 139): a origem é o dado da " +
      "mensagem",
  },
  {
    arquivo: "components/kanban/FilterBar.tsx",
    expressao: "rotulo",
    motivo:
      "rotuloDoMotivoDePerda(motivo) chamado dentro do componente (linha 185): o código compara o " +
      "rótulo com o valor antes de decidir se traduz",
  },
  {
    arquivo: "components/operacao/SeloDeAutoria.tsx",
    expressao: "texto",
    motivo:
      "autorNaTela(kind) chamado dentro do componente (linha 45): helper sobre o tipo de autoria, " +
      "conjunto fechado não resolvível estaticamente",
  },
  {
    arquivo: "components/shell/CommandPalette.tsx",
    expressao: "rotuloGrupo",
    motivo:
      "ROTULO_GRUPO.get(grupoId) ?? grupoId (linha 225): o fallback é o próprio id de runtime, e a " +
      "chamada aparece nas linhas 227 e 230",
  },
];

function ehChaveDeRuntimeCongelada(sitio: SitioDeChaveDeRuntime): boolean {
  return CHAVE_DE_RUNTIME_CONGELADA.some(
    (e) => e.arquivo === sitio.arquivo && e.expressao === sitio.expressao,
  );
}

describe("chave construída em runtime: t() não recebe o que o código não escreveu", () => {
  /** Uma varredura só para o describe inteiro: relê centenas de arquivos. */
  const varredura = varrerChaveDeRuntime(AREAS_DE_PRODUTO);

  it("a varredura enxerga — os verdes abaixo não são vacuidade", () => {
    expect(
      varredura.arquivosVarridos,
      "nenhum arquivo varrido: o caminho das áreas mudou?",
    ).toBeGreaterThan(300);
    // O join com a catraca de chave dinâmica é por arquivo:linha. Se algum
    // sítio ficasse sem lado nenhum, a lista congelada estaria silenciando
    // chamada em vez de declará-la.
    expect(
      varredura.semCobertura.length + varredura.resolvidas.length,
      "sítio fora dos dois lados do cruzamento com naoResolvidos",
    ).toBe(varredura.sitios.length);
    expect(
      varredura.resolvidas.length,
      "nenhuma variável resolveu pelo passo 1: o cruzamento parou de achar const de topo",
    ).toBeGreaterThan(0);
    expect(
      varredura.sitios.find(
        (s) =>
          s.forma === "template" && s.arquivo === "components/theme/theme-toggle.tsx",
      ),
      "o sítio t(`Tema: ${theme}…`) saiu de components/theme/theme-toggle.tsx",
    ).toBeDefined();
    expect(
      varredura.sitios.filter((s) => s.forma === "template").length,
      "template com interpolação deixou de ser forma de runtime",
    ).toBeGreaterThanOrEqual(5);
  });

  it("nenhuma chave construída em runtime passa por t() fora da dívida congelada", () => {
    const foraDaLista = varredura.semCobertura
      .filter((s) => !ehChaveDeRuntimeCongelada(s))
      .map((s) => `${s.local} ${s.chamada}(${s.forma}) ${s.expressao.slice(0, 100)}`);
    expect(
      foraDaLista,
      `${foraDaLista.length} chamada(s) t() com chave montada em runtime ou sobre variável que ninguém ` +
        `resolve: a frase sai em português para quem escolheu espanhol. ${COMO_CONSERTAR_DE_RUNTIME}`,
    ).toEqual([]);
  });

  it("a dívida de runtime só encolhe: entrada que deixou de casar é vermelho", () => {
    const pagas = CHAVE_DE_RUNTIME_CONGELADA.filter(
      (e) => !varredura.semCobertura.some((s) => s.arquivo === e.arquivo && s.expressao === e.expressao),
    ).map((e) => `${e.arquivo} → ${e.expressao.slice(0, 80)} (razão declarada: ${e.motivo.slice(0, 60)}…)`);
    expect(
      pagas,
      `${pagas.length} entrada(s) de CHAVE_DE_RUNTIME_CONGELADA não casam mais com sítio nenhum: a chamada ` +
        "foi consertada, ou a variável virou literal. Remova a entrada deste arquivo — a lista só encolhe.",
    ).toEqual([]);
  });

  it("toda entrada tem razão escrita — lista sem motivo é fraude de gate", () => {
    const semRazao = CHAVE_DE_RUNTIME_CONGELADA.filter((e) => e.motivo.trim().length < 20).map(
      (e) => `${e.arquivo} → ${e.expressao.slice(0, 60)}`,
    );
    expect(
      semRazao,
      "entrada de allowlist sem razão escrita: a issue #603 proíbe allowlist sem motivo",
    ).toEqual([]);
    expect(
      CHAVE_DE_RUNTIME_CONGELADA.length,
      "a lista nasceu com 31 entradas (34 sítios medidos na main 87593afda) e só pode encolher: " +
        "entrada nova exige medição nova",
    ).toBeLessThanOrEqual(31);
  });

  /** A linha do `t(...)` na fixture, lida do arquivo — para não mentir sobre o local. */
  const linhaDaFixture = (caso: string, trecho: string): number => {
    const linhas = readFileSync(join(RAIZ, RAIZ_DAS_FIXTURES, caso, "painel.tsx"), "utf8").split("\n");
    const achou = linhas.findIndex((l) => l.includes(trecho));
    expect(achou, `a fixture ${caso} perdeu o trecho ${trecho}`).toBeGreaterThan(-1);
    return achou + 1;
  };

  it("fixture VERMELHA reprova a variável local e a chave montada em runtime", () => {
    const vermelha = varrerChaveDeRuntime([`${RAIZ_DAS_FIXTURES}/chave-de-runtime-vermelha`]);
    expect(
      vermelha.semCobertura.map((s) => `${s.local} ${s.forma}`),
      "o guardião deixou de reprovar t(variável) ou t(`…${}`): o cego voltou",
    ).toEqual([
      `${RAIZ_DAS_FIXTURES}/chave-de-runtime-vermelha/painel.tsx:${linhaDaFixture(
        "chave-de-runtime-vermelha",
        "{t(rotulo)}",
      )} variavel`,
      `${RAIZ_DAS_FIXTURES}/chave-de-runtime-vermelha/painel.tsx:${linhaDaFixture(
        "chave-de-runtime-vermelha",
        "{t(`Meta de",
      )} template`,
    ]);
  });

  it("fixture VERDE passa: literal, const de topo, tabela fechada e wrapper", () => {
    const verde = varrerChaveDeRuntime([`${RAIZ_DAS_FIXTURES}/chave-de-runtime-verde`]);
    expect(
      verde.arquivosVarridos,
      "a fixture verde não foi lida: o caminho mudou?",
    ).toBe(1);
    // `t(ROTULO_FIXO)` É uma variável — e resolve pelo passo 1. É ela que prova
    // que a regra não reprova toda variável, só a que ninguém consegue ler.
    expect(
      verde.resolvidas.map((s) => s.expressao),
      "a const de topo deixou de resolver: o cruzamento com o passo 1 quebrou",
    ).toEqual(["ROTULO_FIXO"]);
    expect(
      verde.semCobertura,
      "a fixture verde reprovou um desenho legítimo: falso positivo em catraca nova custa a confiança dela",
    ).toEqual([]);
  });

  it("a mensagem de falha diz o conserto e o comando de conferência", () => {
    expect(COMO_CONSERTAR_DE_RUNTIME).toContain("literal");
    expect(COMO_CONSERTAR_DE_RUNTIME).toContain("CHAVE_DE_RUNTIME_CONGELADA");
    expect(COMO_CONSERTAR_DE_RUNTIME).toContain("pnpm test:unit");
  });
});

