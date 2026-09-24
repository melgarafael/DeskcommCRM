import { describe, expect, it } from "vitest";

import { conferirNovaOrdem, fotoPertenceAoProduto, mimeDaFoto } from "./fotos";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA_ORG = "aaaaaaaa-0000-4000-8000-000000000002";
const PRODUTO = "bbbbbbbb-0000-4000-8000-000000000001";
const ARQUIVO = "cccccccc-dddd-4eee-8fff-000000000001.jpg";

describe("fotoPertenceAoProduto — o leitor confere o caminho que a linha traz", () => {
  it("aceita o caminho na forma exata que a rota gera", () => {
    expect(fotoPertenceAoProduto(`${ORG}/${PRODUTO}/${ARQUIVO}`, ORG, PRODUTO)).toBe(true);
  });

  it("recusa o caminho de OUTRA organização gravado na linha pelo PostgREST", () => {
    expect(fotoPertenceAoProduto(`${OUTRA_ORG}/${PRODUTO}/${ARQUIVO}`, ORG, PRODUTO)).toBe(false);
  });

  it("recusa o caminho de outro produto da mesma organização", () => {
    const outro = "bbbbbbbb-0000-4000-8000-000000000002";
    expect(fotoPertenceAoProduto(`${ORG}/${outro}/${ARQUIVO}`, ORG, PRODUTO)).toBe(false);
  });

  it("recusa quem tenta sair da pasta com `..` depois do prefixo certo", () => {
    expect(
      fotoPertenceAoProduto(`${ORG}/${PRODUTO}/../../${OUTRA_ORG}/${PRODUTO}/${ARQUIVO}`, ORG, PRODUTO),
    ).toBe(false);
  });

  it("recusa extensão que a rota nunca grava", () => {
    expect(fotoPertenceAoProduto(`${ORG}/${PRODUTO}/${ARQUIVO.replace(".jpg", ".svg")}`, ORG, PRODUTO)).toBe(
      false,
    );
  });
});

describe("conferirNovaOrdem — o PUT só reordena e remove", () => {
  const a = `${ORG}/${PRODUTO}/a.jpg`;
  const b = `${ORG}/${PRODUTO}/b.jpg`;
  const c = `${ORG}/${PRODUTO}/c.png`;

  it("reordenar não remove nada", () => {
    expect(conferirNovaOrdem([a, b, c], [c, a, b])).toEqual({ ok: true, removidas: [] });
  });

  it("o que sumiu da lista é o que se apaga do bucket", () => {
    expect(conferirNovaOrdem([a, b, c], [c])).toEqual({ ok: true, removidas: [a, b] });
  });

  it("caminho novo é recusado — foto nova só entra pelo upload, que confere os bytes", () => {
    expect(conferirNovaOrdem([a], [a, `${OUTRA_ORG}/${PRODUTO}/x.jpg`])).toEqual({ ok: false });
  });

  it("a mesma foto duas vezes é recusada", () => {
    expect(conferirNovaOrdem([a, b], [a, a])).toEqual({ ok: false });
  });
});

it("o mime acompanha a extensão gravada", () => {
  expect(mimeDaFoto("x/y/z.png")).toBe("image/png");
  expect(mimeDaFoto("x/y/z.jpg")).toBe("image/jpeg");
});
