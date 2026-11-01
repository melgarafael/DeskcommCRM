import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  type CanalDeIdentidade,
  type IdentidadeDoContato,
  chaveDaIdentidade,
  juntarFichas,
  normalizarIdentificador,
  sugerirVinculo,
} from "./identidades";

/**
 * A parte PURA da fatia 1 da #3764: forma canônica, sugestão de vínculo e
 * junção manual. Nenhum dublê de banco aqui — é o que permite rodar isto no
 * `test:unit` sem Docker.
 */

const identidade = (
  contactId: string,
  canal: CanalDeIdentidade,
  identificador: string,
): IdentidadeDoContato => ({ contactId, canal, identificador });

describe("normalizarIdentificador", () => {
  it("telefone vira E.164 com o nono dígito, tenha o cliente digitado o 9 ou não", () => {
    // O wa_id chega com 12 dígitos e o brasileiro digita 13: a MESMA pessoa.
    assert.equal(normalizarIdentificador("whatsapp", "553198966398"), "+5531998966398");
    assert.equal(normalizarIdentificador("whatsapp", "+55 31 98966-398"), "+5531998966398");
    assert.equal(normalizarIdentificador("whatsapp", "(31) 99896-6398"), "+5531998966398");
    assert.equal(normalizarIdentificador("whatsapp", "+14155551234"), "+14155551234");
  });

  it("e-mail vira minúsculas sem espaço, e o que não é e-mail não é identidade", () => {
    assert.equal(normalizarIdentificador("email", "  Fulano@Empresa.COM "), "fulano@empresa.com");
    assert.equal(normalizarIdentificador("email", "fulano"), null);
    assert.equal(normalizarIdentificador("email", "fulano@empresa"), null);
  });

  it("perfil social perde @, URL, barra final, query e maiúscula", () => {
    assert.equal(normalizarIdentificador("instagram", "@Fulano.Da.Silva"), "fulano.da.silva");
    assert.equal(
      normalizarIdentificador("instagram", "https://www.instagram.com/fulano/?hl=pt"),
      "fulano",
    );
    assert.equal(normalizarIdentificador("facebook", "facebook.com/fulano_2/"), "fulano_2");
    // PSID numérico da página: é o identificador que a Graph API entrega.
    assert.equal(normalizarIdentificador("facebook", "1029384756"), "1029384756");
  });

  it("valor vazio ou de outro canal não vira identidade vazia", () => {
    // Identidade vazia colidiria no índice com a de outra ficha "sem identificador".
    assert.equal(normalizarIdentificador("email", "   "), null);
    assert.equal(normalizarIdentificador("whatsapp", "abc"), null);
    assert.equal(normalizarIdentificador("instagram", ".."), null);
    assert.equal(normalizarIdentificador("instagram", null), null);
    assert.equal(normalizarIdentificador("facebook", undefined), null);
  });

  it("o mesmo número em canais diferentes é chave diferente", () => {
    // O canal faz parte da identidade: o mesmo texto em duas redes não prova nada.
    assert.notEqual(
      chaveDaIdentidade("instagram", "fulano"),
      chaveDaIdentidade("facebook", "fulano"),
    );
  });
});

describe("sugerirVinculo", () => {
  const doBanco: IdentidadeDoContato[] = [
    identidade("ficha-a", "whatsapp", "+5531998966398"),
    identidade("ficha-b", "email", "fulano@empresa.com"),
    identidade("ficha-c", "instagram", "fulano"),
  ];

  it("identificador igual sugere a ficha dona, mesmo com a grafia sem o nono dígito", () => {
    const sugestoes = sugerirVinculo(
      { canal: "whatsapp", identificador: "553198966398" },
      doBanco,
    );
    assert.deepEqual(
      sugestoes.map((s) => s.contactId),
      ["ficha-a"],
    );
    assert.equal(sugestoes[0]?.identidade.canal, "whatsapp");
  });

  it("a ficha aberta não é sugestão de vínculo consigo mesma", () => {
    assert.deepEqual(
      sugerirVinculo(
        { canal: "whatsapp", identificador: "+5531998966398" },
        doBanco,
        { ignorarContatoId: "ficha-a" },
      ),
      [],
    );
  });

  it("identificador inédito não inventa vínculo", () => {
    assert.deepEqual(
      sugerirVinculo({ canal: "whatsapp", identificador: "31988887777" }, doBanco),
      [],
    );
    // Vazio também não: nada de sugerir a primeira ficha do banco.
    assert.deepEqual(sugerirVinculo({ canal: "email", identificador: " " }, doBanco), []);
  });

  it("a sugestão não confunde canais diferentes", () => {
    // O handle `fulano` do Instagram não sugere nada para o Facebook.
    assert.deepEqual(
      sugerirVinculo({ canal: "facebook", identificador: "fulano" }, doBanco),
      [],
    );
  });
});

describe("juntarFichas", () => {
  it("funde as identidades das duas fichas na principal, sem duplicar nenhuma", () => {
    const resultado = juntarFichas("principal", "absorvida", [
      identidade("principal", "whatsapp", "+5531998966398"),
      identidade("absorvida", "instagram", "fulano"),
      identidade("absorvida", "email", "fulano@empresa.com"),
    ]);

    assert.equal(resultado.ok, true);
    if (!resultado.ok) return;
    assert.deepEqual(resultado.identidades, [
      identidade("principal", "whatsapp", "+5531998966398"),
      identidade("principal", "instagram", "fulano"),
      identidade("principal", "email", "fulano@empresa.com"),
    ]);
    assert.deepEqual(resultado.repetidas, []);
    // Nenhuma identidade aparece duas vezes: é a promessa da fusão.
    const chaves = resultado.identidades.map((i) => chaveDaIdentidade(i.canal, i.identificador));
    assert.equal(new Set(chaves).size, chaves.length);
  });

  it("identidade repetida entre as duas fichas é colapsada, não duplicada", () => {
    const resultado = juntarFichas("principal", "absorvida", [
      identidade("principal", "whatsapp", "+5531998966398"),
      identidade("absorvida", "whatsapp", "+5531998966398"),
      identidade("absorvida", "instagram", "fulano"),
    ]);

    assert.equal(resultado.ok, true);
    if (!resultado.ok) return;
    assert.equal(resultado.identidades.length, 2);
    assert.deepEqual(
      resultado.repetidas.map((i) => i.identificador),
      ["+5531998966398"],
    );
  });

  it("identidade que já é de uma terceira ficha RECUSA a junção inteira", () => {
    const resultado = juntarFichas("principal", "absorvida", [
      identidade("principal", "whatsapp", "+5531998966398"),
      identidade("absorvida", "email", "fulano@empresa.com"),
      // Terceira ficha: o índice único é por organização, então esta linha não
      // deveria existir; quando existe, juntar deixaria uma das três sem dono.
      identidade("terceira", "email", "fulano@empresa.com"),
    ]);

    assert.equal(resultado.ok, false);
    if (resultado.ok) return;
    assert.equal(resultado.motivo, "identidade_de_terceiro");
    assert.deepEqual(
      resultado.conflitos.map((i) => i.identificador),
      ["fulano@empresa.com"],
    );
  });

  it("juntar a ficha com ela mesma é recusa, não sucesso vazio", () => {
    const resultado = juntarFichas("ficha", "ficha", [
      identidade("ficha", "whatsapp", "+5531998966398"),
    ]);
    assert.equal(resultado.ok, false);
    if (resultado.ok) return;
    assert.equal(resultado.motivo, "mesma_ficha");
    assert.deepEqual(resultado.conflitos, []);
  });

  it("as identidades da absorvida passam a apontar para a principal", () => {
    const resultado = juntarFichas("principal", "absorvida", [
      identidade("absorvida", "facebook", "fulano"),
    ]);
    assert.equal(resultado.ok, true);
    if (!resultado.ok) return;
    assert.deepEqual(resultado.identidades, [identidade("principal", "facebook", "fulano")]);
  });
});
