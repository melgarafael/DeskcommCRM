import { describe, expect, it } from "vitest";

import {
  lerPedidoDeAudio,
  textosDoClienteNoHistorico,
  type MensagemDoHistorico,
} from "@/lib/agent-engine/agent/pedido-de-audio";

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

  /**
   * AS NOVE FRASES DO MANTENEDOR (comentário de 12/11 05:54Z) — os dois sentidos
   * do erro, frase por frase, com o veredito escrito ao lado.
   *
   * Cada caso é o contrato: nenhum pode ser afrouxado para passar. As quatro
   * primeiras falhavam por não virar áudio, as quatro do meio por virar áudio
   * sem pedido, e a última por não voltar ao texto.
   */
  describe("as frases medidas pelo mantenedor (12/11)", () => {
    describe("deveria virar áudio e não virava", () => {
      it("'manda um audiozinho' ⇒ áudio (o diminutivo é o mesmo pedido)", () => {
        expect(lerPedidoDeAudio("manda um audiozinho")).toBe("audio");
      });

      it("'fala comigo por áudio' ⇒ áudio (o verbo é 'falar', não 'mandar')", () => {
        expect(lerPedidoDeAudio("fala comigo por áudio")).toBe("audio");
      });

      it("'sou analfabeto' ⇒ áudio (a limitação é de leitura, sem o verbo 'ler')", () => {
        expect(lerPedidoDeAudio("sou analfabeto")).toBe("audio");
      });

      it("'não consigo ler essa letra pequena' ⇒ áudio (o objeto é o tamanho da letra, não um documento)", () => {
        expect(lerPedidoDeAudio("não consigo ler essa letra pequena")).toBe("audio");
      });
    });

    describe("virava áudio sem ter pedido", () => {
      it("'vou te mandar um áudio' ⇒ nenhum (o áudio é o que ELE vai mandar)", () => {
        expect(lerPedidoDeAudio("vou te mandar um áudio")).toBe("nenhum");
      });

      it("'posso mandar um áudio?' ⇒ nenhum (pergunta permissão para ELE mandar)", () => {
        expect(lerPedidoDeAudio("posso mandar um áudio?")).toBe("nenhum");
      });

      it("'consegue ouvir meu áudio?' ⇒ nenhum (pergunta se o áudio dele chegou)", () => {
        expect(lerPedidoDeAudio("consegue ouvir meu áudio?")).toBe("nenhum");
      });

      it("'quero marcar consulta pra ouvir o resultado do exame' ⇒ nenhum (o 'ouvir' é do exame)", () => {
        expect(lerPedidoDeAudio("quero marcar consulta pra ouvir o resultado do exame")).toBe("nenhum");
      });
    });

    describe("deveria voltar ao texto e não voltava", () => {
      it("'não estou conseguindo ouvir agora, escreve' ⇒ texto (recusa de agora + imperativo do texto)", () => {
        expect(lerPedidoDeAudio("não estou conseguindo ouvir agora, escreve")).toBe("texto");
      });
    });
  });

  /**
   * A CONVERSA, não a frase: a lista de textos do cliente, do mais antigo ao
   * mais recente, como o turno a monta a partir do histórico que já carregou.
   */
  describe("a conversa inteira (#4345)", () => {
    it("pedido de áudio feito duas mensagens atrás continua valendo no turno de agora", () => {
      const historico: MensagemDoHistorico[] = [
        { direction: "inbound", body: "oi, boa tarde" },
        { direction: "inbound", body: "não sei ler, manda áudio" },
        { direction: "outbound", body: "Claro! Te mando por áudio." },
        { direction: "inbound", body: "e quanto custa?" },
      ];
      const textos = textosDoClienteNoHistorico(historico, "e quanto custa?");
      expect(textos).toEqual(["oi, boa tarde", "não sei ler, manda áudio", "e quanto custa?"]);
      expect(lerPedidoDeAudio(textos)).toBe("audio");
    });

    it("'prefiro texto' DEPOIS do pedido derruba o pedido e volta ao texto", () => {
      const historico: MensagemDoHistorico[] = [
        { direction: "inbound", body: "não sei ler, manda áudio" },
        { direction: "outbound", body: "Te mando por áudio." },
        { direction: "inbound", body: "pensando bem, prefiro texto" },
      ];
      expect(lerPedidoDeAudio(textosDoClienteNoHistorico(historico, "pensando bem, prefiro texto"))).toBe(
        "texto",
      );
    });

    it("o turno de agora que não está no histórico entra como o mais recente", () => {
      const historico: MensagemDoHistorico[] = [{ direction: "inbound", body: "não sei ler, manda áudio" }];
      expect(textosDoClienteNoHistorico(historico, "e quanto custa?")).toEqual([
        "não sei ler, manda áudio",
        "e quanto custa?",
      ]);
    });

    it("a mesma mensagem não é contada duas vezes quando já é a última do histórico", () => {
      const historico: MensagemDoHistorico[] = [{ direction: "inbound", body: "e quanto custa?" }];
      expect(textosDoClienteNoHistorico(historico, "e quanto custa?")).toEqual(["e quanto custa?"]);
    });

    it("só as mensagens do cliente entram, e a janela corta as mais antigas", () => {
      const historico: MensagemDoHistorico[] = [
        { direction: "inbound", body: "primeira" },
        { direction: "outbound", body: "resposta da loja" },
        { direction: "inbound", body: "segunda" },
      ];
      expect(textosDoClienteNoHistorico(historico, null, 1)).toEqual(["segunda"]);
    });
  });
});
