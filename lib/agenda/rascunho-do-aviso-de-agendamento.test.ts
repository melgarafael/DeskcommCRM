import { describe, expect, it } from "vitest";

import {
  SEM_GRUPO,
  conexaoQueEnviaDoRascunho,
  mudarRascunhoDoAviso,
  numeroPareceDeForaDoBrasil,
  oQueFaltaParaLigar,
  type RascunhoDoAvisoDeAgendamento,
} from "./rascunho-do-aviso-de-agendamento";

const CASO = { channel_session_id: "conexao-do-caso" };

function rascunho(
  parcial: Partial<RascunhoDoAvisoDeAgendamento> = {},
): RascunhoDoAvisoDeAgendamento {
  return {
    usaNumeroDoCaso: false,
    canal: "conexao-a",
    telefone: "+5511999990000",
    grupo: "120363000000000001@g.us",
    ligado: true,
    ...parcial,
  };
}

describe("o grupo escolhido acompanha a conexão que envia (R1, issue #1)", () => {
  it("trocar a conexão zera o grupo, que era da conexão anterior", () => {
    const depois = mudarRascunhoDoAviso(rascunho(), { canal: "conexao-b" }, CASO);
    expect(depois.canal).toBe("conexao-b");
    expect(depois.grupo).toBe(SEM_GRUPO);
  });

  it("ligar 'usar o número do aviso de caso' troca a conexão e zera o grupo", () => {
    const depois = mudarRascunhoDoAviso(rascunho(), { usaNumeroDoCaso: true }, CASO);
    expect(conexaoQueEnviaDoRascunho(depois, CASO)).toBe("conexao-do-caso");
    expect(depois.grupo).toBe(SEM_GRUPO);
  });

  it("desligar 'usar o número do aviso de caso' volta à conexão própria e zera o grupo", () => {
    const antes = rascunho({ usaNumeroDoCaso: true });
    const depois = mudarRascunhoDoAviso(antes, { usaNumeroDoCaso: false }, CASO);
    expect(depois.grupo).toBe(SEM_GRUPO);
  });

  it("escolher a mesma conexão de novo mantém o grupo", () => {
    const depois = mudarRascunhoDoAviso(rascunho(), { canal: "conexao-a" }, CASO);
    expect(depois.grupo).toBe("120363000000000001@g.us");
  });

  it("mudar o telefone, o grupo ou o liga/desliga não mexe no resto", () => {
    expect(mudarRascunhoDoAviso(rascunho(), { telefone: "+5511888880000" }, CASO).grupo).toBe(
      "120363000000000001@g.us",
    );
    expect(mudarRascunhoDoAviso(rascunho(), { grupo: "120363000000000002@g.us" }, CASO).grupo).toBe(
      "120363000000000002@g.us",
    );
    expect(mudarRascunhoDoAviso(rascunho(), { ligado: false }, CASO).grupo).toBe(
      "120363000000000001@g.us",
    );
  });

  it("sem aviso de caso, o switch não troca a conexão e o grupo fica", () => {
    const depois = mudarRascunhoDoAviso(rascunho(), { usaNumeroDoCaso: true }, null);
    expect(conexaoQueEnviaDoRascunho(depois, null)).toBe("conexao-a");
    expect(depois.grupo).toBe("120363000000000001@g.us");
  });

  it("sem conexão escolhida não há conexão que envia", () => {
    expect(conexaoQueEnviaDoRascunho(rascunho({ canal: "" }), null)).toBeNull();
  });
});

describe("o número sem +55 ganha um aviso que não bloqueia (ajuste do dono, issue #1)", () => {
  const BRASIL = "+5511999998888";

  it("número que começa com +55 não ganha aviso", () => {
    expect(numeroPareceDeForaDoBrasil("+5531998966398", BRASIL)).toBe(false);
  });

  it("número com outro código de país ganha o aviso", () => {
    expect(numeroPareceDeForaDoBrasil("+15551234567", BRASIL)).toBe(true);
    expect(numeroPareceDeForaDoBrasil("+351912345678", BRASIL)).toBe(true);
  });

  it("campo vazio ou com um dígito só ainda não ganha aviso", () => {
    expect(numeroPareceDeForaDoBrasil("", BRASIL)).toBe(false);
    expect(numeroPareceDeForaDoBrasil("+5", BRASIL)).toBe(false);
  });

  it("organização de outro país não vê o aviso do Brasil", () => {
    expect(numeroPareceDeForaDoBrasil("+351912345678", "+351912345678")).toBe(false);
  });
});

describe("o botão travado diz o que falta (ajuste do dono, issue #1)", () => {
  it("usando o número do aviso de caso, nada falta", () => {
    expect(oQueFaltaParaLigar({ usaNumeroDoCaso: true, conexaoOferecida: false, telefoneOk: false })).toBeNull();
  });

  it("sem conexão e sem número, faltam os dois", () => {
    expect(oQueFaltaParaLigar({ usaNumeroDoCaso: false, conexaoOferecida: false, telefoneOk: false })).toBe(
      "conexao_e_numero",
    );
  });

  it("só a conexão falta", () => {
    expect(oQueFaltaParaLigar({ usaNumeroDoCaso: false, conexaoOferecida: false, telefoneOk: true })).toBe("conexao");
  });

  it("só o número falta", () => {
    expect(oQueFaltaParaLigar({ usaNumeroDoCaso: false, conexaoOferecida: true, telefoneOk: false })).toBe("numero");
  });

  it("com conexão e número, nada falta", () => {
    expect(oQueFaltaParaLigar({ usaNumeroDoCaso: false, conexaoOferecida: true, telefoneOk: true })).toBeNull();
  });
});
