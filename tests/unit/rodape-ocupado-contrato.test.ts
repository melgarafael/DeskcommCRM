/**
 * A OCUPAÇÃO DO RODAPÉ É UM CONTRATO — E NÃO UM NÚMERO EM CADA ARQUIVO (#1305).
 *
 * ─── O defeito, visto por quem usa ──────────────────────────────────────────
 *
 * Numa chamada de voz, o painel de chamada cobre o canto inferior direito da
 * tela. No detalhe do follow-up quem está ali é o "Excluir nó", no rodapé do
 * painel de configuração: o clique não chega.
 *
 * ─── A causa, e por que ela é estrutural ────────────────────────────────────
 *
 * O número não estava errado: estava escrito em DOIS lugares. O painel se
 * posicionava com `bottom-4` (16px) em `ActiveCallPanel.tsx` e o `<main>` da
 * casca reservava `p-6` (24px) em `AppShell.tsx`. Enquanto as duas medidas
 * concordam ninguém vê nada; no dia em que discordaram — uma peça de 64px
 * dentro de uma faixa de 24px — o canto ficou coberto. É a mesma classe de
 * defeito da barra lateral (`tests/unit/barra-lateral-nao-flutua.test.ts`).
 *
 * ─── O que este arquivo prende ──────────────────────────────────────────────
 *
 * ESTRUTURA: as três partes do contrato continuam ligadas umas nas outras — a
 * casca desconta pelo contrato, a reserva sai da variável com o piso do `p-6`,
 * o provedor envolve a casca e as peças, e nenhuma peça volta a escrever a
 * posição do rodapé por conta própria.
 *
 * ─── O que este arquivo NÃO prova ───────────────────────────────────────────
 *
 * Geometria. Ele lê TEXTO, não caixas: quem prova que o botão sai de baixo do
 * painel é a medição de `getBoundingClientRect` na tela, que um teste de
 * unidade não alcança. O comportamento está em
 * `tests/unit/rodape-ocupado-durante-a-chamada.test.tsx`, e a prova visual fica
 * com quem mantém.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const CONTRATO = "lib/ui/rodape-ocupado.tsx";
const CASCA = "app/app/_components/AppShell.tsx";
const LAYOUT = "app/app/layout.tsx";

/**
 * Toda peça FIXA do rodapé do produto. Peça nova entra nesta lista — é ela que
 * mantém o número da peça rastreável até o arquivo que a desenha.
 */
const PECAS = ["components/voice/ActiveCallPanel.tsx"] as const;

/** O arquivo sem comentários: o que o código diz, não o que o comentário conta. */
function codigo(rel: string): string {
  return readFileSync(resolve(RAIZ, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("o contrato tem as três partes", () => {
  it("a casca desconta a ocupação PELO contrato, e não por conta própria", () => {
    const casca = codigo(CASCA);
    expect(casca).toMatch(/from "@\/lib\/ui\/rodape-ocupado"/);
    expect(casca).toMatch(/useOcupacaoDoRodape\(\)/);
    expect(casca).toMatch(/estiloDaReserva\(/);
  });

  it("a reserva sai de uma variável, com o `p-6` da casca como piso", () => {
    const contrato = codigo(CONTRATO);
    expect(contrato).toMatch(/VARIAVEL_DA_OCUPACAO = "--rodape-ocupado"/);
    expect(contrato).toMatch(/PISO_DO_RODAPE = 24/);
    // O valor que o navegador computa: nunca menos que o `p-6` que o `<main>` já
    // tem, e nunca menos que a peça declarou.
    expect(contrato).toMatch(
      /`max\(\$\{PISO_DO_RODAPE\}px, var\(\$\{VARIAVEL_DA_OCUPACAO\}, 0px\)\)`/,
    );
    // Sem peça registrada não há faixa: o rodapé de quem não está em chamada é
    // exatamente o de antes (é a razão pela qual a exceção do gate do Inbox não
    // vira uma faixa permanente em todas as telas).
    expect(contrato).toMatch(/if \(reserva <= 0\) return undefined/);
  });

  it("o provedor envolve a casca E o painel de chamada", () => {
    const layout = codigo(LAYOUT);
    const provedor = layout.indexOf("<ProvedorDaOcupacaoDoRodape>");
    const voz = layout.indexOf("<VoiceCallProvider>");
    expect(provedor, "o provedor não está montado no layout").toBeGreaterThan(-1);
    expect(voz).toBeGreaterThan(-1);
    // POR FORA do `VoiceCallProvider`: ele desenha o painel DEPOIS dos children,
    // então o painel é IRMÃO da casca. Provedor por dentro deixaria o painel de
    // fora — ele declararia o que ocupa e ninguém descontaria.
    expect(provedor).toBeLessThan(voz);
  });
});

describe("cada peça declara o que ocupa, no arquivo que a desenha", () => {
  it.each(PECAS)("%s", (peca) => {
    expect(existsSync(resolve(RAIZ, peca)), `${peca} não existe`).toBe(true);
    const fonte = codigo(peca);
    // O dono do número é o arquivo que desenha a peça.
    const proprio = peca.replace(/[/.]/g, (caractere) => `\\${caractere}`);
    expect(fonte, "a peça não declara o próprio arquivo como dono").toMatch(
      new RegExp(`dono: "${proprio}"`),
    );
    // E ela se REGISTRA de verdade: declarar sem registrar deixaria a casca
    // descontando zero, com o número certo escrito no lugar errado.
    expect(fonte).toMatch(/usePecaDoRodape\(/);
    // O número não volta a ser escrito aqui: nada de `bottom-4` numa classe
    // junto de `fixed`.
    const classes = [...fonte.matchAll(/className="([^"]*)"/g)].map((m) => m[1] ?? "");
    const posicaoPropria = classes.filter(
      (classe) => /\bfixed\b/.test(classe) && /(?:^|\s)bottom-\d/.test(classe),
    );
    expect(posicaoPropria, "a peça voltou a medir o rodapé por conta própria").toEqual([]);
  });
});
