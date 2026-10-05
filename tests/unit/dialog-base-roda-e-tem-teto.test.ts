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

const BASE = path.resolve(
  __dirname,
  "../../components/ui/dialog.tsx",
);
const cn = path.resolve(__dirname, "../../lib/utils.ts");

describe("DialogContent base tem teto de altura (#2044)", () => {
  const fonte = fs.readFileSync(BASE, "utf8");

  it("o className BASE limita a altura à janela (max-h de 100dvh − 2rem)", () => {
    expect(fonte).toMatch(/max-h-\[calc\(100dvh-2rem\)\]/);
  });

  it("deixa o conteúdo rolar por dentro quando não cabe (overflow-y-auto)", () => {
    expect(fonte).toMatch(/overflow-y-auto/);
  });

  it("o teto está na base compartilhada, e não num diálogo solto", () => {
    // A âncora é a assinatura exclusiva do DialogContent base
    // (`fixed left-[50%] top-[50%] z-50 grid`) — a MESMA linha carrega o teto.
    const i = fonte.indexOf("fixed left-[50%] top-[50%] z-50 grid");
    const linha = fonte.slice(i, i + 700);
    expect(linha).toMatch(/max-h-\[calc\(100dvh-2rem\)\]/);
    expect(linha).toMatch(/overflow-y-auto/);
  });

  it("mantém o botão de fechar (X) no componente base", () => {
    expect(fonte).toMatch(/DialogPrimitive\.Close/);
    expect(fonte).toMatch(/right-4 top-4/);
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