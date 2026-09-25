// @vitest-environment node
import { describe, expect, it } from "vitest";

import { textoDoCompromisso } from "@/lib/agenda/texto-do-compromisso";
import { meetingDeliveryBody } from "@/lib/agent-engine/agent/meet-delivery";

/**
 * O texto que chega ao cliente, com e sem reunião online.
 *
 * Recorte do PR #803, de @paulolimajr77.
 */
const EM = "2026-09-24T14:30:00.000Z";

describe("o texto do compromisso", () => {
  it("⛔ SEM link não fala de link — e é isso que permite mandar um presencial", () => {
    const texto = textoDoCompromisso({ startsAt: EM, timeZone: "America/Sao_Paulo", url: null, idioma: "pt-BR" });
    expect(texto).not.toMatch(/link/i);
    expect(texto).not.toMatch(/meet/i);
    expect(texto).toMatch(/compromisso/i);
    expect(texto).toContain("America/Sao_Paulo");
  });

  it("⛔ CONTROLE: COM link, o link continua saindo", () => {
    // Sem este par, uma função que apagasse o link sempre passaria no caso acima.
    const url = "https://meet.google.com/abc-defg-hij";
    const texto = textoDoCompromisso({ startsAt: EM, timeZone: "UTC", url, idioma: "pt-BR" });
    expect(texto).toContain(url);
    expect(texto).toMatch(/reunião/i);
  });

  it("formata no fuso do COMPROMISSO, não no do servidor", () => {
    const sp = textoDoCompromisso({ startsAt: EM, timeZone: "America/Sao_Paulo", url: null, idioma: "pt-BR" });
    const lisboa = textoDoCompromisso({ startsAt: EM, timeZone: "Europe/Lisbon", url: null, idioma: "pt-BR" });
    expect(sp).not.toBe(lisboa);
  });

  it("traduz para o idioma de quem recebe", () => {
    const es = textoDoCompromisso({ startsAt: EM, timeZone: "UTC", url: null, idioma: "es" });
    expect(es).toMatch(/compromiso/i);
  });

  it("⛔ REMARCADO diz que mudou, em vez de repetir a mesma frase com outra data", () => {
    // Mandar "está marcado para…" duas vezes, com datas diferentes e sem
    // explicação, é pior que o silêncio: a pessoa não sabe qual vale, e a
    // segunda parece erro do sistema.
    const texto = textoDoCompromisso({
      motivo: "remarcado",
      startsAt: EM,
      timeZone: "UTC",
      url: "https://meet.google.com/abc-defg-hij",
      idioma: "pt-BR",
    });
    expect(texto).toMatch(/mudou/i);
    expect(texto).not.toMatch(/está marcada para/i);
  });

  it("⛔ remarcação SEM link também diz que mudou, e segue sem falar de link", () => {
    const texto = textoDoCompromisso({
      motivo: "remarcado",
      startsAt: EM,
      timeZone: "UTC",
      url: null,
      idioma: "pt-BR",
    });
    expect(texto).toMatch(/mudou/i);
    expect(texto).not.toMatch(/link/i);
  });

  it("⛔ CONTROLE: sem motivo declarado, é o texto de sempre", () => {
    // O padrão tem de ser o comportamento ANTIGO: toda entrega que já estava na
    // fila quando isto entrou não declara motivo, e não pode virar "mudou".
    const texto = textoDoCompromisso({ startsAt: EM, timeZone: "UTC", url: null, idioma: "pt-BR" });
    expect(texto).not.toMatch(/mudou/i);
    expect(texto).toMatch(/está marcado para/i);
  });

  it("⛔ há UMA régua: `meetingDeliveryBody` delega em vez de repetir o molde", () => {
    // Duas réguas para o mesmo texto divergem na primeira mudança.
    const url = "https://meet.google.com/abc-defg-hij";
    expect(meetingDeliveryBody(EM, "UTC", url, "pt-BR")).toBe(
      textoDoCompromisso({ startsAt: EM, timeZone: "UTC", url, idioma: "pt-BR" }),
    );
  });
});
