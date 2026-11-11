import { describe, expect, it } from "vitest";

import { lerPedidoDeAudio } from "@/lib/agent-engine/agent/pedido-de-audio";

/**
 * A RÉGUA DA LEITURA (#4345) — os quatro exemplos que o autor da issue deu
 * como critério de aceite, mais os casos que separam "fala do canal" de
 * "assunto do negócio".
 *
 * Cada `it` afirma um lado; nenhum deles olha a lista de palavras por dentro —
 * o que se mede aqui é a RESPOSTA da leitura para uma frase de cliente real.
 */
describe("lerPedidoDeAudio", () => {
  describe("pedido claro de áudio", () => {
    it("imperativo direto: 'me manda um áudio'", () => {
      expect(lerPedidoDeAudio("me manda um áudio")).toBe("audio");
    });

    it("pedido com educação: 'consegue me mandar por áudio?'", () => {
      expect(lerPedidoDeAudio("consegue me mandar por áudio?")).toBe("audio");
    });

    it("preferência declarada: 'prefiro áudio'", () => {
      expect(lerPedidoDeAudio("prefiro áudio")).toBe("audio");
    });

    it("sinônimo de nota de voz: 'me manda uma nota de voz'", () => {
      expect(lerPedidoDeAudio("me manda uma nota de voz")).toBe("audio");
    });

    it("sem acento (como o cliente digita): 'me manda um audio'", () => {
      expect(lerPedidoDeAudio("me manda um audio")).toBe("audio");
    });

    it("pedido no meio do turno: 'boa tarde, queria ouvir a resposta, pode ser?'", () => {
      expect(lerPedidoDeAudio("boa tarde, queria ouvir a resposta, pode ser?")).toBe("audio");
    });

    it("verbo de explicação também é pedido: 'me explica por áudio'", () => {
      expect(lerPedidoDeAudio("me explica por áudio")).toBe("audio");
    });

    it("gerúndio do mesmo pedido: 'consegue me responder falando?'", () => {
      expect(lerPedidoDeAudio("consegue me responder falando?")).toBe("audio");
    });
  });

  describe("quem diz que não consegue ler", () => {
    it("incapacidade sozinha já basta: 'não consigo ler'", () => {
      expect(lerPedidoDeAudio("não consigo ler")).toBe("audio");
    });

    it("incapacidade + pedido (o exemplo da issue): 'não consigo ler, me manda áudio'", () => {
      expect(lerPedidoDeAudio("não consigo ler, me manda áudio")).toBe("audio");
    });

    it("incapacidade sobre o MEIO, não sobre um documento: 'não consigo ler as mensagens'", () => {
      expect(lerPedidoDeAudio("não consigo ler as mensagens")).toBe("audio");
    });

    it("limitação de visão: 'tenho baixa visão, não enxergo o texto'", () => {
      expect(lerPedidoDeAudio("tenho baixa visão, não enxergo o texto")).toBe("audio");
    });
  });

  describe("o que NÃO conta como pedido", () => {
    it("incapacidade sobre um documento (o exemplo da issue): 'não consigo ler o boleto'", () => {
      expect(lerPedidoDeAudio("não consigo ler o boleto")).toBe("nenhum");
    });

    it("pergunta sobre o negócio (o exemplo da issue): 'grava áudio na sua clínica?'", () => {
      expect(lerPedidoDeAudio("grava áudio na sua clínica?")).toBe("nenhum");
    });

    it("áudio de OUTRA pessoa: 'o cliente mandou um áudio'", () => {
      expect(lerPedidoDeAudio("o cliente mandou um áudio")).toBe("nenhum");
    });

    it("assunto qualquer com a palavra áudio: 'o áudio do vídeo ficou ruim'", () => {
      expect(lerPedidoDeAudio("o áudio do vídeo ficou ruim")).toBe("nenhum");
    });

    it("texto vazio ou nulo não inventa pedido", () => {
      expect(lerPedidoDeAudio("")).toBe("nenhum");
      expect(lerPedidoDeAudio(null)).toBe("nenhum");
      expect(lerPedidoDeAudio(undefined)).toBe("nenhum");
    });
  });

  describe("quem pede para continuar no texto (volta ao texto)", () => {
    it("'pode escrever' (o exemplo da issue)", () => {
      expect(lerPedidoDeAudio("pode escrever")).toBe("texto");
    });

    it("'prefiro texto' (o exemplo da issue)", () => {
      expect(lerPedidoDeAudio("prefiro texto")).toBe("texto");
    });

    it("recusa explícita de áudio: 'não quero áudio'", () => {
      expect(lerPedidoDeAudio("não quero áudio")).toBe("texto");
    });

    it("quem não pode ouvir: 'não consigo ouvir, me responde por escrito'", () => {
      expect(lerPedidoDeAudio("não consigo ouvir, me responde por escrito")).toBe("texto");
    });

    it("a última instrução do turno vence: 'não consigo ler, mas prefiro texto'", () => {
      expect(lerPedidoDeAudio("não consigo ler, mas prefiro texto")).toBe("texto");
    });
  });
});
