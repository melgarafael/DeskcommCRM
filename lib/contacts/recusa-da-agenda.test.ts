/**
 * O MOTIVO DA AGENDA NÃO LIDA, SEPARADO DO TEXTO DO PROVEDOR (#4102).
 *
 * O caso que motiva: número conectado e funcionando, `GET /api/contacts/all`
 * devolve 400 porque o store da sessão está desligado, e a tela dizia "o
 * WhatsApp não respondeu — confira se ele está conectado". A pessoa reconectou
 * o que já estava conectado.
 *
 * O que estes casos trancam: o 400 tem recusa própria (com o nome do botão da
 * tela de Conexões), os outros status continuam na frase da conexão, e a
 * decisão é pelo STATUS que o erro carrega — não pelo texto do corpo que o
 * provedor devolveu, nem por uma grafia do código de erro (que muda entre
 * builds). A doutrina de restrição de canal é o outro motivo: quem não é a
 * fronteira do canal não escreve o nome do transporte, e é por isso que o
 * status vem num CAMPO tipado (`ErroDaLeituraDaAgenda`).
 */
import { describe, expect, it } from "vitest";

import { ErroDaLeituraDaAgenda } from "@/lib/channels/erro-da-leitura-da-agenda";

import {
  MSG_ACERVO_DESLIGADO_NA_AGENDA,
  MSG_TRANSPORTE_SEM_RESPOSTA,
  recusaDaAgenda,
} from "./recusa-da-agenda";

/** O que o transporte lança de verdade: o status no campo e o código cru no texto. */
const erroDoTransporte = (status: number) =>
  new ErroDaLeituraDaAgenda(status, `leitura da agenda recusada: HTTP ${status}`);

describe("recusa da agenda do celular (#4102)", () => {
  it("o 400 aponta a opção 'Guardar o histórico', não a conexão", () => {
    const recusa = recusaDaAgenda(erroDoTransporte(400));

    expect(recusa.codigo).toBe("acervo_desligado");
    expect(recusa.mensagem).toBe(MSG_ACERVO_DESLIGADO_NA_AGENDA);
    expect(recusa.mensagem).toContain("Guardar o histórico anterior à vinculação");
    expect(recusa.mensagem).toContain("Conexões");
    expect(recusa.mensagem).not.toContain("não respondeu");
  });

  it("outros status do transporte continuam na frase da conexão", () => {
    for (const status of [403, 404, 500, 503]) {
      const recusa = recusaDaAgenda(erroDoTransporte(status));
      expect(recusa.codigo).toBe("transporte");
      expect(recusa.mensagem).toBe(MSG_TRANSPORTE_SEM_RESPOSTA);
    }
  });

  it("não confunde um status que só COMEÇA com 400 (4000) com o 400 medido", () => {
    expect(recusaDaAgenda(erroDoTransporte(4000)).codigo).toBe("transporte");
  });

  it("falha que NÃO é do transporte (texto cru, rede, teto) fica na frase da conexão", () => {
    for (const causa of ["fetch failed", "teto_de_tempo_estourado", new Error("sem status"), null, undefined]) {
      expect(recusaDaAgenda(causa).codigo).toBe("transporte");
    }
  });
});
