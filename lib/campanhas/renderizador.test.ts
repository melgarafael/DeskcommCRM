import { describe, expect, it } from "vitest";

import { camposUsadosNoTexto, renderizar, saudacaoDaHora, variaveisUsadas } from "./renderizador";

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

describe("campos personalizados na campanha", () => {
  it("resolve {{lead.gancho}} e {{contato.link_previa}} sem tocar no resto do texto", () => {
    const r = renderizar(
      "Olá {{nome}}, achamos {{lead.gancho}} — prévia em {{contato.link_previa}}. {{saudacao}}!",
      {
        nome: "Ana Souza",
        lead: { gancho: "nota 3.2 no Google" },
        contato: { link_previa: "https://previa/ana" },
      },
      { agora: TARDE, fuso: FUSO },
    );
    expect(r.texto).toBe(
      "Olá Ana Souza, achamos nota 3.2 no Google — prévia em https://previa/ana. Boa tarde!",
    );
    expect(r.faltando).toEqual([]);
    expect(r.desconhecidas).toEqual([]);
  });

  it("REPROVA quando o texto novo não resolve: campo sem valor é FALTA, não texto pela metade", () => {
    // Campo que não existe no mapa do lead…
    const semCampo = renderizar("Olá {{nome}}, seu gancho: {{lead.gancho}}", {
      nome: "Ana Souza",
      lead: {},
    });
    expect(semCampo.faltando).toEqual(["lead.gancho"]);
    expect(semCampo.texto).toBe("Olá Ana Souza, seu gancho: {{lead.gancho}}");

    // …contato sem negócio nenhum (nem mapa chegou)…
    const semMapa = renderizar("Gancho: {{lead.gancho}}", { nome: "Ana Souza" });
    expect(semMapa.faltando).toEqual(["lead.gancho"]);

    // …e campo gravado em branco: os três são a MESMA falta, e é ela que tira a
    // pessoa da lista (`variavel_ausente`) antes do operador apertar.
    const emBranco = renderizar("Link: {{contato.link_previa}}", {
      nome: "Ana Souza",
      contato: { link_previa: "   " },
    });
    expect(emBranco.faltando).toEqual(["contato.link_previa"]);
    expect(emBranco.texto).toBe("Link: {{contato.link_previa}}");
  });

  it("a lista do multiselect sai como a pessoa leria; número e booleano viram texto", () => {
    const r = renderizar("{{lead.tags}}|{{lead.score}}|{{lead.ativo}}", {
      nome: null,
      lead: { tags: ["agência", "reativação"], score: 0, ativo: false },
    });
    expect(r.texto).toBe("agência, reativação|0|false");
    expect(r.faltando).toEqual([]);
    // Objeto embutido não vira "[object Object]" na conversa de ninguém.
    const obj = renderizar("{{lead.endereco}}", { nome: null, lead: { endereco: { rua: "A" } } });
    expect(obj.faltando).toEqual(["lead.endereco"]);
  });

  it("aceita o caminho da automação ({{lead.custom_fields.x}}) e caixa trocada no nome do campo", () => {
    const r = renderizar("{{lead.custom_fields.gancho}} e {{Lead.Gancho}}", {
      nome: null,
      lead: { gancho: "oi" },
    });
    expect(r.texto).toBe("oi e oi");
    expect(r.faltando).toEqual([]);
  });

  it("campo personalizado não atravessa protótipo, nem com o jsonb gravado torto", () => {
    const r = renderizar("{{lead.__proto__}} {{lead.constructor}} {{contato.prototype}}", {
      nome: "Ana",
      lead: {},
      contato: {},
    });
    expect(r.texto).toBe("{{lead.__proto__}} {{lead.constructor}} {{contato.prototype}}");
    // Falta (a pessoa sai da lista), não desconhecida (que ficaria pra depois).
    expect(r.faltando).toEqual(["lead.__proto__", "lead.constructor", "contato.prototype"]);
    expect(r.desconhecidas).toEqual([]);
  });

  it("raiz que não é lead nem contato continua literal e desconhecida, como no Inbox", () => {
    const r = renderizar("Oi {{contact.name}} {{sobrenome}}", { nome: "Ana Souza" });
    expect(r.texto).toBe("Oi {{contact.name}} {{sobrenome}}");
    expect(r.desconhecidas).toEqual(["contact.name", "sobrenome"]);
    expect(r.faltando).toEqual([]);
  });

  it("lista as variáveis do texto incluindo o caminho do campo personalizado", () => {
    expect(variaveisUsadas("{{nome}} {{lead.gancho}} {{lead.gancho}} {{contato.link_previa}}").sort()).toEqual(
      ["contato.link_previa", "lead.gancho", "nome"],
    );
    expect(variaveisUsadas("{{sobrenome}}")).toEqual([]);
  });

  it("só puxa campo personalizado do banco quando o TEXTO usa a raiz", () => {
    expect(camposUsadosNoTexto("Olá {{nome}}, {{saudacao}}!")).toEqual({ lead: false, contato: false });
    expect(camposUsadosNoTexto("Olá {{nome}}, {{lead.gancho}}")).toEqual({ lead: true, contato: false });
    expect(camposUsadosNoTexto("{{  contato.link_previa  }}")).toEqual({ lead: false, contato: true });
    // `{{lead}}` sem ponto não é campo: não vale uma coluna de jsonb.
    expect(camposUsadosNoTexto("oi {{lead}}")).toEqual({ lead: false, contato: false });
  });
});

describe("o valor do cadastro sai LITERAL, mesmo com o corpo renderizado duas vezes", () => {
  // As duas passadas reais: a preparação congela (sem instante) e o envio
  // (`rodada.ts`) renderiza o congelado de novo, só com nome e instante.
  const VALOR = "{{saudacao}} {{nome}} {{lead.outro}} $& $1";
  const envio = (congelado: string) =>
    renderizar(congelado, { nome: "Ana Souza" }, { agora: TARDE, fuso: FUSO });

  it("campo com sintaxe de token chega ao contato como foi gravado", () => {
    const prep = renderizar("Oi {{nome}}, {{lead.gancho}}", { nome: "Ana Souza", lead: { gancho: VALOR } });
    expect(prep.faltando).toEqual([]);
    const saida = envio(prep.texto);
    expect(saida.texto).toBe(`Oi Ana Souza, ${VALOR}`);
    expect(saida.faltando).toEqual([]);
    expect(saida.texto).not.toContain("⁠");
  });

  it("a saudação do TEXTO continua resolvida no envio — o par do 'não reinterprete'", () => {
    const prep = renderizar("{{saudacao}}, {{contato.link_previa}}", {
      nome: null,
      contato: { link_previa: "{{saudacao}}" },
    });
    expect(envio(prep.texto).texto).toBe("Boa tarde, {{saudacao}}");
  });

  it("nome do cadastro com sintaxe de token também sai literal", () => {
    const prep = renderizar("Oi {{nome}}!", { nome: "{{saudacao}}" });
    expect(renderizar(prep.texto, { nome: null }, { agora: TARDE, fuso: FUSO }).texto).toBe("Oi {{saudacao}}!");
  });

  it("no envio de teste (uma passada só, com instante) o valor também sai literal", () => {
    const r = renderizar("{{lead.gancho}}", { nome: null, lead: { gancho: VALOR } }, { agora: TARDE, fuso: FUSO });
    expect(r.texto).toBe(VALOR);
  });
});
