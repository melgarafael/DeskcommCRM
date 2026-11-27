/**
 * Em Configurações › Conversões, a 375px, a barra de abas empurrava o painel para o
 * lado (#5224: `scrollWidth` 419 contra `clientWidth` 343). A `<nav>` não rolava nem
 * quebrava, e a quarta aba (Links rastreáveis / Enlaces rastreables) ficava fora.
 *
 * O jsdom não calcula layout, e a página é um componente de servidor que lê o banco,
 * então este teste prende as classes no fonte: a `<nav>` rola sozinha e as abas não
 * encolhem nem quebram. A medida em 375px, nos dois idiomas, está na descrição do PR.
 *
 * A aba ativa não leva `-mb-px`: com `overflow-x: auto` o navegador calcula `overflow-y`
 * como `auto`, e o 1px que ela passava da `<nav>` a deixava rolável na vertical
 * (`scrollHeight` 38 contra `clientHeight` 37) — barra vertical dentro da barra de abas
 * onde a barra de rolagem é clássica, e o sublinhado cortado em 1px.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fonte = readFileSync(join(process.cwd(), "app/app/settings/conversoes/page.tsx"), "utf8");

describe("Conversões — barra de abas a 375px", () => {
  it("a <nav> rola sozinha em vez de alargar o painel", () => {
    const classes = fonte.match(/<nav className="([^"]+)"[^>]*Seções de conversões/)?.[1];
    expect(classes).toBeDefined();
    expect(classes?.split(" ")).toContain("overflow-x-auto");
  });

  it("cada aba fica numa linha e não encolhe", () => {
    const abas = fonte.match(/aba === chave\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/);
    const variantes = [abas?.[1], abas?.[2]];
    for (const classes of variantes) {
      expect(classes).toBeDefined();
      expect(classes?.split(" ")).toEqual(
        expect.arrayContaining(["shrink-0", "whitespace-nowrap"]),
      );
    }
    expect(abas?.[1]?.split(" ")).not.toContain("-mb-px");
  });
});
