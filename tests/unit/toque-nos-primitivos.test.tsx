/**
 * OS PRIMITIVOS QUE O APP INTEIRO USA ATENDEM O DEDO (ADR-0006, fase F4).
 *
 * É uma CATRACA de classe, não prova de geometria: o jsdom não computa CSS. Quem
 * mede o alvo de 44 px de verdade é `tests/e2e/celular-toque-nos-controles.spec.ts`
 * (`elementFromPoint` a 21 px do centro do interruptor, altura dos itens de menu,
 * a aba atingível perto da borda). Este arquivo segura, no `verify`, que a classe
 * que produz esse alvo não sai do primitivo num refactor — e cada primitivo aqui
 * alcança dezenas de telas de uma vez.
 *
 * As contas, para quem for mexer:
 *  - `Switch`: `h-5` com `border-2` dá caixa de padding de 16 px, e é nela que o
 *    `::before` absoluto se ancora. `-inset-3.5` soma 14 px de cada lado: 44 px.
 *    `-inset-3` daria 40. `pointer-coarse:my-3` põe 12 px em cima e embaixo:
 *    passo de 44 px entre interruptores empilhados, e as áreas encostam sem se
 *    sobrepor (sem a margem, numa pilha a cada 28 px, o de baixo ganha o toque).
 *  - itens de menu e de seleção: `py-1.5` em volta de `text-sm` dá 32 px;
 *    `pointer-coarse:min-h-11` leva a 44 só com ponteiro grosso.
 *  - `TabsList`: `h-9` com `overflow-x-auto` (que força `overflow-y` a rolar)
 *    corta a aba de 44 px abaixo de `lg`. `max-lg:h-auto` deixa a fila crescer
 *    com a aba; de `lg` para cima continua `h-9`. Não é `h-auto lg:h-9` porque
 *    quem já passa `h-auto` (Conexões, Inbox, cobrança) perderia o `h-auto` no
 *    computador: o `tailwind-merge` derruba o `h-auto` da base e deixa o `lg:h-9`.
 */
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

function classes(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/);
}

describe("primitivos com alvo de dedo", () => {
  it("o interruptor ganha uma área de 44 px só com ponteiro grosso", () => {
    render(<Switch aria-label="Ligar" />);
    const c = classes(screen.getByRole("switch", { name: "Ligar" }));
    expect(c).toEqual(
      expect.arrayContaining([
        "relative",
        "pointer-coarse:before:absolute",
        "pointer-coarse:before:-inset-3.5",
        "pointer-coarse:before:content-['']",
        // Passo de 44 px entre interruptores empilhados: sem a margem, o
        // `::before` do vizinho de baixo cobre a borda deste e ganha o toque.
        "pointer-coarse:my-3",
      ]),
    );
    // O desenho continua o mesmo: 20 px de altura.
    expect(c).toContain("h-5");
  });

  it("todo item de menu cresce para 44 px com o dedo", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>abrir</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Sair</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked>Marcado</DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="a">
            <DropdownMenuRadioItem value="a">Opção</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Mais</DropdownMenuSubTrigger>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const itens = [
      screen.getByRole("menuitem", { name: "Sair" }),
      screen.getByRole("menuitemcheckbox", { name: "Marcado" }),
      screen.getByRole("menuitemradio", { name: "Opção" }),
      screen.getByRole("menuitem", { name: "Mais" }),
    ];
    for (const item of itens) expect(classes(item), item.textContent ?? "").toContain("pointer-coarse:min-h-11");
  });

  it("a opção do seletor cresce para 44 px com o dedo", () => {
    render(
      <Select open value="a">
        <SelectTrigger aria-label="Fuso">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">São Paulo</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(classes(screen.getByRole("option", { name: "São Paulo" }))).toContain("pointer-coarse:min-h-11");
  });

  it("o diálogo de confirmação rola por dentro em vez de sair da tela", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Excluir?</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expect(classes(screen.getByRole("alertdialog"))).toEqual(
      expect.arrayContaining(["max-h-[calc(100dvh-2rem)]", "overflow-y-auto"]),
    );
  });

  it("a fila de abas cresce com a aba abaixo de lg e fica h-9 no computador", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Membros</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(classes(screen.getByRole("tablist"))).toEqual(expect.arrayContaining(["h-9", "max-lg:h-auto"]));
  });

  it("quem já passa h-auto continua h-auto também no computador", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="a">Membros</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const c = classes(screen.getByRole("tablist"));
    expect(c).toContain("h-auto");
    expect(c.filter((x) => /^lg:h-/.test(x))).toEqual([]);
  });
});
