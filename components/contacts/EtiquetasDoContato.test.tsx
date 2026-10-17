/**
 * O autocompletar de etiquetas da ficha do contato (issue #2732).
 *
 * Prova os três critérios da entrega, cada um por um caso:
 *
 *   1. digitar oferece as etiquetas JÁ usadas na organização e as
 *      `canonical_tags` do funil — as duas fontes;
 *   2. gravar reusa a etiqueta EXISTENTE (caixa/acento ignorados na comparação),
 *      nunca cria uma variante de grafia;
 *   3. criar etiqueta nova SÓ aparece para quem tem permissão — sem ela, o campo
 *      não oferece a opção e não grava texto novo.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EtiquetasDoContato } from "./EtiquetasDoContato";

function renderar(props: Partial<Parameters<typeof EtiquetasDoContato>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <EtiquetasDoContato
      value={[]}
      onChange={onChange}
      podeCriarEtiqueta={false}
      {...props}
    />,
  );
  return onChange;
}

const campo = () => screen.getByLabelText("Adicionar etiqueta");

describe("EtiquetasDoContato — autocompletar (issue #2732)", () => {
  it("digitar oferece as etiquetas da organização E as canonical_tags do funil", async () => {
    const user = userEvent.setup();
    renderar({
      vocabulario: ["cliente pagante", "são paulo"],
      canonicalTags: ["proposta enviada"],
    });

    await user.type(campo(), "cli");
    expect(screen.getByTestId("sugestao-cliente pagante")).toHaveTextContent("cliente pagante");

    await user.clear(campo());
    await user.type(campo(), "prop");
    // "proposta enviada" só existe no funil: sem a fonte das canonical_tags,
    // esta sugestão não apareceria.
    expect(screen.getByTestId("sugestao-proposta enviada")).toHaveTextContent("proposta enviada");
  });

  it("abrir o campo já oferece as etiquetas conhecidas", () => {
    renderar({ vocabulario: ["vip"], canonicalTags: ["implante"] });
    expect(screen.getByTestId("sugestao-vip")).toBeInTheDocument();
    expect(screen.getByTestId("sugestao-implante")).toBeInTheDocument();
  });

  it("gravar reusa a etiqueta existente, sem criar variante de acento", async () => {
    const user = userEvent.setup();
    const onChange = renderar({ vocabulario: ["São Paulo"] });

    await user.type(campo(), "sao paulo");
    // A sugestão mostra a grafia GRAVADA, não a digitada.
    expect(screen.getByTestId("sugestao-sao paulo")).toHaveTextContent("São Paulo");

    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith(["São Paulo"]);
    expect(onChange).not.toHaveBeenCalledWith(["sao paulo"]);
  });

  it("sem permissão: o texto novo NÃO vira etiqueta e não há opção de criar", async () => {
    const user = userEvent.setup();
    const onChange = renderar({ vocabulario: ["vip"], podeCriarEtiqueta: false });

    await user.type(campo(), "cliente ouro");
    expect(screen.queryByTestId("criar-etiqueta")).not.toBeInTheDocument();
    expect(screen.queryByText(/Criar etiqueta/)).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText("Só gerentes e administradores podem criar etiquetas novas."),
    ).toBeInTheDocument();
  });

  it("com permissão (gerente/admin): a opção de criar aparece e grava a etiqueta nova", async () => {
    const user = userEvent.setup();
    const onChange = renderar({ vocabulario: ["vip"], podeCriarEtiqueta: true });

    await user.type(campo(), "Cliente Ouro");
    const criar = screen.getByTestId("criar-etiqueta");
    expect(criar).toHaveTextContent("Cliente Ouro");

    await user.click(criar);
    // A régua do banco (normalizarTag) decide a grafia da etiqueta NOVA.
    expect(onChange).toHaveBeenCalledWith(["cliente ouro"]);
  });
});
