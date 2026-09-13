import { describe, expect, it } from "vitest";

import { textoDaEntrega } from "@/lib/agenda/texto-do-compromisso";

/**
 * O texto que chega ao cliente precisa dizer O QUE ACONTECEU.
 *
 * Hoje a frase é sempre "Sua reunião está marcada para…". Receber isso DUAS
 * VEZES, com datas diferentes e sem explicação, é pior que o silêncio: a pessoa
 * não sabe qual das duas vale, e a segunda mensagem parece um erro do sistema.
 */
const BASE = {
  startsAt: "2026-09-24T12:30:00.000Z",
  timeZone: "America/Sao_Paulo",
  url: "https://meet.google.com/abc-defg-hij",
  idioma: "pt-BR" as const,
};

describe("o texto da entrega diz o que aconteceu", () => {
  it("primeiro envio: a frase de sempre", () => {
    const t = textoDaEntrega({ ...BASE, motivo: "primeiro_envio" });
    expect(t).toMatch(/está marcada para/i);
    expect(t).not.toMatch(/mudou/i);
  });

  it("⛔ remarcado: diz que MUDOU, e dá o horário novo", () => {
    const t = textoDaEntrega({ ...BASE, motivo: "remarcado" });
    expect(t).toMatch(/mudou/i);
    expect(t).toMatch(/24\/09/);
  });

  it("⛔ os dois formatam no fuso do COMPROMISSO, não no do servidor", () => {
    // 12:30 UTC é 09:30 em São Paulo. O molde antigo acertava isto, e perder o
    // acerto ao criar a variação seria trocar um defeito por outro.
    for (const motivo of ["primeiro_envio", "remarcado"] as const) {
      expect(textoDaEntrega({ ...BASE, motivo })).toMatch(/09:30/);
    }
  });

  it("⛔ e traduzem para o idioma de quem LÊ, não o de quem marcou", () => {
    const t = textoDaEntrega({ ...BASE, idioma: "es", motivo: "primeiro_envio" });
    expect(t).not.toMatch(/está marcada para/i);
  });

  it("compromisso sem link não inventa link", () => {
    const t = textoDaEntrega({ ...BASE, url: null, motivo: "remarcado" });
    expect(t).not.toMatch(/meet\.google\.com/);
    expect(t).toMatch(/mudou/i);
  });

  it("CONTROLE: reenvio manual usa a frase do primeiro envio", () => {
    // Quem clica "Enviar de novo" quer que o cliente receba os dados — não um
    // aviso de mudança que pode não ter havido.
    expect(textoDaEntrega({ ...BASE, motivo: "reenvio_manual" })).toMatch(/está marcada para/i);
  });
});
