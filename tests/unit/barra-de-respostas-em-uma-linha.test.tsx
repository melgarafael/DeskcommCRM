/**
 * A BARRA DE RESPOSTAS RÁPIDAS EM UMA LINHA, COM OS GRUPOS EM POPUP (#3875).
 *
 * O defeito medido na issue: a barra do Inbox empilha. Ela é `flex-wrap`, então
 * cada resposta rápida a mais vira MAIS UMA LINHA acima do campo de digitação —
 * numa agência com dezenas de respostas e três grupos, a seção come várias linhas
 * e come a altura da conversa. E os grupos não são "atalhos": são um cabeçalho
 * seguido de TODOS os botões do grupo, despejados na mesma área vertical.
 *
 * O contrato que este arquivo prende:
 *
 *   ESTÁTICO   uma linha só (`flex-nowrap` + rolagem lateral), itens que não
 *              encolhem (`shrink-0`) e nenhum teto de largura — em tela grande
 *              não há carrossel apertado, há a barra inteira cabendo.
 *   GRUPO      gatilho de popup (`aria-haspopup="dialog"`), com as respostas do
 *              grupo SÓ dentro do painel — a barra não as despeja.
 *   TECLADO    abre com Enter, `Escape` fecha, o foco volta para o gatilho.
 *   LADO OP.   resposta sem grupo continua a UM clique; grupo vazio não vira
 *              gatilho nenhum (popup vazio é popup quebrado).
 *
 * jsdom NÃO mede layout: aqui não há pixel, só estrutura e classe — a altura em
 * pixel é medida em navegador de verdade (Chromium desta VPS) e está no corpo do
 * PR, com os números antes/depois e o método declarado.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BarraDeRecursos } from "@/components/inbox/composer/BarraDeRecursos";
import type { Recurso } from "@/lib/inbox/recursos";
import type { GrupoDeRespostas } from "@/lib/templates/grupos";

const GRUPOS: GrupoDeRespostas[] = [
  { id: "g-abordagem", name: "Abordagem", ordem: 1000 },
  { id: "g-fechamento", name: "Fechamento", ordem: 2000 },
  // Existe no cadastro e não tem resposta: a barra não pode oferecê-lo.
  { id: "g-vazio", name: "Grupo sem resposta", ordem: 3000 },
];

const RECURSOS = [
  { id: "r1", title: "Boas-vindas", body: "Olá! Seja bem-vindo.", grupo_id: "g-abordagem" },
  { id: "r2", title: "Horário", body: "Atendemos das 8h às 18h.", grupo_id: "g-abordagem" },
  { id: "r3", title: "Pós-venda", body: "Qualquer coisa, estamos aqui.", grupo_id: "g-fechamento" },
  // Sem grupo: o caso que precisa continuar a UM clique.
  { id: "r4", title: "Resposta avulsa", body: "Só um instante.", grupo_id: null },
] as unknown as Recurso[];

function barra(grupos: GrupoDeRespostas[] | null = GRUPOS) {
  const escolher = vi.fn();
  const utils = render(
    <BarraDeRecursos
      recursos={RECURSOS}
      grupos={grupos}
      onEscolher={escolher}
      storage={null}
    />,
  );
  return { ...utils, escolher };
}

const elementoDaBarra = () => screen.getByTestId("barra-de-recursos");

function classes(elemento: Element): string[] {
  return elemento.className.split(/\s+/).filter(Boolean);
}

describe("#3875 — a barra é UMA linha, com rolagem lateral", () => {
  it("não quebra linha: `flex-nowrap` + rolagem horizontal, e nada de `flex-wrap`", () => {
    barra();
    const lista = classes(elementoDaBarra());
    expect(lista).toContain("flex-nowrap");
    expect(lista).toContain("overflow-x-auto");
    expect(lista).not.toContain("flex-wrap");
  });

  it("os itens não encolhem (é o que dá rolagem em vez de pílula espremida)", () => {
    barra();
    const alvos = [
      ...elementoDaBarra().querySelectorAll("button"),
    ];
    expect(alvos.length).toBeGreaterThan(0);
    for (const alvo of alvos) expect(classes(alvo)).toContain("shrink-0");
  });

  it("em tela grande não há carrossel apertado: nenhum teto de largura na barra", () => {
    barra();
    const lista = classes(elementoDaBarra());
    // `max-w-*`/`w-*` fixos transformariam a barra num carrossel de 320px mesmo
    // com 1280px de compositor. A barra ocupa a largura que o compositor dá.
    expect(lista.some((classe) => /^(max-)?w-(\[|screen|\d)/.test(classe))).toBe(false);
    expect(lista).toContain("w-full");
  });
});

describe("#3875 — grupo é gatilho de popup, não despejo de botões", () => {
  it("o título do grupo é um botão que anuncia popup", () => {
    barra();
    const gatilho = within(elementoDaBarra()).getByRole("button", { name: "Abordagem" });
    expect(gatilho).toHaveAttribute("aria-haspopup", "dialog");
    expect(gatilho).toHaveAttribute("aria-expanded", "false");
  });

  it("as respostas do grupo NÃO aparecem na barra fechada — só dentro do painel", async () => {
    const user = userEvent.setup();
    barra();
    expect(within(elementoDaBarra()).queryByRole("button", { name: "Boas-vindas" })).toBeNull();
    await user.click(within(elementoDaBarra()).getByRole("button", { name: "Abordagem" }));
    const painel = await screen.findByRole("dialog");
    expect(within(painel).getByRole("button", { name: "Boas-vindas" })).toBeVisible();
    expect(within(painel).getByRole("button", { name: "Horário" })).toBeVisible();
    // E o grupo vizinho não vaza para o painel deste.
    expect(within(painel).queryByRole("button", { name: "Pós-venda" })).toBeNull();
  });

  it("escolher dentro do painel entrega o recurso e FECHA o popup", async () => {
    const user = userEvent.setup();
    const { escolher } = barra();
    await user.click(within(elementoDaBarra()).getByRole("button", { name: "Abordagem" }));
    const painel = await screen.findByRole("dialog");
    await user.click(within(painel).getByRole("button", { name: "Horário" }));
    expect(escolher).toHaveBeenCalledTimes(1);
    expect((escolher.mock.calls[0]![0] as Recurso).id).toBe("r2");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("teclado: Enter abre, `Escape` fecha e o foco volta para o gatilho", async () => {
    const user = userEvent.setup();
    barra();
    const gatilho = within(elementoDaBarra()).getByRole("button", { name: "Fechamento" });
    gatilho.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeVisible();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // O foco não pode ficar perdido no corpo da página: quem fechou por teclado
    // continua na barra, pronto para o próximo grupo.
    await waitFor(() => expect(document.activeElement).toBe(gatilho));
  });

  it("grupo VAZIO não vira gatilho (popup vazio é popup quebrado)", () => {
    barra();
    expect(
      within(elementoDaBarra()).queryByRole("button", { name: "Grupo sem resposta" }),
    ).toBeNull();
  });
});

describe("#3875 — o que não podia piorar", () => {
  it("resposta sem grupo continua a UM clique, sem popup no caminho", async () => {
    const user = userEvent.setup();
    const { escolher } = barra();
    await user.click(within(elementoDaBarra()).getByRole("button", { name: "Resposta avulsa" }));
    expect(escolher).toHaveBeenCalledTimes(1);
    expect((escolher.mock.calls[0]![0] as Recurso).id).toBe("r4");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sem grupo nenhum, a barra é a plana de sempre — nenhum gatilho", () => {
    barra([]);
    const barraEl = elementoDaBarra();
    expect(within(barraEl).queryByRole("button", { name: "Abordagem" })).toBeNull();
    // As quatro respostas, uma por botão, na ordem do servidor.
    expect(
      [...barraEl.querySelectorAll("[data-recurso-id]")].map((b) => b.getAttribute("data-recurso-id")),
    ).toEqual(["r1", "r2", "r3", "r4"]);
  });
});
