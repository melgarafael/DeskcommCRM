/**
 * A VERSÃO DA GRAPH API TEM UM LUGAR SÓ — e esta é a catraca que cobra isso.
 *
 * O defeito que ela guarda não é o literal solto: é o segundo literal. A versão
 * estava escrita à mão em dez arquivos de produção, todos com o mesmo `"v22.0"`.
 * No dia do bump, quem sobe a versão edita nove e esquece um — e o esquecido
 * responde com a versão antiga. A instalação passa a falar duas versões da mesma
 * plataforma, e o sintoma aparece longe da causa ("o template aprovado não
 * envia" numa tela, o modelo sumindo em outra).
 *
 * A catraca é do tipo que o repositório já usa (`fila-tem-uma-definicao-so`,
 * `schema` do fluxo): nenhuma infraestrutura nova, só leitura de arquivo e uma
 * varredura. Ela olha CÓDIGO, não texto:
 *
 * - comentário que cita a versão **medida** não reprova. `template-sync.ts`
 *   registra que a Meta reescreveu o `next` para `v25.0` ao ser chamada em
 *   `v22.0`; isso é história medida, e história não se conserta movendo para
 *   dentro de uma constante.
 * - fixture de teste não reprova — o alvo é código de produção, que é o que
 *   chama a Graph valendo. O preço é um teste que esconda o literal; o preço do
 *   contrário (docs e changelog reprovando) é a catraca virar ruído e alguém
 *   desligá-la.
 *
 * ─── Pontos cegos DECLARADOS ─────────────────────────────────────────────────
 *
 * A catraca lê o literal como ele está escrito no fonte. Ela NÃO pega a versão
 * MONTADA: `"v" + "22.0"`, `` `v${22}.0` ``, ou um template cujo número vem de
 * pedaços. Quem escreve assim está driblando de propósito, e perseguir isso
 * exigiria avaliar expressões — outra ferramenta, com outro custo. Fica escrito
 * para ninguém confundir o verde com uma prova que ela não dá.
 *
 * Ver `lib/graph-version.ts` — inclusive sobre a versão NÃO ter subido aqui.
 */
import fs from "node:fs";
import path from "node:path";

import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VERSAO_PADRAO_DA_GRAPH, graphVersion } from "@/lib/graph-version";

const RAIZ = path.join(__dirname, "..", "..");

/** O único arquivo de produção que pode escrever a versão à mão. */
const MODULO_UNICO = path.join("lib", "graph-version.ts");

/** Onde mora código que chama a Graph valendo. */
const ONDE_PROCURAR = ["app", "lib", "components", "hooks", "workers", "scripts"];

const PASTAS_IGNORADAS = new Set([
  "node_modules",
  ".git",
  ".next",
  "test-results",
  "playwright-report",
]);

const CODIGO = /\.(ts|tsx|mjs|js)$/;

/**
 * Literal de versão da Graph, nas duas formas em que ela chega à chamada:
 *
 * - string inteira: `"v22.0"`, `'v26.0'`, `` `v23.0` ``;
 * - segmento de endereço: `/v22.0/`, `/v22.0?fields=…`, `/v22.0` no fim da
 *   string ou do template, `/v22.0${caminho}`, `"v22.0/"`.
 *
 * A primeira versão desta catraca só conhecia a string inteira — aspas dos dois
 * lados. A forma que o código de canal realmente escreve é a segunda: o número
 * no meio do endereço (`` `https://graph.facebook.com/v22.0/${id}` ``). Medido:
 * pôr esse endereço em `lib/channels/meta/validate-credentials.ts` deixava os
 * quatro casos verdes.
 *
 * A borda é o que separa a versão de texto qualquer: à esquerda aspas ou `/`, à
 * direita aspas, `/`, `?`, `#` ou o começo de uma interpolação. Por isso
 * `design system · v0.1` (sem borda), `"v1.25.0"` (versão de release, com um
 * terceiro número) e `/api/v1/` (sem ponto) não reprovam — os três estão em
 * `NAO_E_VERSAO_DA_GRAPH`, abaixo.
 */
const LITERAL_DE_VERSAO = /(?<=["'`/])v\d+\.\d+(?=["'`/?#]|\$\{)/;

/** Linhas que TÊM de reprovar. A primeira é a sabotagem que a versão anterior deixava passar. */
const E_VERSAO_DA_GRAPH = [
  "      `https://graph.facebook.com/v22.0/${input.phoneNumberId}` +",
  "const BASE = `https://graph.facebook.com/v22.0`;",
  'const url = "https://graph.facebook.com/v22.0?fields=id";',
  "const url = `/v22.0${caminho}`;",
  'const url = "v22.0/" + id;',
  'const version = input.graphVersion ?? "v22.0";',
  "const v = 'v26.0';",
];

/** Linhas que NÃO podem reprovar — senão a catraca vira ruído e alguém a desliga. */
const NAO_E_VERSAO_DA_GRAPH = [
  '<div className="ds-sub">design system · v0.1</div>',
  'const release = "v1.25.0";',
  "const rota = `/api/v1/contacts`;",
  "      `https://graph.facebook.com/${version}/${input.phoneNumberId}` +",
  "const url = `https://graph.facebook.com/${VERSAO_DA_API}/${caminho}`;",
];

/**
 * Tira comentário antes de varrer. Sem isto, a catraca reprovaria o próprio
 * arquivo que documenta a versão medida — e uma catraca que reprova documentação
 * é uma catraca que ensina a apagar documentação.
 *
 * ⚠️ QUEM DIZ O QUE É COMENTÁRIO É O PARSER DO TYPESCRIPT, NÃO UMA REGEX.
 *
 * A versão anterior tirava comentário com três regex, e regex não sabe onde uma
 * string começa. Medido pelo revisor do lote 8: `["image/*", "audio/*"]` antes e
 * um JSDoc depois, e o `/*` de DENTRO da string abria um "comentário" que só
 * fechava no `*\/` do JSDoc — o endereço da Graph escrito à mão no meio sumia, e
 * a catraca passava 5/5. A forma existe na árvore
 * (`accept="image/*,video/*"` em `components/inbox/composer/AttachMenu.tsx`). O
 * irmão do mesmo defeito: `` `${protocolo}//graph.facebook.com/v22.0/…` `` — o
 * `//` depois da interpolação lia como comentário de linha.
 *
 * O `ts.createScanner` sozinho também não basta: sem o parser ele não sabe que o
 * `}` fecha uma interpolação (e o resto do template volta a ser lido como
 * código), nem distingue regex de divisão. Então o arquivo é PARSEADO, e só o que
 * cai FORA de todo token vira espaço — que, fora de token, é exatamente espaço em
 * branco, comentário e o `#!` da primeira linha. Quebras de linha ficam, para as linhas continuarem sendo
 * as do arquivo. Nós de JSDoc são pulados: os "tokens" deles moram dentro do
 * comentário.
 */
function semComentarios(fonte: string, arquivo = "trecho.tsx"): string {
  const tipo = arquivo.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : /\.m?js$/.test(arquivo)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const raiz = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true, tipo);
  const ehCodigo = new Uint8Array(fonte.length);

  const marcar = (no: ts.Node): void => {
    if (no.kind >= ts.SyntaxKind.FirstJSDocNode && no.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const filhos = no.getChildren(raiz);
    if (filhos.length === 0) {
      ehCodigo.fill(1, no.getStart(raiz), no.getEnd());
      return;
    }
    for (const filho of filhos) marcar(filho);
  };
  marcar(raiz);

  const saida: string[] = new Array(fonte.length);
  for (let i = 0; i < fonte.length; i++) {
    const c = fonte[i]!;
    saida[i] = ehCodigo[i] === 1 || c === "\n" || c === "\r" ? c : " ";
  }
  return saida.join("");
}

/** As linhas de um fonte que escrevem a versão à mão, já sem comentário. */
function linhasComVersao(fonte: string, arquivo?: string): string[] {
  // Atalho seguro: tirar comentário só troca caractere por espaço, e espaço não
  // é borda do padrão — então um arquivo sem casamento no texto cru não tem
  // casamento depois. Parsear só quem casa cru poupa ~2s de 1.800 arquivos.
  if (!LITERAL_DE_VERSAO.test(fonte)) return [];
  return semComentarios(fonte, arquivo)
    .split("\n")
    .filter((linha) => LITERAL_DE_VERSAO.test(linha));
}

function varrer(diretorio: string, achados: string[] = []): string[] {
  for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
    const caminho = path.join(diretorio, entrada.name);
    if (entrada.isDirectory()) {
      if (PASTAS_IGNORADAS.has(entrada.name)) continue;
      varrer(caminho, achados);
      continue;
    }
    if (!CODIGO.test(entrada.name)) continue;
    // Fixture de teste não reprova: o alvo é código de produção.
    if (/\.(test|spec)\./.test(entrada.name)) continue;
    achados.push(caminho);
  }
  return achados;
}

const ARQUIVOS = ONDE_PROCURAR.flatMap((pasta) => varrer(path.join(RAIZ, pasta)));

function culpados(): string[] {
  return ARQUIVOS.filter((caminho) => {
    const relativo = path.relative(RAIZ, caminho);
    if (relativo === MODULO_UNICO) return false;
    return linhasComVersao(fs.readFileSync(caminho, "utf8"), caminho).length > 0;
  }).map((caminho) => path.relative(RAIZ, caminho));
}

describe("a versão da Graph tem um lugar só", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("nenhum arquivo de produção escreve a versão da Graph à mão", () => {
    // Controle da própria catraca: se a varredura quebrar (pasta renomeada,
    // sufixo novo), a lista volta vazia e o teste passaria medindo nada. É a
    // falha-em-verde que este repositório trata como o pior defeito.
    expect(ARQUIVOS.length).toBeGreaterThan(1000);
    expect(ARQUIVOS.map((c) => path.relative(RAIZ, c))).toContain(MODULO_UNICO);

    expect(culpados()).toEqual([]);
  });

  it("o módulo único declara a versão — a catraca não passa com o arquivo apagado", () => {
    const literais = linhasComVersao(fs.readFileSync(path.join(RAIZ, MODULO_UNICO), "utf8"), MODULO_UNICO).map(
      (linha) => linha.match(LITERAL_DE_VERSAO)![0],
    );

    expect(literais).toEqual([VERSAO_PADRAO_DA_GRAPH]);
  });

  it("a catraca reconhece a versão no meio do endereço, e não confunde versão de outra coisa", () => {
    // Fixa a forma do padrão independente da árvore: a varredura acima só prova
    // que HOJE não há culpado, e ficaria verde com um padrão que não pega nada.
    const pegas = (linhas: string[]) => linhas.filter((linha) => linhasComVersao(linha).length > 0);

    expect(pegas(E_VERSAO_DA_GRAPH)).toEqual(E_VERSAO_DA_GRAPH);
    expect(pegas(NAO_E_VERSAO_DA_GRAPH)).toEqual([]);

    // Comentário continua fora: citar a versão medida não é escrevê-la à mão.
    expect(pegas(["// a Meta reescreveu o next para https://graph.facebook.com/v25.0/abc"])).toEqual([]);
    expect(pegas(["const x = 1; // chamado em https://graph.facebook.com/v22.0/abc"])).toEqual([]);
  });

  it("comentário é o que o parser diz que é — `/*` e `//` dentro de string e de template não escondem código", () => {
    // A sabotagem que a versão por regex deixava passar, na forma medida: glob de
    // MIME antes, JSDoc depois, o endereço à mão no meio.
    const globAntesDoJsDoc = [
      'const ACEITOS = ["image/*", "audio/*"];',
      "const URL_DA_GRAPH = `https://graph.facebook.com/v22.0/${id}`;",
      "/** Confere o número antes de gravar. */",
      "export async function validar() {}",
    ].join("\n");
    expect(linhasComVersao(globAntesDoJsDoc, "validate-credentials.ts")).toEqual([
      "const URL_DA_GRAPH = `https://graph.facebook.com/v22.0/${id}`;",
    ]);

    // O `//` depois de uma interpolação é texto do template, não comentário.
    expect(linhasComVersao("const url = `${protocolo}//graph.facebook.com/v22.0/${id}`;")).toHaveLength(1);

    // E o outro lado, que não pode regredir: comentário DE VERDADE continua fora,
    // inclusive vizinho de string com `/*` e de regex que parece comentário.
    const soComentarios = [
      'const ACEITOS = ["image/*"];',
      "// a Meta reescreveu o next para https://graph.facebook.com/v25.0/abc",
      '/** doc citando "v22.0" */',
      'const re = /\\/\\*[\\s\\S]*?\\*\\//g; /* bloco `v23.0` */ // linha "v24.0"',
    ].join("\n");
    expect(linhasComVersao(soComentarios, "vizinho.ts")).toEqual([]);
  });

  it("o .env.example não anuncia versão diferente da que o código usa", () => {
    // O default é documentado em dois lugares: aqui e no `.env.example`. Se o
    // número subir num só, quem instala lê uma versão e o código fala outra.
    // Ausente ou vazio passa (o default do código vale); número diferente, não.
    const exemplo = fs.readFileSync(path.join(RAIZ, ".env.example"), "utf8");
    const linha = exemplo.split("\n").find((l) => /^META_GRAPH_VERSION=/.test(l));

    expect(linha).toBeDefined();
    const valor = linha!.slice("META_GRAPH_VERSION=".length).trim();
    if (valor !== "") expect(valor).toBe(VERSAO_PADRAO_DA_GRAPH);
  });

  it("graphVersion() honra META_GRAPH_VERSION e cai no default sem ela", () => {
    vi.stubEnv("META_GRAPH_VERSION", "v23.0");
    expect(graphVersion()).toBe("v23.0");

    vi.stubEnv("META_GRAPH_VERSION", "");
    expect(graphVersion()).toBe(VERSAO_PADRAO_DA_GRAPH);
  });
});
