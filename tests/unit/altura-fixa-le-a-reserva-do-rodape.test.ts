/**
 * QUEM TEM ALTURA FIXA LÊ A RESERVA DO RODAPÉ — NÃO A CHUTA.
 *
 * O rodapé virou contrato (`lib/ui/rodape-ocupado.tsx`): a casca aplica
 * `padding-bottom: max(PISO, var(--rodape-ocupado))`, e o número cresce quando
 * uma peça fixa se registra. Uma tela que calcula a própria altura descontando
 * `var(--space-N)` está afirmando que o rodapé é FIXO — e ele não é mais.
 *
 * O preço de errar isso já foi pago duas vezes na mesma tela:
 *
 *   1. o `pb-20` escrito à mão na casca reservava o rodapé em TODA rota,
 *      inclusive no Inbox, onde o atalho que ele reservava nem monta. O grid
 *      descontava 48px, o `<main>` gastava 104px, e sobravam 56px de rolagem
 *      morta com o campo de envio abaixo da dobra.
 *   2. depois do contrato, o mesmo grid continuava descontando `2*var(--space-6)`
 *      — certo enquanto nenhuma peça se registra, e errado no instante em que
 *      uma aparece. Com o painel de chamada de voz aberto (16+64=80px), a
 *      reserva vira 80, o `<main>` gasta 104, e os mesmos 56px voltam.
 *
 * Este arquivo substitui `inbox-flutuante-nao-cobre-a-acao.test.ts`, que cobrava
 * a CONTA daquele momento (`reserva >= ocupação`, lendo um `pb-N` literal). A
 * conta morreu junto com o `pb-N`; a propriedade é que sobrevive — e ela pega a
 * PRÓXIMA tela de altura fixa, não só esta.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = resolve(__dirname, "../..");
const PASTAS = ["app", "components"];

/** A marca de quem conta com o rodapé da casca: descontar altura em `var(--space-N)`. */
const CONTA_COM_O_RODAPE = /var\(--space-\d+\)/;
const LE_O_CONTRATO = /--rodape-ocupado/;

function arquivos(dir: string): string[] {
  const achados: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) achados.push(...arquivos(caminho));
    else if (/\.tsx?$/.test(entrada)) achados.push(caminho);
  }
  return achados;
}

/** Cada `calc(100dvh…)` do repo, com o arquivo e a expressão inteira. */
function alturasDeTelaCheia(): { arquivo: string; expressao: string }[] {
  const achados: { arquivo: string; expressao: string }[] = [];
  for (const pasta of PASTAS) {
    for (const caminho of arquivos(resolve(RAIZ, pasta))) {
      const fonte = readFileSync(caminho, "utf8");
      // Regex não fecha parêntese aninhado: `max(var(a),var(b))` tem três
      // níveis, e um `[^)]*` trunca a expressão no primeiro `)`. Truncada, ela
      // perde justamente o `--rodape-ocupado` do fim e o teste acusa quem está
      // CERTO. Conta-se parêntese.
      for (const inicio of [...fonte.matchAll(/calc\(100dvh/g)].map((m) => m.index!)) {
        let profundidade = 0;
        let fim = inicio;
        for (let i = inicio + "calc".length; i < fonte.length; i++) {
          if (fonte[i] === "(") profundidade++;
          else if (fonte[i] === ")" && --profundidade === 0) {
            fim = i + 1;
            break;
          }
        }
        expect(fim, `calc( sem fechamento em ${relative(RAIZ, caminho)}`).toBeGreaterThan(inicio);
        achados.push({ arquivo: relative(RAIZ, caminho), expressao: fonte.slice(inicio, fim) });
      }
    }
  }
  return achados;
}

describe("altura de tela cheia e a reserva do rodapé", () => {
  it("a varredura acha alguma coisa — senão ela não está medindo nada", () => {
    // Uma sonda que deixou de casar devolve lista vazia, e lista vazia passa em
    // todo `every`. Este caso é o controle positivo do arquivo inteiro.
    expect(alturasDeTelaCheia().length).toBeGreaterThan(0);
  });

  it("quem desconta `var(--space-N)` também lê `--rodape-ocupado`", () => {
    const culpados = alturasDeTelaCheia().filter(
      ({ expressao }) => CONTA_COM_O_RODAPE.test(expressao) && !LE_O_CONTRATO.test(expressao),
    );
    expect(
      culpados,
      "esta expressão desconta o padding da casca como se ele fosse fixo, e ele não é " +
        "desde que o rodapé virou contrato. Espelhe o que a casca aplica — " +
        "`max(var(--space-N), var(--rodape-ocupado, 0px))` na parte de baixo — " +
        "em vez de multiplicar o espaçamento por dois:\n" +
        culpados.map((c) => `  ${c.arquivo}: ${c.expressao}`).join("\n"),
    ).toEqual([]);
  });
});
