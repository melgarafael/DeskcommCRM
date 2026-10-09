import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * JANELAS (Dialog) — teto de altura no componente BASE (#2044).
 *
 * ## O defeito
 *
 * `DialogContent` base (`components/ui/dialog.tsx`) centraliza o diálogo com
 * `fixed top-[50%] translate-y-[-50%]` sem `max-height` nem `overflow`. Quando o
 * conteúdo passa da altura da janela, o topo e o rodapé ficam fora da tela e não
 * há rolagem — o único jeito é diminuir o zoom (reproduzido com `CustomFieldsEditor`
 * em 1366×768: os botões Salvar/Cancelar ficam abaixo da borda).
 *
 * ## O conserto
 *
 * `max-h-[calc(100dvh-2rem)] overflow-y-auto` no className BASE do
 * `DialogContent`. O `cn()` usa `twMerge`, então um diálogo que JÁ passa um
 * `max-h` próprio (ex.: `max-h-[85vh]`, `max-h-[90dvh]`) continua com o dele
 * prevalecendo. Um único ponto conserta os ~27 diálogos que usam o padrão.
 *
 * Como a correção é um par de classes Tailwind no componente base, este teste
 * lê o fonte e pinaria a propriedade — o mesmo padrão de outros testes de
 * superfície deste repo. A sabotagem (remover as classes da base) deixa os
 * casos abaixo VERMELHOS.
 */

const BASE = path.resolve(__dirname, "../../components/ui/dialog.tsx");
const cn = path.resolve(__dirname, "../../lib/utils.ts");

describe("DialogContent base tem teto de altura (#2044)", () => {
  const fonte = fs.readFileSync(BASE, "utf8");

  it("o className BASE limita a altura à janela (max-h de 100dvh − 2rem)", () => {
    expect(fonte).toMatch(/max-h-\[calc\(100dvh-2rem\)\]/);
  });

  it("deixa o conteúdo rolar por dentro quando não cabe (overflow-y-auto)", () => {
    expect(fonte).toMatch(/overflow-y-auto/);
  });

  /**
   * A ÂNCORA É UM CONJUNTO DE CLASSES, E NÃO UMA SEQUÊNCIA DELAS.
   *
   * A versão anterior procurava a string literal
   * `"fixed left-[50%] top-[50%] z-50 grid"` e lia os 700 caracteres seguintes.
   * Isso amarrava o gate à ORDEM das classes — e a ordem das classes neste
   * repositório é decidida pelo `prettier-plugin-tailwindcss`, que está
   * configurado no `.prettierrc` e tem toda a autorização para reordenar.
   *
   * Medido: `components/ui/dialog.tsx` **nunca esteve formatado** (o arquivo do
   * HEAD reprova `prettier --check`), e no instante em que alguém roda
   * `pnpm format` o plugin troca `left-[50%] top-[50%]` por
   * `top-[50%] left-[50%]`. A âncora deixa de casar, `indexOf` devolve -1, o
   * `slice(-1, 699)` devolve string VAZIA — e o gate reprova dizendo que o teto
   * de altura sumiu, quando ele está exatamente onde deveria.
   *
   * O defeito que este arquivo existe para pegar (#2044) é "o teto não está na
   * base compartilhada". Isso é uma pergunta sobre QUAIS classes convivem na
   * mesma string, nunca sobre em que ordem elas aparecem. Perguntar pelo
   * conjunto mede a mesma coisa e para de reprovar formatação.
   */
  /** Toda string literal entre aspas duplas do arquivo. */
  const literais = [...fonte.matchAll(/"([^"\n]*)"/g)].map((m) => m[1] ?? "");

  /** A string de classes que carrega TODAS as marcas da base do DialogContent. */
  const ASSINATURA_DA_BASE = ["fixed", "left-[50%]", "top-[50%]", "z-50", "grid"];
  const base = literais.find((literal) => {
    const classes = new Set(literal.split(/\s+/));
    return ASSINATURA_DA_BASE.every((c) => classes.has(c));
  });

  it("o teto está na base compartilhada, e não num diálogo solto", () => {
    // Guarda de vacuidade: sem achar a base, os dois `expect` abaixo passariam
    // num `undefined` e o gate ficaria verde medindo nada.
    expect(base, `nenhuma string reúne ${ASSINATURA_DA_BASE.join(" + ")}`).toBeTruthy();
    const classes = new Set((base ?? "").split(/\s+/));
    expect(classes).toContain("max-h-[calc(100dvh-2rem)]");
    expect(classes).toContain("overflow-y-auto");
  });

  it("mantém o botão de fechar (X) no componente base", () => {
    expect(fonte).toMatch(/DialogPrimitive\.Close/);
    // `right-4` e `top-4` no MESMO className, em qualquer ordem — pelo mesmo
    // motivo do caso acima: o prettier reordena, e `top-4 right-4` posiciona o
    // X exatamente onde `right-4 top-4` posicionava.
    const fechar = literais.find((literal) => {
      const classes = new Set(literal.split(/\s+/));
      return classes.has("absolute") && classes.has("right-4") && classes.has("top-4");
    });
    expect(fechar, "o X do diálogo base perdeu a âncora no canto").toBeTruthy();
  });
});

describe("o override por diálogo continua valendo (twMerge)", () => {
  it("`cn` mescla com tailwind-merge — classe do caller prevalece", () => {
    const codigoCn = fs.readFileSync(cn, "utf8");
    expect(codigoCn).toMatch(/twMerge/);
  });

  it("o repo ainda tem diálogos com max-h próprio (overrides vivos)", () => {
    // Exemplos citados na issue (#2044). Sanidade: o override continua vivo,
    // então o twMerge do `cn` é o que garante que eles não brigam com a base.
    const componentes = path.resolve(__dirname, "../../components");
    const saida: string = execSync(
      `grep -rlE "max-h-\\[8[5-9]dvh\\]|max-h-\\[9[0-9]dvh\\]" ${componentes} --include="*.tsx" || true`,
      { encoding: "utf8" },
    );
    expect(saida.trim()).not.toBe("");
    expect(saida.trim().split("\n").length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * A ANIMAÇÃO NÃO PODE DECIDIR A POSIÇÃO DE QUEM ANCORA DIFERENTE.
 *
 * `ds-modal` roda com `animation-fill-mode: both`, e o valor FINAL de um
 * keyframe continua valendo depois que a animação termina. Enquanto
 * `ds-modal-entra` terminava num `-50% -50%` cravado, esse valor vencia o
 * `translate-y-0` de qualquer diálogo que escolhesse outro ancoramento — e o
 * Tailwind não tem como ganhar dessa disputa.
 *
 * Aconteceu com a paleta de comandos (⌘K): ela abria em `top-[10%]`, a animação
 * a puxava meia altura para cima do próprio ponto, e ela saía cortada no topo da
 * tela. O defeito não existia antes de as classes de animação passarem a gerar
 * CSS de verdade — era uma armadilha carregada, não um erro visível.
 *
 * O conserto foi parametrizar o deslocamento. Esta cerca prova que ele continua
 * parametrizado: um keyframe que volte a cravar o número reprova aqui, antes de
 * alguém descobrir pela tela.
 */
describe("a animação de modal respeita quem ancora diferente", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");

  function corpoDoKeyframe(nome: string): string {
    const i = css.indexOf(`@keyframes ${nome}`);
    expect(i, `keyframe ${nome} sumiu`).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf("}\n", css.indexOf("}", css.indexOf("to {", i))) + 1);
  }

  for (const nome of ["ds-modal-entra", "ds-modal-sai"]) {
    it(`${nome} lê o deslocamento de variável, e não de número cravado`, () => {
      const corpo = corpoDoKeyframe(nome);
      expect(
        corpo,
        `${nome} precisa ler --ds-modal-y: sem isso ele sobrescreve o ancoramento de quem abre fora do centro`,
      ).toMatch(/var\(--ds-modal-y/);
      expect(corpo).toMatch(/var\(--ds-modal-x/);
      // O número cravado é exatamente o que causou o defeito da paleta.
      expect(
        /translate:\s*-50%\s+-50%/.test(corpo),
        `${nome} voltou a cravar "-50% -50%" — isso vence o translate de quem ancora diferente`,
      ).toBe(false);
    });
  }

  it("o padrão da variável mantém o diálogo comum centralizado", () => {
    // Quem NÃO declara a variável continua recebendo -50%: a correção não pode
    // ter custado a centralização de todos os outros diálogos do produto.
    expect(corpoDoKeyframe("ds-modal-entra")).toMatch(/var\(--ds-modal-y,\s*-50%\)/);
  });
});

