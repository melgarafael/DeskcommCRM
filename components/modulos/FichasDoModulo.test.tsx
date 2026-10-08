import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FichasDoModulo } from "./FichasDoModulo";

/**
 * O painel que mostra, na ficha do contato, o que um módulo de dados guarda sobre ele.
 *
 * O que estes casos protegem, e por que cada um existe:
 *
 * - **Rótulo do AUTOR, não slug.** O módulo declara `rotulo` e o nome de cada campo; a tela que
 *   mostrasse `dente` e `valor_cents` estaria mostrando o schema, não a informação.
 * - **Dinheiro em centavos é formatado.** O compilador guarda `<campo>_cents` + `<campo>_moeda`
 *   (a régua do projeto); jogar `12500` na tela é mostrar o banco por dentro.
 * - **Zero fichas é um estado de primeira classe**, com frase própria — não uma tabela vazia.
 * - **Falha do módulo não derruba a ficha do contato.** Não-negociável 1 da doutrina: nenhuma
 *   jornada do núcleo depende de extensão. Se a leitura falha, o painel diz isso e o resto da ficha
 *   continua de pé.
 */

const fetchFalso = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchFalso);
});
afterEach(cleanup);

const resposta = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

const CAMPOS = [
  { slug: "dente", tipo: "inteiro" as const },
  { slug: "condicao", tipo: "texto" as const },
  { slug: "valor", tipo: "dinheiro" as const },
];

function comFichas(fichas: Record<string, unknown>[]) {
  fetchFalso.mockReturnValue(
    resposta({ data: { rotulo: { "pt-BR": "Odontograma" }, campos: CAMPOS, fichas } }),
  );
}

describe("FichasDoModulo", () => {
  it("mostra o rótulo que o autor declarou, e os valores de cada ficha", async () => {
    comFichas([{ id: "f1", dente: 11, condicao: "restaurado", valor_cents: 12500, valor_moeda: "BRL" }]);

    render(<FichasDoModulo modulo="odontograma" objeto="marcacao" contatoId="c1" />);

    expect(await screen.findByText("Odontograma")).toBeTruthy();
    expect(screen.getByText("11")).toBeTruthy();
    expect(screen.getByText("restaurado")).toBeTruthy();
  });

  it("dinheiro aparece formatado, nunca o inteiro de centavos", async () => {
    comFichas([{ id: "f1", dente: 11, condicao: "restaurado", valor_cents: 12500, valor_moeda: "BRL" }]);

    render(<FichasDoModulo modulo="odontograma" objeto="marcacao" contatoId="c1" />);

    await waitFor(() => expect(screen.getByText(/125,00/)).toBeTruthy());
    expect(screen.queryByText("12500")).toBeNull();
  });

  /**
   * ⚠️ ESTE CASO MUDOU DE EXIGÊNCIA, e a razão é de produto.
   *
   * Ele pedia uma frase ("Nada guardado aqui ainda.") quando não há ficha. Mas o
   * módulo de dados é instalado por INSTALAÇÃO (ADR-0002 D3), não por empresa — e
   * `organization_extensions.enabled`, o liga/desliga por empresa das extensões
   * declarativas, não serve ao perfil `data`: o CHECK de `configuration` exige
   * `density`/`show_description`, e a instalação não cria linha nessa tabela.
   *
   * Consequência medida: numa instalação de revendedor, a barbearia que nunca
   * pediu o módulo odontológico via um cartão "Odontograma — Nada guardado aqui
   * ainda." em TODA ficha de contato. Isso não é só ruído: expõe a existência de
   * um módulo de outro cliente do mesmo servidor.
   *
   * Na onda 1 a rota é SÓ LEITURA, então painel vazio não oferece nada a ninguém —
   * nem um botão de adicionar. Portanto painel sem ficha não é desenhado. Quem usa
   * o módulo e tem dado continua vendo tudo; quem não usa deixa de ver o cartão.
   */
  it("sem nenhuma ficha, o painel NÃO é desenhado — nem título, nem frase, nem tabela", async () => {
    comFichas([]);

    const { container } = render(
      <FichasDoModulo modulo="odontograma" objeto="marcacao" contatoId="c1" />,
    );

    // Espera a leitura terminar antes de afirmar ausência: sem isto o teste
    // passaria só por estar medindo o estado de carregamento.
    await waitFor(() => expect(fetchFalso).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector("[data-carregando]")).toBeNull());

    expect(screen.queryByText(/nada guardado|nenhum registro/i)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Odontograma")).toBeNull();
  });

  it("quando a leitura falha, avisa e NÃO derruba a ficha do contato", async () => {
    fetchFalso.mockReturnValue(resposta({ error: { code: "upstream_unavailable" } }, 503));

    render(
      <div>
        <p>Resto da ficha</p>
        <FichasDoModulo modulo="odontograma" objeto="marcacao" contatoId="c1" />
      </div>,
    );

    expect(await screen.findByText(/não foi possível/i)).toBeTruthy();
    // O que importa: o conteúdo ao lado continua lá.
    expect(screen.getByText("Resto da ficha")).toBeTruthy();
  });

  it("o pedido leva o contato da ficha, e nunca pede a organização", async () => {
    comFichas([]);

    render(<FichasDoModulo modulo="odontograma" objeto="marcacao" contatoId="c-42" />);

    await waitFor(() => expect(fetchFalso).toHaveBeenCalled());
    const url = String(fetchFalso.mock.calls[0]![0]);
    expect(url).toContain("/api/v1/modulos/odontograma/marcacao");
    expect(url).toContain("contato=c-42");
    // A organização é da sessão. Se a tela a mandasse, a rota teria de escolher em quem confiar.
    expect(url).not.toContain("organization");
  });
});
