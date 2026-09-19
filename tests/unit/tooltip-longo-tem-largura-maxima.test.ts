/**
 * TOOLTIP COM FRASE LONGA PRECISA DE LARGURA MÁXIMA.
 *
 * O `TooltipContent` do projeto (`components/ui/tooltip.tsx`) precisa de teto de
 * largura, e o Radix desenha o balão com `minWidth: max-content`. Sem teto a
 * frase vira UMA linha: 267 caracteres deram ~1467px de texto, e o fim ("…a
 * exclusão fica travada enquanto esse histórico existir") sai da tela em 1280,
 * 1366 e 1440 px. Achado na triagem do #1215.
 *
 * São DUAS réguas, e a segunda existe porque a primeira não alcança tudo:
 *
 * 1. O texto LITERAL dentro do bloco, que dá para contar sem browser. Acima de
 *    80 caracteres, a tag de abertura tem de trazer `max-w-`.
 * 2. A CLASSE BASE, em `components/ui/tooltip.tsx`. Todo tooltip herda dela,
 *    então é ela que cobre o texto que NÃO está no código.
 *
 * ## Por que a régua 2 é necessária (e não zelo)
 *
 * Tooltip cujo conteúdo é uma EXPRESSÃO (`{message.error_message}`) pode ser tão
 * longo quanto o dado que chegar — e a régua 1 o conta como zero, porque não há
 * o que contar. É o caso de `components/inbox/MessageBubble.tsx`, que mostra o
 * erro do PROVEDOR de envio: `messages.error_message` é `text` sem teto no
 * `supabase/baseline.sql`, e o que o upstream mandar é o que aparece. Nenhuma
 * varredura de código mede isso; o que fecha a classe é o teto morar na base,
 * onde vale para os dois casos. Medir o texto dinâmico pela tela exigiria
 * browser — e o teto na base torna a medida desnecessária.
 *
 * `break-words` é afirmado junto porque é o par obrigatório do `max-w-` aqui:
 * a classe base traz `overflow-hidden`, então um erro de provedor sem espaço
 * (URL, hash) seria CORTADO em vez de quebrar a linha.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const PASTAS = ["app", "components"];
const LIMITE = 80;
const TOOLTIP_UI = "components/ui/tooltip.tsx";

function arquivos(dir: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(dir)) {
    if (nome === "node_modules" || nome === ".next") continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida.push(...arquivos(caminho));
    else if (/\.tsx$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

/** Cada `<TooltipContent …> … </TooltipContent>` do arquivo. */
function blocos(fonte: string): Array<{ abertura: string; corpo: string }> {
  const achados: Array<{ abertura: string; corpo: string }> = [];
  const re = /<TooltipContent([^>]*)>([\s\S]*?)<\/TooltipContent>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fonte)) !== null) achados.push({ abertura: m[1]!, corpo: m[2]! });
  return achados;
}

/**
 * O texto que o tooltip mostra SEM depender de dado: some com `{…}` (expressão)
 * e devolve o que sobra. `t("frase")` conta, porque a frase está no código.
 */
function textoLiteral(corpo: string): string {
  const deT = [...corpo.matchAll(/\bt\(\s*["'`]([^"'`]+)["'`]/g)].map((x) => x[1]!).join(" ");
  const fora = corpo.replace(/\{[\s\S]*?\}/g, " ").replace(/\s+/g, " ").trim();
  return `${deT} ${fora}`.trim();
}

/**
 * A classe base do `TooltipContent` — o que TODO tooltip do produto recebe,
 * com ou sem texto no código. Lê o `className={cn(…)}` de `tooltip.tsx`.
 */
function classeBase(): string {
  const fonte = readFileSync(join(RAIZ, TOOLTIP_UI), "utf-8").replace(/\/\/[^\n]*/g, " ");
  const bloco = fonte.match(/className=\{cn\(([\s\S]*?)\)\}/);
  if (!bloco) throw new Error(`não achei o className={cn(…)} em ${TOOLTIP_UI}`);
  return [...bloco[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!).join(" ");
}

const TOOLTIPS = arquivos(join(RAIZ, "app"))
  .concat(...PASTAS.slice(1).map((p) => arquivos(join(RAIZ, p))))
  .flatMap((caminho) =>
    blocos(readFileSync(caminho, "utf-8")).map((b) => ({
      arquivo: caminho.slice(RAIZ.length + 1),
      ...b,
      texto: textoLiteral(b.corpo),
    })),
  );

describe("tooltip com frase longa declara largura máxima", () => {
  it("a varredura acha tooltips (controle de vivacidade)", () => {
    // Sem isto, um caminho errado devolveria lista vazia e a regra abaixo
    // passaria sobre nada.
    expect(TOOLTIPS.length).toBeGreaterThanOrEqual(3);
  });

  it(`todo tooltip com mais de ${LIMITE} caracteres de texto literal tem max-w`, () => {
    const semLargura = TOOLTIPS.filter(
      (x) => x.texto.length > LIMITE && !/\bmax-w-/.test(x.abertura),
    ).map((x) => `${x.arquivo}: ${x.texto.length} caracteres`);
    expect(semLargura).toEqual([]);
  });

  it("a classe base do TooltipContent tem largura máxima (é o que cobre o texto de fora do código)", () => {
    const base = classeBase();
    // O teto na base é o único que alcança `{message.error_message}`: o texto
    // vem do provedor, não tem tamanho no código e não tem teto no banco.
    expect(base).toMatch(/\bmax-w-/);
    // Sem quebra de palavra, `overflow-hidden` corta o erro de provedor que não
    // tem espaço nenhum (URL, hash) em vez de quebrar a linha.
    expect(base).toMatch(/\bbreak-words\b/);
  });
});
