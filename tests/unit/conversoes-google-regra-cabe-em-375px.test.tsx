/**
 * Em Configurações › Conversões › Google, a 375px, os campos de uma regra ligada
 * saíam ~30px para fora do cartão (#5360: a linha de "Ação de conversão (ID)" +
 * "Criar no Google" ficava travada em linha sem quebra `flex gap-2`, forçando a
 * coluna do grid a se expandir além dos ~310px úteis do cartão e empurrando Nome,
 * Categoria e Canal).
 *
 * O jsdom não calcula layout de CSS Grid/Flexbox, então este teste prende:
 * 1. No DOM renderizado:
 *    - O contêiner de "ID da ação + Criar no Google" quebra em coluna no mobile
 *      (`flex-col sm:flex-row`) e o campo tem `min-w-0 flex-1`.
 *    - O botão "Criar no Google" recebe `shrink-0` e `w-full sm:w-auto`.
 *    - A grade e cada coluna usam `min-w-0` para não estourarem o cartão.
 * 2. No fonte:
 *    - As classes responsáveis por manter os campos contidos no cartão a 375px
 *      permanecem no componente.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RegrasDeConversaoGoogle } from "@/app/app/settings/conversoes/_regrasGoogle";
import type { RegraDeConversaoGoogle } from "@/lib/conversoes/regras-google";

vi.mock("@/app/actions/settings/salvarRegrasDeConversaoGoogle", () => ({
  salvarRegrasDeConversaoGoogle: vi.fn(),
}));
vi.mock("@/app/actions/settings/acoesDeConversaoGoogle", () => ({
  criarAcaoDeConversaoGoogle: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/app/app/settings/conversoes/_reprocessar", () => ({ ReprocessarConversao: () => null }));
vi.mock("@/app/app/settings/conversoes/_linkDoNegocio", () => ({ LinkDoNegocio: () => null }));

const ETAPA = { id: "et1", nome: "Qualificado", funil: "Vendas", primeira: false };
const REGRA: RegraDeConversaoGoogle = {
  id: "r1",
  stageId: ETAPA.id,
  eventName: `Etapa:${ETAPA.id}`,
  label: "Lead qualificado",
  googleActionId: "123456",
  googleCustomerId: null,
  googleLoginCustomerId: null,
  category: "QUALIFIED_LEAD",
  includedInConversions: true,
  channel: "todos",
  enabled: true,
  configuredAt: "2026-11-25T12:00:00Z",
};

afterEach(cleanup);

describe("Conversões › Google — campos da regra cabem em 375px (#5360)", () => {
  it("renderiza a linha de ação com quebra flexível no mobile e min-w-0 nos campos", () => {
    render(
      <RegrasDeConversaoGoogle
        etapas={[ETAPA]}
        regras={[REGRA]}
        idioma="pt-BR"
        podeCriarAcao
        contaPadraoId="1111111111"
        contaPadraoMcc={null}
        contasSugeridas={[]}
      />,
    );

    const regraCard = screen.getByTestId("regra-et1");
    const inputAcao = within(regraCard).getByLabelText("Ação de conversão (ID)");
    const linhaAcao = inputAcao.parentElement;
    expect(linhaAcao).toBeTruthy();
    expect(linhaAcao?.className).toContain("flex-col");
    expect(linhaAcao?.className).toContain("sm:flex-row");

    expect(inputAcao.className).toContain("min-w-0");
    expect(inputAcao.className).toContain("flex-1");

    const botaoCriar = within(regraCard).getByRole("button", { name: "Criar no Google" });
    expect(botaoCriar.className).toContain("shrink-0");
    expect(botaoCriar.className).toContain("w-full");
    expect(botaoCriar.className).toContain("sm:w-auto");
  });

  it("garante classes min-w-0 no grid de campos para conter o layout no mobile", () => {
    const fonte = readFileSync(
      join(process.cwd(), "app/app/settings/conversoes/_regrasGoogle.tsx"),
      "utf8",
    );
    expect(fonte).toContain("grid min-w-0 gap-4 md:grid-cols-2");
    expect(fonte).toContain("flex flex-col gap-2 sm:flex-row");
  });
});
