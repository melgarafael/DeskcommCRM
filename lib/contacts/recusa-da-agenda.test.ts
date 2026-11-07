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
 * decisão é pelo CÓDIGO (`waha_contacts_all_400`), não pelo texto do corpo que
 * o provedor devolveu.
 */
import { describe, expect, it } from "vitest";

import {
  MSG_ACERVO_DESLIGADO_NA_AGENDA,
  MSG_TRANSPORTE_SEM_RESPOSTA,
  recusaDaAgenda,
} from "./recusa-da-agenda";

describe("recusa da agenda do celular (#4102)", () => {
  it("'waha_contacts_all_400' aponta a opção 'Guardar o histórico', não a conexão", () => {
    const recusa = recusaDaAgenda(new Error("waha_contacts_all_400"));

    expect(recusa.codigo).toBe("acervo_desligado");
    expect(recusa.mensagem).toBe(MSG_ACERVO_DESLIGADO_NA_AGENDA);
    expect(recusa.mensagem).toContain("Guardar o histórico anterior à vinculação");
    expect(recusa.mensagem).toContain("Conexões");
    expect(recusa.mensagem).not.toContain("não respondeu");
  });

  it("outros status do transporte continuam na frase da conexão", () => {
    for (const causa of ["waha_contacts_all_403", "waha_contacts_all_500", "fetch failed", "teto_de_tempo"]) {
      const recusa = recusaDaAgenda(new Error(causa));
      expect(recusa.codigo).toBe("transporte");
      expect(recusa.mensagem).toBe(MSG_TRANSPORTE_SEM_RESPOSTA);
    }
  });

  it("não confunde um status que só COMEÇA com 400 (4000) com o 400 medido", () => {
    expect(recusaDaAgenda(new Error("waha_contacts_all_4000")).codigo).toBe("transporte");
  });

  it("aceita `unknown` do catch, sem exigir Error", () => {
    expect(recusaDaAgenda("waha_contacts_all_400").codigo).toBe("acervo_desligado");
    expect(recusaDaAgenda(null).codigo).toBe("transporte");
    expect(recusaDaAgenda(undefined).codigo).toBe("transporte");
  });
});
