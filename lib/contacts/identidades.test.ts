import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ehCanalDeIdentidade, normalizarIdentificador } from "./identidades";

/**
 * A parte PURA da fatia 1 da #3764: a forma canônica do identificador de rede
 * social. Nenhum dublê de banco aqui — é o que permite rodar isto no
 * `test:unit` sem Docker.
 */

describe("normalizarIdentificador", () => {
  it("perfil social perde @, URL, barra final, query e maiúscula", () => {
    assert.equal(normalizarIdentificador("instagram", "@Fulano.Da.Silva"), "fulano.da.silva");
    assert.equal(
      normalizarIdentificador("instagram", "https://www.instagram.com/fulano/?hl=pt"),
      "fulano",
    );
    assert.equal(normalizarIdentificador("facebook", "facebook.com/fulano_2/"), "fulano_2");
  });

  it("o id numérico do participante, que a DM entrega, passa intacto nas duas redes", () => {
    assert.equal(normalizarIdentificador("instagram", "17841400000000001"), "17841400000000001");
    assert.equal(normalizarIdentificador("facebook", "1029384756"), "1029384756");
  });

  it("valor vazio ou que não é perfil não vira identidade vazia", () => {
    // Identidade vazia colidiria no índice com a de outra ficha "sem identificador".
    assert.equal(normalizarIdentificador("instagram", "   "), null);
    assert.equal(normalizarIdentificador("instagram", ".."), null);
    assert.equal(normalizarIdentificador("instagram", "com espaço"), null);
    assert.equal(normalizarIdentificador("instagram", null), null);
    assert.equal(normalizarIdentificador("facebook", undefined), null);
  });
});

describe("ehCanalDeIdentidade", () => {
  it("só as redes do CHECK de contact_identities.canal", () => {
    assert.equal(ehCanalDeIdentidade("instagram"), true);
    assert.equal(ehCanalDeIdentidade("facebook"), true);
    // Telefone e e-mail têm guarda própria; outra rede ainda não tem lugar.
    assert.equal(ehCanalDeIdentidade("whatsapp"), false);
    assert.equal(ehCanalDeIdentidade("email"), false);
    assert.equal(ehCanalDeIdentidade("linkedin"), false);
  });
});
