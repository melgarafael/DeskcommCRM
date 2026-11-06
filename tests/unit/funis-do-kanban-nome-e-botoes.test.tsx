/**
 * O NOME DO FUNIL NÃO PODE SUMIR SOB OS SELOS — NEM OS BOTÕES VAZAR DO CARTÃO.
 *
 * ─── O defeito (issue #3127, medido na main) ────────────────────────────────
 *
 * Na tela Funis (`/app/kanban`), a linha do funil era
 * `flex flex-col gap-3 sm:flex-row sm:items-center` (`app/app/kanban/_client.tsx`).
 * O grupo de ações tinha `shrink-0`: exigia, numa linha só, a largura de todos
 * os botões (Renomear · Tornar padrão · Funil de clientes · Arquivar ≈ 419px de
 * um cartão de ~556px). Como `shrink-0` proíbe encolher, era a coluna do nome
 * (`min-w-0 flex-1`) que encolhia — até 0. O nome caía POR BAIXO dos selos
 * "Padrão"/"Clientes" e do slug, e os botões passavam da borda direita do
 * cartão. Com janela chega (≥ ~1100px) o layout cabe e o defeito não aparece:
 * reproduza estreitando a área para ~900px.
 *
 * ─── O que este arquivo afirma, e por quê ───────────────────────────────────
 *
 * ⚠️ O jsdom NÃO calcula layout: ele não sabe o que "por baixo" significa, nem
 * se um botão passou da borda — não há geometria para medir aqui. O que este
 * teste pode (e deve) prender é a ESTRUTURA e as CLASSES que a correção
 * introduz, e é isso que ele faz. A prova de que o CSS resolve em ~900px está
 * na MEDIÇÃO no navegador, no PR — não nesta suíte. O que se afirma aqui é o
 * contrato mínimo que, se revertido, faz o defeito voltar:
 *
 *   1. a linha do funil pode QUEBRAR em `sm` (`sm:flex-wrap`) — sem isso os
 *      botões nunca descem, empurram a linha e a coluna do nome colapsa;
 *   2. a coluna do nome NÃO tem `min-w-*` nenhum: o piso dela é o próprio
 *      conteúdo (min-width automático = palavra mais longa + selos). `min-w-0`
 *      deixava o nome ir a 0 sob os selos; um piso fixo (`min-w-40`, 160px)
 *      deixava uma faixa de larguras em que os selos cruzavam o slug, porque
 *      «Padrão» + «Clientes» com os espaços já ocupam ~139px dos 160;
 *   3. o grupo de ações NÃO tem `shrink-0` (a causa) e mantém `flex-wrap` —
 *      pode encolher e quebrar por dentro;
 *   4. o nome, os selos e os QUATRO botões existem, e os botões estão DENTRO
 *      do cartão (o `<li>`) e do MESMO grupo, depois da coluna do nome.
 *
 * Cada metade destas asserções cai com a sabotagem correspondente (ver o PR):
 * devolver `shrink-0` derruba o item 3; tirar `sm:flex-wrap` derruba o 1;
 * voltar a coluna do nome para `min-w-0` (ou para `min-w-40`) derruba o 2.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FunisClient, type FunilDaLista } from "@/app/app/kanban/_client";

/** A regra "Clientes pela agenda" LIGADA: sem ela o selo/botão de clientes some. */
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({
    orgId: "org-1",
    name: "Clínica",
    role: "admin",
    cliente_pela_agenda: true,
  }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/pipelines/usePipelines", () => ({
  useCriarFunil: () => ({ isPending: false, mutate: vi.fn() }),
  useEditarFunil: () => ({ isPending: false, mutate: vi.fn() }),
  useArquivarFunil: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/app/app/kanban/_components/ImportarLeads", () => ({ ImportarLeads: () => null }));

/**
 * DOIS funis, de propósito:
 * - `f-padrao` é o padrão E o funil de clientes → ganha os DOIS selos, e como é
 *   padrão NÃO oferece "Tornar padrão" (três botões);
 * - `f-simples` não é nem um nem outro → é ele que oferece os QUATRO botões de
 *   ação numa linha só (é o caso que mede a largura do grupo).
 * Um funil só não daria as duas coisas ao mesmo tempo — padrao e clientes
 * marcados TIRAM um botão.
 */
const PADRAO: FunilDaLista = {
  id: "f-padrao",
  name: "Pedidos",
  slug: "pedidos",
  description: null,
  position: 1,
  is_default: true,
  is_client_pipeline: true,
};
const SIMPLES: FunilDaLista = {
  id: "f-simples",
  name: "Comercial",
  slug: "comercial",
  description: "Entrada do time comercial",
  position: 2,
  is_default: false,
  is_client_pipeline: false,
};

function comQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

afterEach(cleanup);

function abrir(podeGerenciar = true) {
  return render(
    comQuery(
      <FunisClient
        funis={[PADRAO, SIMPLES]}
        arquivados={[]}
        podeGerenciar={podeGerenciar}
        podeImportar
      />,
    ),
  );
}

/** As classes como TOKENS — "shrink-0" não pode casar por substring de engano. */
const classes = (el: Element) => el.className.split(/\s+/).filter(Boolean);

/** O `<li>` — o CARTÃO do funil. */
const cartao = (id: string) => screen.getByTestId(`funil-${id}`);

/**
 * A LINHA do funil: `Link` do nome → coluna do nome → linha.
 * (`_client.tsx`: `<div linha><div nome><Link data-testid="abrir-…">`.)
 */
const linha = (id: string) =>
  screen.getByTestId(`abrir-${id}`).parentElement!.parentElement!;

/** A COLUNA do nome: o pai do `Link` do nome. */
const colunaDoNome = (id: string) => screen.getByTestId(`abrir-${id}`).parentElement!;

/** O GRUPO de ações: o pai do botão "Renomear" do funil. */
const grupoDeAcoes = (id: string) => screen.getByTestId(`renomear-${id}`).parentElement!;

const BOTOES_DE_ACAO = ["renomear", "padrao", "clientes", "arquivar"] as const;

describe("linha do funil — o nome não some e os botões não vazam (#3127)", () => {
  it("com ~900px (a classe está lá), a linha do funil PODE quebrar", () => {
    abrir();
    // ⚠️ A classe, e não a medida: o jsdom não tem geometria. Em ~900px é esta
    // permissão de quebrar que faz o grupo de ações descer em vez de empurrar a
    // coluna do nome a 0. Não há breakpoint novo — a linha quebra em qualquer
    // largura onde não couber, e em janela cheia segue ao lado, como antes.
    for (const id of [PADRAO.id, SIMPLES.id]) {
      expect(classes(linha(id))).toContain("sm:flex-wrap");
      // O empilhado do celular continua: `flex-col` na base, `sm:flex-row` acima.
      expect(classes(linha(id))).toContain("sm:flex-row");
    }
  });

  it("o piso da coluna do nome é o CONTEÚDO — nenhum `min-w-*` o substitui", () => {
    abrir();
    for (const id of [PADRAO.id, SIMPLES.id]) {
      const coluna = classes(colunaDoNome(id));
      // Nenhuma largura mínima explícita: nem o `min-w-0` que CAUSAVA o
      // colapso, nem um piso fixo como `min-w-40`, menor que nome + selos.
      // Sem override, o min-width volta a ser automático (o conteúdo).
      expect(coluna.filter((c) => /(^|:)min-w-/.test(c)), `coluna do nome do ${id}`).toEqual([]);
      // A coluna ainda cresce para ocupar o que sobra.
      expect(coluna).toContain("flex-1");
    }
  });

  it("⭐ o grupo de ações NÃO tem `shrink-0` (a causa) e pode encolher/quebrar", () => {
    abrir();
    // Esta é a asserção que a sabotagem derruba: devolver `shrink-0` ao grupo
    // refaz o defeito. `shrink-0` exige a largura de todos os botões numa linha
    // só e é a coluna do nome que encolhe — por isso ele não pode estar aqui.
    for (const id of [PADRAO.id, SIMPLES.id]) {
      const grupo = classes(grupoDeAcoes(id));
      expect(grupo, `grupo de ações do ${id}`).not.toContain("shrink-0");
      // Segue podendo quebrar por dentro (vários botões → várias linhas).
      expect(grupo).toContain("flex-wrap");
      // E pode encolher abaixo do conteúdo (`min-w-0`), que o `shrink-0` proibia.
      expect(grupo).toContain("min-w-0");
    }
  });

  it("nome e selos aparecem INTEIROS, dentro da coluna do nome", () => {
    abrir();

    // (a) o nome está no documento...
    expect(screen.getByText("Pedidos")).toBeTruthy();
    expect(screen.getByText("Comercial")).toBeTruthy();
    // ...dentro da COLUNA do nome (o `Link`), que é quem ganhou o piso.
    expect(colunaDoNome(PADRAO.id)).toContainElement(screen.getByText("Pedidos"));

    // Os dois selos, no funil que é padrão E de clientes — inteiros no documento
    // (o jsdom não mede se estão sobrepostos; mede-se no navegador).
    const linhaPadrao = colunaDoNome(PADRAO.id);
    expect(linhaPadrao).toHaveTextContent("Padrão");
    expect(linhaPadrao).toHaveTextContent("Clientes");
  });

  it("os QUATRO botões de ação existem e estão DENTRO do cartão, no mesmo grupo", () => {
    abrir();

    // O funil não-padrão oferece os quatro (o outro, por ser padrão, três).
    for (const acao of BOTOES_DE_ACAO) {
      const botao = screen.getByTestId(`${acao}-${SIMPLES.id}`);
      // Dentro do CARTÃO (o `<li>`): nada vaza para fora dele.
      expect(cartao(SIMPLES.id)).toContainElement(botao);
      // E dentro do MESMO grupo de ações — o que quebra junto quando não cabe.
      expect(grupoDeAcoes(SIMPLES.id)).toContainElement(botao);
    }
    // O padrão não oferece "Tornar padrão" — as quatro ações do outro continuam.
    expect(screen.queryByTestId(`padrao-${PADRAO.id}`)).toBeNull();
    for (const acao of ["renomear", "clientes", "arquivar"] as const) {
      expect(grupoDeAcoes(PADRAO.id)).toContainElement(screen.getByTestId(`${acao}-${PADRAO.id}`));
    }
  });

  it("a ordem é nome → slug → ações: o grupo fica à direita, quebra para baixo", () => {
    abrir();
    const filhos = Array.from(linha(SIMPLES.id).children);
    const nome = colunaDoNome(SIMPLES.id);
    const grupo = grupoDeAcoes(SIMPLES.id);
    // A coluna do nome vem ANTES do grupo de ações no DOM — é o que faz o grupo
    // ser o ÚLTIMO item da linha e, ao quebrar, descer em vez de cobrir o nome.
    expect(filhos.indexOf(nome)).toBeLessThan(filhos.indexOf(grupo));
    // O slug fica entre os dois.
    const slug = filhos.find((f) => f.textContent?.startsWith("/comercial"));
    expect(slug).toBeTruthy();
    expect(filhos.indexOf(nome)).toBeLessThan(filhos.indexOf(slug!));
    expect(filhos.indexOf(slug!)).toBeLessThan(filhos.indexOf(grupo));
  });

  it("CONTROLE: sem permissão de gerenciar não há botão nenhum para vazar", () => {
    // Sem este controle, "os botões estão dentro do cartão" passaria também com
    // uma tela que não desenha botão algum — o teste estaria medindo o nada.
    abrir(false);
    for (const acao of BOTOES_DE_ACAO) {
      expect(screen.queryByTestId(`${acao}-${SIMPLES.id}`)).toBeNull();
    }
    // O nome continua lá: a lista é leitura aberta, a escrita é manager+.
    expect(screen.getByText("Comercial")).toBeTruthy();
  });
});
