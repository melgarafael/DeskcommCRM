/**
 * A escada de fusos — quem vence quem, e o que acontece quando ninguém serve.
 */
import { describe, expect, it } from "vitest";

import { FUSO_PADRAO, fusoUtilizavel, fusoValido } from "./fusos";

describe("o fuso utilizável", () => {
  it("a escolha da PESSOA vence a da organização", () => {
    expect(fusoUtilizavel("America/Manaus", "America/Sao_Paulo")).toBe("America/Manaus");
  });

  it("sem escolha da pessoa, vale a da organização — e não o padrão", () => {
    // O caso que motivou a escada: `user_metadata.timezone` é nulo em quem
    // nunca abriu Configurações › Perfil, que é quase todo mundo.
    expect(fusoUtilizavel(null, "America/Manaus")).toBe("America/Manaus");
    expect(fusoUtilizavel(undefined, "Europe/Lisbon")).toBe("Europe/Lisbon");
  });

  it("pula o que o Intl recusa em vez de lançar — o campo não é validado por ninguém", () => {
    // `organizations.timezone` é `z.string().max(64)` sem `refine`: "São Paulo"
    // com acento e espaço é um valor que alguém realmente digita.
    expect(fusoValido("São Paulo")).toBe(false);
    expect(fusoUtilizavel("São Paulo", "America/Manaus")).toBe("America/Manaus");
  });

  it("vazio e espaço em branco não contam como escolha", () => {
    expect(fusoUtilizavel("", "   ", "America/Manaus")).toBe("America/Manaus");
  });

  it("sem nenhum candidato utilizável, cai no padrão do produto — nunca em UTC", () => {
    // UTC daria três horas de erro numa instalação brasileira, calado.
    expect(fusoUtilizavel(null, "São Paulo", "")).toBe(FUSO_PADRAO);
    expect(fusoUtilizavel()).toBe(FUSO_PADRAO);
  });
});
