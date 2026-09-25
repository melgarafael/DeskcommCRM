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
    arquivo: "app/global-error.tsx",
    texto: "Tente novamente em instantes. Se persistir, contate o suporte com o ID abaixo.",
    motivo:
      "é o error boundary da RAIZ: renderiza fora de qualquer provider, quando o app já falhou. Chamar um hook de contexto ali é justamente o que não pode falhar de novo",
  },
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
 * (5 chamadas). São esses 9 que a `DIVIDA_CONGELADA` abaixo congela.
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
const DIVIDA_CONGELADA: { arquivo: string; chave: string; motivo: string }[] = [
  {
    arquivo: "app/app/ai/inbox/_components/AgentInboxList.tsx",
    chave: "informativo",
    motivo:
      "valor de SEVERITY_LABEL (lib/ai/agent-inbox-copy.ts): a chave ainda não tem linha no dicionário",
  },
  {
    arquivo: "app/app/webhooks/_components/RuleEditor.tsx",
    chave: "Iniciar fluxo de mensagem",
    motivo:
      "valor de ACTION_LABELS (app/app/webhooks/_components/labels.ts): a chave ainda não tem linha no dicionário",
  },
  {
    arquivo: "app/app/webhooks/_components/RuleEditor.tsx",
    chave: "No aniversário de um contato",
    motivo:
      "valor de TRIGGER_LABELS (app/app/webhooks/_components/labels.ts): a chave ainda não tem linha no dicionário",
  },
  {
    arquivo: "app/app/webhooks/_components/RuleEditor.tsx",
    chave: "Quando faltarem N dias para uma data do funil",
    motivo:
      "valor de TRIGGER_LABELS (app/app/webhooks/_components/labels.ts): a chave ainda não tem linha no dicionário",
  },
  {
    arquivo: "app/app/webhooks/_components/RuleEditor.tsx",
    chave: "Quando um horário for cancelado",
    motivo:
      "valor de TRIGGER_LABELS (app/app/webhooks/_components/labels.ts): a chave ainda não tem linha no dicionário",
  },
  {
    arquivo: "app/app/webhooks/_components/RuleEditor.tsx",
    chave: "Quando um horário for marcado",
    motivo:
      "valor de TRIGGER_LABELS (app/app/webhooks/_components/labels.ts): a chave ainda não tem linha no dicionário",
  },
  {
    arquivo: "app/app/webhooks/_components/RuleEditor.tsx",
    chave: "Quando um horário for remarcado",
    motivo:
      "valor de TRIGGER_LABELS (app/app/webhooks/_components/labels.ts): a chave ainda não tem linha no dicionário",
  },
  {
    arquivo: "app/app/webhooks/_components/RuleEditor.tsx",
    chave: "Quando um horário pendente for confirmado",
    motivo:
      "valor de TRIGGER_LABELS (app/app/webhooks/_components/labels.ts): a chave ainda não tem linha no dicionário",
  },
  {
    arquivo: "app/onboarding/invite-team/_form.tsx",
    chave: "Assistente com autonomia de operação",
    motivo:
      "valor de ROTULO_DO_PAPEL (lib/auth/types.ts): a chave ainda não tem linha no dicionário",
  },
];

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
