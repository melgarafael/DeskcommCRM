import { describe, expect, it } from "vitest";

import { renderizar, saudacaoDaHora, variaveisUsadas } from "./renderizador";

const FUSO = "America/Sao_Paulo";
/** 15h em São Paulo (UTC-3). */
const TARDE = new Date("2026-09-18T18:00:00.000Z");
/** 9h em São Paulo. */
const MANHA = new Date("2026-09-18T12:00:00.000Z");

describe("renderizador da campanha", () => {
  it("substitui nome e primeiro nome", () => {
    const r = renderizar("Olá {{nome}}, tudo bem? Posso te chamar de {{primeiro_nome}}?", {
      nome: "Maria da Glória Prandini",
      });
    expect(r.texto).toBe("Olá Maria da Glória Prandini, tudo bem? Posso te chamar de Maria?");
    expect(r.faltando).toEqual([]);
  });

  it("tolera espaço dentro do token", () => {
    const r = renderizar("Oi {{  primeiro_nome  }}", { nome: "João Silva" });
    expect(r.texto).toBe("Oi João");
  });

  it("não envia texto com buraco: variável sem valor volta como FALTANDO e o literal fica", () => {
    const r = renderizar("Olá {{nome}}, tudo bem?", { nome: "   " });
    expect(r.faltando).toEqual(["nome"]);
    // O literal preservado é o que deixa o defeito visível na prévia em vez de
    // virar "Olá , tudo bem?" na conversa de um cliente.
    expect(r.texto).toBe("Olá {{nome}}, tudo bem?");
  });


  it("token desconhecido fica literal e é reportado, nunca vira vazio", () => {
    const r = renderizar("Oi {{sobrenome}}", { nome: "Ana Souza" });
    expect(r.texto).toBe("Oi {{sobrenome}}");
    expect(r.desconhecidas).toEqual(["sobrenome"]);
    expect(r.faltando).toEqual([]);
  });

  it("texto sem token passa intacto, unicode incluído", () => {
    const t = "Oferta 🍇 com acento: vinícola é ótimo — 100%";
    expect(renderizar(t, { nome: null }).texto).toBe(t);
  });

  it("a saudação é a da HORA DO ENVIO, não a do texto", () => {
    const manha = renderizar("{{saudacao}}!", { nome: null }, { agora: MANHA, fuso: FUSO });
    const tarde = renderizar("{{saudacao}}!", { nome: null }, { agora: TARDE, fuso: FUSO });
    expect(manha.texto).toBe("Bom dia!");
    expect(tarde.texto).toBe("Boa tarde!");
  });

  it("sem instante (prévia) a saudação fica literal — a prévia não inventa a hora do envio", () => {
    const r = renderizar("{{saudacao}}!", { nome: null });
    expect(r.texto).toBe("{{saudacao}}!");
    expect(r.faltando).toEqual([]);
  });

  it("os cortes da saudação são os do português falado, no fuso pedido", () => {
    expect(saudacaoDaHora(new Date("2026-09-18T14:59:00.000Z"), FUSO)).toBe("Bom dia"); // 11h59
    expect(saudacaoDaHora(new Date("2026-09-18T15:00:00.000Z"), FUSO)).toBe("Boa tarde"); // 12h
    expect(saudacaoDaHora(new Date("2026-09-18T21:00:00.000Z"), FUSO)).toBe("Boa noite"); // 18h
    // Mesmo instante, outro fuso: a régua é o fuso do canal, não o do servidor.
    expect(saudacaoDaHora(new Date("2026-09-18T15:00:00.000Z"), "UTC")).toBe("Boa tarde");
    expect(saudacaoDaHora(new Date("2026-09-18T11:00:00.000Z"), "UTC")).toBe("Bom dia");
  });

  it("lista as variáveis que o texto usa, sem repetir e sem inventar", () => {
    expect(variaveisUsadas("{{nome}} e {{nome}} e {{saudacao}} e {{xpto}}").sort()).toEqual([
      "nome",
      "saudacao",
    ]);
    expect(variaveisUsadas("texto seco")).toEqual([]);
  });

  it("não executa nada: chave com sintaxe de caminho não atravessa propriedade", () => {
    const r = renderizar("{{constructor.name}} {{__proto__}}", { nome: "Ana" });
    expect(r.texto).toBe("{{constructor.name}} {{__proto__}}");
  });
});
