import { describe, expect, it } from "vitest";

import { classificarErroGraph } from "@/lib/plataformas-de-anuncio/meta/insights";

/**
 * CADA FALHA PEDE UMA COISA DIFERENTE DE QUEM LÊ A TELA.
 *
 * Mesma doutrina do `ResultadoDeEnvio` do eixo de conversões (invariante 2 da
 * doutrina de restrição de canal): colapsar tudo em "erro ao carregar" produz
 * dois desperdícios concretos e opostos — quem tem token expirado fica
 * recarregando, e quem esbarrou na cota vai gerar um token novo que não conserta
 * nada.
 *
 * O `campo_invalido` (código 100) merece a atenção maior porque é o único que
 * NÃO é acionável por quem opera: é bug nosso ou campo que a plataforma removeu.
 * Foi exatamente o que aconteceu com `video_3_sec_watched_actions`, válido até a
 * v21 e erro 100 na v22 — descoberto na sondagem de 2026-09-02, não na
 * documentação.
 */

describe("token — alguém precisa colar um token novo", () => {
  it.each([
    [190, "OAuth access token inválido"],
    [102, "sessão inválida"],
    [463, "token expirado"],
    [467, "token revogado"],
  ])("código %i é token_invalido (%s)", (codigo) => {
    expect(classificarErroGraph(400, codigo)).toBe("token_invalido");
  });

  it("401 sem código conhecido também é token", () => {
    expect(classificarErroGraph(401, null)).toBe("token_invalido");
  });
});

describe("permissão — token novo com o mesmo escopo NÃO resolve", () => {
  it.each([10, 200, 272, 294])("código %i é permissao_insuficiente", (codigo) => {
    expect(classificarErroGraph(403, codigo)).toBe("permissao_insuficiente");
  });

  it("não é confundido com token: a tela precisa citar ads_read", () => {
    expect(classificarErroGraph(403, 200)).not.toBe("token_invalido");
  });
});

describe("cota — esperar resolve, e a tela precisa dizer isso", () => {
  it.each([4, 17, 32, 613, 80000, 80004])("código %i é limite_de_chamadas", (codigo) => {
    expect(classificarErroGraph(400, codigo)).toBe("limite_de_chamadas");
  });

  it("não vira token_invalido — senão o operador troca a credencial à toa", () => {
    expect(classificarErroGraph(400, 613)).not.toBe("token_invalido");
  });
});

describe("campo inválido — bug nosso, não do operador", () => {
  it("código 100 tem classe própria", () => {
    expect(classificarErroGraph(400, 100)).toBe("campo_invalido");
  });

  it("não é tratado como transitório: 'tente mais tarde' desperdiça o dia dele", () => {
    expect(classificarErroGraph(400, 100)).not.toBe("transitorio");
  });
});

describe("transitório — tentar de novo resolve", () => {
  it.each([500, 502, 503])("status %i sem código é transitorio", (status) => {
    expect(classificarErroGraph(status, null)).toBe("transitorio");
  });

  it("5xx COM código de cota continua sendo cota", () => {
    expect(classificarErroGraph(500, 613)).toBe("limite_de_chamadas");
  });

  it("4xx desconhecido que não é 401/403 cai em transitorio", () => {
    expect(classificarErroGraph(400, 999999)).toBe("transitorio");
  });
});
