import { describe, expect, it } from "vitest";

import {
  aJanelaRegulatoriaSeAplica,
  canalAceitaTextoLivreAgora,
  estadoDaJanela,
} from "./janela";

/**
 * A JANELA DE 24 H É DE ALGUNS CANAIS, NÃO DE "WHATSAPP".
 *
 * A pergunta do escopo nasceu de um defeito medido (#4913): follow-up ativo
 * numa conexão por QR, o histórico dizendo "a janela estava fechada" e o
 * operador procurando a janela da API oficial num número que nem está na aba
 * API Oficial. A régua daqui é a CAPACIDADE do canal; o nome do provedor é
 * detalhe de transporte e muda.
 */

const AGORA = new Date("2026-11-18T15:00:00.000Z");
const HORA = 3_600_000;
const haHoras = (h: number) => new Date(AGORA.getTime() - h * HORA).toISOString();

describe("aJanelaRegulatoriaSeAplica — o escopo vem da capacidade do canal", () => {
  it("conexão por QR (auto-restrição) NÃO tem janela regulatória", () => {
    expect(aJanelaRegulatoriaSeAplica("waha")).toBe(false);
  });

  it("API oficial e os parceiros que espelham a Cloud API TÊM janela", () => {
    for (const provider of ["meta_cloud", "zernio", "datafy"]) {
      expect(aJanelaRegulatoriaSeAplica(provider)).toBe(true);
    }
  });

  it("rede social (que só fala com quem escreveu) TAMBÉM tem janela", () => {
    expect(aJanelaRegulatoriaSeAplica("zernio_social")).toBe(true);
  });

  it("canal de voz não é canal de mensagem: não há janela a aplicar", () => {
    expect(aJanelaRegulatoriaSeAplica("wacalls")).toBe(false);
  });

  it("provider ausente ou desconhecido não herda a janela de ninguém", () => {
    // Falha ABERTA, a mesma de `canalAceitaTextoLivreAgora`: barrar por uma
    // regra que não está MEDIDA puniria um canal que talvez envie. Um provider
    // novo (imagem mais velha que o schema, ou o contrário) não pode virar
    // "oficial" por não constar de uma lista de exceções.
    for (const provider of [null, undefined, "", "provedor_novo_qualquer"]) {
      expect(aJanelaRegulatoriaSeAplica(provider)).toBe(false);
    }
  });

  it("a decisão é por CAPACIDADE, não por semelhança de nome", () => {
    // Um nome que "parece oficial" não basta, e o nome do QR não é exceção
    // escrita à mão: quem responde é a matriz de `capabilities.ts`.
    expect(aJanelaRegulatoriaSeAplica("whatsapp")).toBe(false);
    expect(aJanelaRegulatoriaSeAplica("meta")).toBe(false);
  });
});

describe("canalAceitaTextoLivreAgora — o lado de QUEM ENVIA", () => {
  it("QR com a última mensagem do cliente há 30 h continua aceitando texto livre", () => {
    expect(canalAceitaTextoLivreAgora("waha", haHoras(30), AGORA)).toBe(true);
  });

  it("QR que nunca recebeu mensagem do cliente continua aceitando", () => {
    expect(canalAceitaTextoLivreAgora("waha", null, AGORA)).toBe(true);
  });

  it("oficial com a última mensagem há 30 h RECUSA texto livre", () => {
    expect(canalAceitaTextoLivreAgora("meta_cloud", haHoras(30), AGORA)).toBe(false);
  });

  it("oficial dentro das 24 h aceita", () => {
    expect(canalAceitaTextoLivreAgora("meta_cloud", haHoras(2), AGORA)).toBe(true);
  });

  it("oficial que nunca recebeu mensagem do cliente recusa (sem janela aberta)", () => {
    expect(canalAceitaTextoLivreAgora("meta_cloud", null, AGORA)).toBe(false);
  });
});

describe("estadoDaJanela — o relógio da tela segue a mesma régua", () => {
  it("QR não mostra relógio: sem restrição", () => {
    expect(estadoDaJanela("waha", haHoras(30), AGORA)).toEqual({ tipo: "sem_restricao" });
  });

  it("oficial com janela estourada mostra fechada e há quanto tempo", () => {
    const estado = estadoDaJanela("meta_cloud", haHoras(30), AGORA);
    expect(estado.tipo).toBe("fechada");
    if (estado.tipo === "fechada") expect(estado.fechadaHaMs).toBe(6 * HORA);
  });

  it("oficial dentro das 24 h mostra aberta com o restante", () => {
    const estado = estadoDaJanela("meta_cloud", haHoras(2), AGORA);
    expect(estado).toEqual({ tipo: "aberta", restanteMs: 22 * HORA });
  });
});
