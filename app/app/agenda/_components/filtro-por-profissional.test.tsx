/**
 * O FILTRO POR PROFISSIONAL — issue #4186, fatia do filtro na tela que existe.
 *
 * A issue pede um "quadro por profissional" (linhas = pessoas, colunas =
 * horários). O quadro NÃO existe e esta fatia não o inventa: o que ela mede é a
 * régua que já está na tela — `components/agenda/FiltroDePessoas.tsx`, montado
 * no cabeçalho de `app/app/agenda/_client.tsx:704`.
 *
 * Três contratos, e cada um já custou algo neste repo:
 *
 *   1. "TODOS" É O PADRÃO. Um filtro que nasce isolando uma pessoa faz a
 *      agenda inteira parecer vazia para quem abriu a tela e não escolheu nada.
 *   2. A OPÇÃO NÃO EXISTE PARA QUEM NÃO PODE LER A LISTA. A régua é a da área —
 *      `PAPEL_MINIMO_DA_LISTA` (`lib/agenda/lista-de-pessoas.ts`), o piso de
 *      `GET /api/v1/agenda/pessoas`. Sem a lista, o componente não desenha
 *      filtro nenhum: a tela não decide permissão, ela só não oferece a escolha
 *      que a rota vai recusar.
 *   3. UM FILTRO DE UMA PESSOA SÓ É ENFEITE. Com a equipe de um, o componente
 *      devolve `null` — a mesma regra do alternador do inbox.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FiltroDePessoas } from "@/components/agenda/FiltroDePessoas";
import type { Pessoa } from "@/components/agenda/tipos";
import { PAPEL_MINIMO_DA_LISTA } from "@/lib/agenda/lista-de-pessoas";
import { ROLE_RANK } from "@/lib/auth/types";

vi.mock("@/hooks/i18n/useT", () => {
  const traduzir = (texto: string) => texto;
  return { useT: () => Object.assign(traduzir, { t: traduzir }) };
});

afterEach(cleanup);

const ANA: Pessoa = { id: "ana", nome: "Ana Prado", trilha: 1 };
const BRUNO: Pessoa = { id: "bruno", nome: "Bruno Lima", trilha: 2 };
const EQUIPE = [ANA, BRUNO];

describe("FiltroDePessoas — 'todos' é o padrão", () => {
  it("nasce em 'todos': nenhum botão pressionado e nenhum 'Todos' para voltar", () => {
    render(<FiltroDePessoas pessoas={EQUIPE} isolada={null} onIsolar={vi.fn()} />);

    expect(screen.getByTestId("filtro-de-pessoas").getAttribute("data-isolada")).toBe("todos");
    expect(screen.getByTestId("botao-pessoa-ana").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("botao-pessoa-bruno").getAttribute("aria-pressed")).toBe("false");
    // Só faz sentido oferecer "Todos" quando há alguém isolado.
    expect(screen.queryByTestId("botao-todos")).toBeNull();
  });

  it("clicar numa pessoa pede ISOLAR aquela pessoa", async () => {
    const onIsolar = vi.fn();
    render(<FiltroDePessoas pessoas={EQUIPE} isolada={null} onIsolar={onIsolar} />);

    await userEvent.click(screen.getByTestId("botao-pessoa-ana"));

    expect(onIsolar).toHaveBeenCalledWith("ana");
  });

  it("com uma pessoa isolada, ela aparece pressionada e 'Todos' volta à lista cheia", async () => {
    const onIsolar = vi.fn();
    render(<FiltroDePessoas pessoas={EQUIPE} isolada={ANA.id} onIsolar={onIsolar} />);

    expect(screen.getByTestId("filtro-de-pessoas").getAttribute("data-isolada")).toBe("ana");
    expect(screen.getByTestId("botao-pessoa-ana").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("botao-pessoa-bruno").getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(screen.getByTestId("botao-todos"));
    expect(onIsolar).toHaveBeenCalledWith(null);
  });

  it("clicar de novo na pessoa isolada também volta para 'todos'", async () => {
    const onIsolar = vi.fn();
    render(<FiltroDePessoas pessoas={EQUIPE} isolada={ANA.id} onIsolar={onIsolar} />);

    await userEvent.click(screen.getByTestId("botao-pessoa-ana"));
    expect(onIsolar).toHaveBeenCalledWith(null);
  });
});

describe("FiltroDePessoas — quando a opção NÃO deve existir", () => {
  it("lista vazia (o 403 de /api/v1/agenda/pessoas): nenhum filtro na tela", () => {
    render(<FiltroDePessoas pessoas={[]} isolada={null} onIsolar={vi.fn()} />);
    expect(screen.queryByTestId("filtro-de-pessoas")).toBeNull();
  });

  it("equipe de uma pessoa: filtrar não é escolher — o componente não desenha", () => {
    render(<FiltroDePessoas pessoas={[ANA]} isolada={null} onIsolar={vi.fn()} />);
    expect(screen.queryByTestId("filtro-de-pessoas")).toBeNull();
  });

  /**
   * A RÉGUA É A DA ÁREA, não uma nova.
   *
   * `GET /api/v1/agenda/pessoas` exige `PAPEL_MINIMO_DA_LISTA` via
   * `requireRole` (app/api/v1/agenda/pessoas/route.ts:44). Quem está abaixo
   * desse papel recebe 403, a lista chega vazia e o componente acima não
   * desenha nada. Este teste fixa a desigualdade que faz o encadeamento valer:
   * se alguém baixar o piso da ROTA abaixo de `agent` sem revisar a tela — ou
   * subir o piso do componente —, a conta quebra aqui e não em produção.
   */
  it("viewer está ABAIXO do piso da lista: o 403 é o que esconde a opção", () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK[PAPEL_MINIMO_DA_LISTA]);
    expect(PAPEL_MINIMO_DA_LISTA).toBe("agent");
  });
});
