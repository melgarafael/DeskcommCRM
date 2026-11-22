/**
 * Tira COMENTÁRIO do fonte e deixa o resto — a régua das catracas de invariante.
 *
 * Uma catraca que varre código precisa distinguir "o endereço está ESCRITO no
 * código" de "o endereço aparece na prosa que documenta o código". Sem essa
 * distinção ela reprova o próprio comentário que registra a medição — e uma
 * catraca que reprova documentação ensina a apagar documentação.
 *
 * ⚠️ QUEM DIZ O QUE É COMENTÁRIO É O PARSER DO TYPESCRIPT, NÃO UMA REGEX.
 *
 * A primeira versão disto (inline em `versao-da-graph-num-lugar-so.test.ts`)
 * tirava comentário com três regex, e regex não sabe onde uma string começa.
 * Medido pelo revisor do lote 8: `["image/*", "audio/*"]` antes e um JSDoc
 * depois, e o `/*` de DENTRO da string abria um "comentário" que só fechava no
 * `*\/` do JSDoc — o endereço da Graph escrito à mão no meio sumia, e a catraca
 * passava 5/5. A forma existe na árvore (`accept="image/*,video/*"` em
 * `components/inbox/composer/AttachMenu.tsx`).
 *
 * O `ts.createScanner` sozinho também não basta: sem o parser ele não sabe que o
 * `}` fecha uma interpolação (e o resto do template volta a ser lido como
 * código), nem distingue regex de divisão. Então o arquivo é PARSEADO, e só o que
 * cai FORA de todo token vira espaço — que, fora de token, é exatamente espaço em
 * branco, comentário e o `#!` da primeira linha. Quebras de linha ficam, para as
 * linhas continuarem sendo as do arquivo. Nós de JSDoc são pulados: os "tokens"
 * deles moram dentro do comentário.
 *
 * O que este módulo NÃO faz: avaliar expressão. `"graph." + "facebook.com"` e
 * `` `graph.facebook.${"com"}` `` continuam passando — é o ponto cego declarado
 * nas duas catracas que o usam, e persegui-lo exigiria outra ferramenta.
 */
import ts from "typescript";

/**
 * O fonte com comentário trocado por espaço e o código intacto.
 *
 * `arquivo` só decide o dialeto (`tsx` aceita JSX, `mjs/js` não); o nome não é
 * lido do disco.
 */
export function semComentarios(fonte: string, arquivo = "trecho.tsx"): string {
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
