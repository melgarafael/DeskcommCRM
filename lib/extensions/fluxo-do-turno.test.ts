import { describe, expect, it } from "vitest";

import {
  decidirDoFluxo,
  fluxoDoTurnoSchema,
  gatilhoQueCasou,
  idiomaDaMensagem,
  mensagemForaDoFluxo,
  parseFluxoDoTurno,
  textoNoIdioma,
  type EstadoDoFluxo,
  type FluxoDoTurno,
} from "@/lib/extensions/fluxo-do-turno";

/**
 * O FLUXO DECLARATIVO DA EXTENSÃO (#3076, item 5) — o vocabulário e a decisão,
 * sem banco, sem canal, sem relógio.
 *
 * O consumidor real é o fluxo de laudo do #3063: o paciente pergunta "meu laudo
 * está pronto?", a extensão pergunta o tipo de exame e coleta nome, data e
 * médico — uma pergunta por vez — e depois passa para um humano, sem nunca
 * afirmar prazo nem resultado. Ele fala inglês e híndi, e é por isso que os
 * textos aqui têm `en`/`hi` e o gatilho carrega o IDIOMA junto.
 */

const AGORA = "2026-10-26T12:00:00.000Z";

const LAUDO: FluxoDoTurno = {
  id: "laudo",
  idiomas: ["pt-BR", "en"],
  gatilhos: [
    { idioma: "pt-BR", texto: "meu laudo está pronto" },
    { idioma: "pt-BR", texto: "laudo pronto" },
    { idioma: "en", texto: "is my report ready" },
  ],
  perguntas: [
    {
      campo: "tipo-de-exame",
      texto: {
        "pt-BR": "Qual é o tipo de exame?",
        en: "What type of exam is it?",
      },
    },
    {
      campo: "nome",
      texto: { "pt-BR": "Qual é o seu nome completo?", en: "What is your full name?" },
    },
    {
      campo: "data",
      texto: { "pt-BR": "Qual é a data da coleta?", en: "What is the collection date?" },
    },
  ],
  desfecho: {
    tipo: "passar_para_humano",
    aviso: {
      "pt-BR": "Vou passar seu caso para a equipe conferir.",
      en: "I'll pass your case to the team to check.",
    },
  },
};

function estadoEm(etapa: number, campos: Record<string, string> = {}): EstadoDoFluxo {
  return {
    extensao: "acme/laudo",
    fluxo: LAUDO.id,
    idioma: "pt-BR",
    etapa,
    campos,
    sem_progresso: 0,
    mensagens: [],
    iniciado_em: AGORA,
  };
}

describe("o schema do fluxo declarado", () => {
  it("aceita o fluxo do laudo com textos em pt-BR e en", () => {
    expect(() => fluxoDoTurnoSchema.parse(LAUDO)).not.toThrow();
  });

  it("recusa idioma declarado sem texto: cobertura mentirosa vira bolha vazia", () => {
    const semIngles = {
      ...LAUDO,
      perguntas: LAUDO.perguntas.map((p, i) =>
        i === 1 ? { campo: p.campo, texto: { "pt-BR": "Qual é o seu nome completo?" } } : p,
      ),
    };
    expect(() => fluxoDoTurnoSchema.parse(semIngles)).toThrow(/sem texto em en/);
  });

  it("recusa fluxo sem pt-BR: não haveria recuo", () => {
    expect(() => fluxoDoTurnoSchema.parse({ ...LAUDO, idiomas: ["en"] })).toThrow(/pt-BR/);
  });

  it("recusa gatilho em idioma fora da cobertura declarada", () => {
    const fluxo = {
      ...LAUDO,
      gatilhos: [...LAUDO.gatilhos, { idioma: "hi", texto: "mera report taiyar hai" }],
    };
    expect(() => fluxoDoTurnoSchema.parse(fluxo)).toThrow(/fora dos idiomas declarados/);
  });

  it("recusa campo repetido e pergunta acima do limite", () => {
    const repetido = {
      ...LAUDO,
      perguntas: [LAUDO.perguntas[0]!, LAUDO.perguntas[0]!],
    };
    expect(() => fluxoDoTurnoSchema.parse(repetido)).toThrow(/campo repetido/);
    expect(() =>
      fluxoDoTurnoSchema.parse({
        ...LAUDO,
        perguntas: [{ campo: "x", texto: { "pt-BR": "a".repeat(301) } }],
      }),
    ).toThrow();
  });

  it("recusa campo desconhecido (vocabulário fechado)", () => {
    expect(() => fluxoDoTurnoSchema.parse({ ...LAUDO, javascript: "alert(1)" })).toThrow();
  });

  it("parseFluxoDoTurno devolve o fluxo tipado", () => {
    const fluxo = parseFluxoDoTurno(JSON.parse(JSON.stringify(LAUDO)));
    expect(fluxo.id).toBe("laudo");
    expect(fluxo.perguntas.map((p) => p.campo)).toEqual(["tipo-de-exame", "nome", "data"]);
  });
});

describe("textoNoIdioma: recuo em pt-BR, nunca vazio", () => {
  it("usa o idioma pedido quando existe", () => {
    expect(textoNoIdioma(LAUDO.perguntas[1]!.texto, "en")).toBe("What is your full name?");
  });

  it("cai no pt-BR quando o idioma não tem texto ou é nulo", () => {
    expect(textoNoIdioma({ "pt-BR": "Oi" }, "hi")).toBe("Oi");
    expect(textoNoIdioma({ "pt-BR": "Oi" }, null)).toBe("Oi");
  });
});

describe("idiomaDaMensagem: detecta o que o produto sabe cobrir", () => {
  it("devanágari é híndi, sem precisar de vocabulário", () => {
    expect(idiomaDaMensagem("मेरा रिपोर्ट तैयार है")).toBe("hi");
  });

  it("til e cedilha são português", () => {
    expect(idiomaDaMensagem("meu laudo não está pronto, você sabe?")).toBe("pt-BR");
  });

  it("inglês pelo vocabulário funcional", () => {
    expect(idiomaDaMensagem("is my report ready please")).toBe("en");
  });

  it("empate é null — desempatar por ordem de lista faria o fluxo disparar na conversa errada", () => {
    // "report" existe nas duas listas (en e hi) e nada mais pontua.
    expect(idiomaDaMensagem("report")).toBeNull();
  });

  it("mensagem sem sinal nenhum é null", () => {
    expect(idiomaDaMensagem("xyz")).toBeNull();
    expect(idiomaDaMensagem("")).toBeNull();
  });
});

describe("gatilho: estreito, por idioma, como frase", () => {
  it("casa o gatilho em português na mensagem em português", () => {
    expect(gatilhoQueCasou(LAUDO, "oi, meu laudo está pronto?", "pt-BR")?.texto).toBe(
      "meu laudo está pronto",
    );
  });

  it("⭐ NÃO casa 'report' dentro de frase em português (o defeito que a nota do mantenedor pediu para evitar)", () => {
    // Frase em português com a palavra inglesa no meio: o gatilho `en` não pode
    // disparar porque o idioma da mensagem é pt-BR.
    const frase = "não consigo abrir o report da loja";
    expect(idiomaDaMensagem(frase)).toBe("pt-BR");
    expect(gatilhoQueCasou(LAUDO, frase, "pt-BR")).toBeNull();
    // E a detecção nunca devolve "en" só por causa da palavra inglesa solta.
    expect(idiomaDaMensagem(frase)).not.toBe("en");
  });

  it("frase LONGA que contém o gatilho não dispara: é conversa, não pedido de fluxo", () => {
    const frase =
      "olá, tudo bem? eu queria saber se você pode me ajudar porque ontem eu liguei e ninguém atendeu e agora estou aqui de novo com a mesma dúvida";
    expect(gatilhoQueCasou(LAUDO, frase, "pt-BR")).toBeNull();
  });

  it("não casa pedaço de palavra (gatilho é frase, não substring)", () => {
    const fluxo: FluxoDoTurno = {
      ...LAUDO,
      gatilhos: [{ idioma: "pt-BR", texto: "laudo" }],
    };
    expect(gatilhoQueCasou(fluxo, "laudocracia", "pt-BR")).toBeNull();
    expect(gatilhoQueCasou(fluxo, "meu laudo saiu", "pt-BR")?.texto).toBe("laudo");
  });

  it("casa o gatilho em inglês na mensagem em inglês", () => {
    const frase = "hello, is my report ready";
    expect(idiomaDaMensagem(frase)).toBe("en");
    expect(gatilhoQueCasou(LAUDO, frase, "en")?.texto).toBe("is my report ready");
  });

  it("ignora acento e maiúscula", () => {
    expect(gatilhoQueCasou(LAUDO, "MEU LAUDO ESTA PRONTO", "pt-BR")?.texto).toBe(
      "meu laudo está pronto",
    );
  });
});

describe("mensagemForaDoFluxo: os exemplos medidos na issue", () => {
  it.each(["obrigado", "Obrigada!", "valeu", "thanks", "ok", "dhanyavad"])(
    "encerramento/agradecimento devolve: %s",
    (texto) => expect(mensagemForaDoFluxo(texto)).toBe(true),
  );

  it.each(["quanto custa?", "abrem sábado?"])("pergunta devolve: %s", (texto) =>
    expect(mensagemForaDoFluxo(texto)).toBe(true),
  );

  it("resposta curta de campo NÃO é fora do fluxo", () => {
    expect(mensagemForaDoFluxo("Hemograma completo")).toBe(false);
    expect(mensagemForaDoFluxo("Maria Aparecida da Silva")).toBe(false);
    expect(mensagemForaDoFluxo("12/10/2026")).toBe(false);
  });

  it("parágrafo longo não vale como valor de campo", () => {
    expect(mensagemForaDoFluxo("a".repeat(121))).toBe(true);
    expect(mensagemForaDoFluxo("uma duas tres quatro cinco seis sete oito nove dez onze doze treze")).toBe(
      true,
    );
  });
});

describe("decidirDoFluxo: sempre uma saída", () => {
  it("sem estado e sem gatilho: devolve para a IA", () => {
    const r = decidirDoFluxo(LAUDO, "acme/laudo", null, { texto: "quero comprar um sofá", agora: AGORA });
    // "quero comprar um sofá" é português, mas não é gatilho deste fluxo.
    expect(r).toEqual({ acao: "devolver", porque: "sem_gatilho" });
  });

  it("sem estado, mensagem vazia (mídia sem legenda): devolve", () => {
    const r = decidirDoFluxo(LAUDO, "acme/laudo", null, { texto: null, agora: AGORA });
    expect(r).toEqual({ acao: "devolver", porque: "mensagem_vazia" });
  });

  it("idioma fora da cobertura vai para a IA", () => {
    // Fluxo só cobre pt-BR/en; mensagem em espanhol não é com ele.
    const r = decidirDoFluxo(LAUDO, "acme/laudo", null, {
      texto: "hola, mi informe esta listo",
      agora: AGORA,
    });
    expect(r.acao).toBe("devolver");
  });

  it("gatilho começa o fluxo: assume e pergunta o primeiro campo", () => {
    const r = decidirDoFluxo(LAUDO, "acme/laudo", null, {
      texto: "meu laudo está pronto?",
      agora: AGORA,
    });
    expect(r.acao).toBe("perguntar");
    if (r.acao !== "perguntar") throw new Error("esperava perguntar");
    expect(r.porque).toBe("comecou");
    expect(r.texto).toBe("Qual é o tipo de exame?");
    expect(r.estado.etapa).toBe(0);
    expect(r.estado.campos).toEqual({});
  });

  it("no idioma inglês, pergunta em inglês", () => {
    const r = decidirDoFluxo(LAUDO, "acme/laudo", null, {
      texto: "hello, is my report ready",
      agora: AGORA,
    });
    expect(r.acao).toBe("perguntar");
    if (r.acao !== "perguntar") throw new Error("esperava perguntar");
    expect(r.texto).toBe("What type of exam is it?");
    expect(r.estado.idioma).toBe("en");
  });

  it("resposta avança a etapa e o campo vai para o estado", () => {
    const r = decidirDoFluxo(LAUDO, "acme/laudo", estadoEm(0), { texto: "Hemograma", agora: AGORA });
    expect(r.acao).toBe("perguntar");
    if (r.acao !== "perguntar") throw new Error("esperava perguntar");
    expect(r.porque).toBe("avancou");
    expect(r.estado.campos).toEqual({ "tipo-de-exame": "Hemograma" });
    expect(r.estado.etapa).toBe(1);
    expect(r.texto).toBe("Qual é o seu nome completo?");
  });

  it("última resposta PASSA para humano com os campos coletados", () => {
    const estado = estadoEm(2, { "tipo-de-exame": "Hemograma", nome: "Maria" });
    const r = decidirDoFluxo(LAUDO, "acme/laudo", estado, { texto: "12/10/2026", agora: AGORA });
    expect(r.acao).toBe("passar");
    if (r.acao !== "passar") throw new Error("esperava passar");
    expect(r.porque).toBe("coletou");
    expect(r.campos).toEqual({
      "tipo-de-exame": "Hemograma",
      nome: "Maria",
      data: "12/10/2026",
    });
    expect(r.aviso).toBe("Vou passar seu caso para a equipe conferir.");
  });

  it("⭐ mensagem fora do fluxo DEVOLVE a conversa para a IA (item 3)", () => {
    for (const texto of ["obrigado", "quanto custa?", "abrem sábado?"]) {
      const r = decidirDoFluxo(LAUDO, "acme/laudo", estadoEm(1, { "tipo-de-exame": "Hemograma" }), {
        texto,
        agora: AGORA,
      });
      expect(r, texto).toEqual({ acao: "devolver", porque: "fora_do_fluxo" });
    }
  });

  it("mídia sem texto no meio da coleta: repete a pergunta e conta turno sem progresso", () => {
    const r = decidirDoFluxo(LAUDO, "acme/laudo", estadoEm(1), { texto: null, agora: AGORA });
    expect(r.acao).toBe("perguntar");
    if (r.acao !== "perguntar") throw new Error("esperava perguntar");
    expect(r.porque).toBe("repetiu");
    expect(r.texto).toBe("Qual é o seu nome completo?");
    expect(r.estado.sem_progresso).toBe(1);
  });

  it("⭐ TETO de turnos sem progresso escala em vez de repetir para sempre", () => {
    const estado = { ...estadoEm(1), sem_progresso: 5 };
    const r = decidirDoFluxo(LAUDO, "acme/laudo", estado, { texto: null, agora: AGORA });
    expect(r.acao).toBe("passar");
    if (r.acao !== "passar") throw new Error("esperava passar");
    expect(r.porque).toBe("teto");
  });

  it("estado de OUTRO fluxo não é sequestrado por este", () => {
    const estado = { ...estadoEm(1), fluxo: "outro-fluxo" };
    const r = decidirDoFluxo(LAUDO, "acme/laudo", estado, { texto: "Maria", agora: AGORA });
    expect(r).toEqual({ acao: "devolver", porque: "sem_gatilho" });
  });

  it("estado de OUTRA extensão não é sequestrado por esta", () => {
    const estado = { ...estadoEm(1), extensao: "outra/loja" };
    const r = decidirDoFluxo(LAUDO, "acme/laudo", estado, { texto: "Maria", agora: AGORA });
    expect(r).toEqual({ acao: "devolver", porque: "sem_gatilho" });
  });

  it("não muta o estado recebido", () => {
    const estado = estadoEm(0);
    decidirDoFluxo(LAUDO, "acme/laudo", estado, { texto: "Hemograma", agora: AGORA });
    expect(estado).toEqual(estadoEm(0));
  });
});
