import { describe, expect, it } from "vitest";

import {
  ESPERA_PELO_LINK_ATE_MIN,
  degrauDoDonoAgora,
  esperaPeloLink,
  linkDaReuniao,
  type LembreteJaReivindicado,
} from "./degraus-do-lembrete";

const H = 60 * 60_000;
const COMECA = new Date("2026-11-10T17:00:00.000Z"); // 14h em São Paulo
const MARCADO = new Date("2026-11-06T13:00:00.000Z");
const DEGRAUS = [1440, 60];

function degrau(agora: Date, ja: LembreteJaReivindicado[] = [], comeca = COMECA, marcadoEm: Date | null = MARCADO) {
  return degrauDoDonoAgora({ agora, comeca, degraus: DEGRAUS, marcadoEm, jaReivindicados: ja });
}

describe("linkDaReuniao", () => {
  it("Meet pronto com https devolve o link", () => {
    expect(
      linkDaReuniao({ location_kind: "google_meet", meeting_state: "ready", meeting_url: "https://meet.google.com/abc-defg-hij" }),
    ).toEqual({ estado: "pronto", url: "https://meet.google.com/abc-defg-hij" });
  });

  it("Meet pendente NÃO promete a URL, mesmo que a coluna tenha alguma", () => {
    expect(
      linkDaReuniao({ location_kind: "google_meet", meeting_state: "pending", meeting_url: "https://meet.google.com/x" }),
    ).toEqual({ estado: "pendente", url: null });
  });

  it("Meet que falhou ou foi cancelado fica indisponível", () => {
    expect(linkDaReuniao({ location_kind: "google_meet", meeting_state: "failed", meeting_url: null }).estado).toBe("indisponivel");
    expect(linkDaReuniao({ location_kind: "google_meet", meeting_state: "cancelled", meeting_url: null }).estado).toBe(
      "indisponivel",
    );
  });

  it("presencial não tem link; video_link com https é o próprio link", () => {
    expect(linkDaReuniao({ location_kind: "in_person", meeting_state: "not_requested", meeting_url: null })).toEqual({
      estado: "nao_e_meet",
      url: null,
    });
    expect(linkDaReuniao({ location_kind: "video_link", meeting_url: "https://zoom.us/j/1" })).toEqual({
      estado: "pronto",
      url: "https://zoom.us/j/1",
    });
  });

  it("URL sem https não vira link (nada de javascript: ou http cru na mensagem)", () => {
    expect(linkDaReuniao({ location_kind: "google_meet", meeting_state: "ready", meeting_url: "javascript:alert(1)" }).url).toBeNull();
  });
});

describe("esperaPeloLink", () => {
  const pendente = { estado: "pendente" as const, url: null };
  it("espera enquanto falta mais que o limite para começar", () => {
    expect(esperaPeloLink(pendente, COMECA, new Date(COMECA.getTime() - H))).toBe(true);
  });
  it(`a ${ESPERA_PELO_LINK_ATE_MIN} min do início sai mesmo sem link`, () => {
    expect(esperaPeloLink(pendente, COMECA, new Date(COMECA.getTime() - ESPERA_PELO_LINK_ATE_MIN * 60_000))).toBe(false);
  });
  it("link pronto ou presencial nunca espera", () => {
    expect(esperaPeloLink({ estado: "pronto", url: "https://meet.google.com/a" }, COMECA, MARCADO)).toBe(false);
    expect(esperaPeloLink({ estado: "nao_e_meet", url: null }, COMECA, MARCADO)).toBe(false);
  });
});

describe("degrauDoDonoAgora", () => {
  it("cedo demais: nenhum degrau", () => {
    expect(degrau(new Date(COMECA.getTime() - 25 * H))).toBeNull();
  });

  it("24 h antes sai o de 1 dia; 1 h antes sai o de 1 hora", () => {
    expect(degrau(new Date(COMECA.getTime() - 24 * H))).toBe(1440);
    expect(degrau(new Date(COMECA.getTime() - H))).toBe(60);
  });

  it("os dois vencidos juntos (cron parado) saem como UM: o mais próximo do início", () => {
    expect(degrau(new Date(COMECA.getTime() - 30 * 60_000))).toBe(60);
  });

  it("depois do início não sai nada", () => {
    expect(degrau(new Date(COMECA.getTime() + 60_000))).toBeNull();
  });

  it("marcada 3 h antes: a véspera venceu antes da marcação e não sai; a de 1 h sai", () => {
    const marcado = new Date(COMECA.getTime() - 3 * H);
    expect(degrau(new Date(COMECA.getTime() - 2 * H), [], COMECA, marcado)).toBeNull();
    expect(degrau(new Date(COMECA.getTime() - H), [], COMECA, marcado)).toBe(60);
  });

  it("depois de a véspera sair, a de 1 h continua saindo", () => {
    const ja = [{ degrau: 1440, inicio: COMECA.toISOString(), status: "enviado", enviadoEm: new Date(COMECA.getTime() - 24 * H).toISOString() }];
    expect(degrau(new Date(COMECA.getTime() - H), ja)).toBe(60);
  });

  it("remarcação 30 min para frente depois da véspera: NÃO manda outra véspera logo em seguida (anti-rajada)", () => {
    const enviadoEm = new Date(COMECA.getTime() - 24 * H);
    const ja = [{ degrau: 1440, inicio: COMECA.toISOString(), status: "enviado", enviadoEm: enviadoEm.toISOString() }];
    const novo = new Date(COMECA.getTime() + 30 * 60_000);
    expect(degrau(new Date(enviadoEm.getTime() + 31 * 60_000), ja, novo, enviadoEm)).toBeNull();
  });

  it("remarcação para outro dia: a data nova ganha a própria véspera", () => {
    const enviadoEm = new Date(COMECA.getTime() - 24 * H);
    const ja = [{ degrau: 1440, inicio: COMECA.toISOString(), status: "enviado", enviadoEm: enviadoEm.toISOString() }];
    const novo = new Date(COMECA.getTime() + 48 * H);
    const remarcadoEm = new Date(COMECA.getTime() - 20 * H);
    expect(degrau(new Date(novo.getTime() - 24 * H), ja, novo, remarcadoEm)).toBe(1440);
  });

  it("degrau inválido do tipo (zero, negativo, repetido) é ignorado", () => {
    expect(
      degrauDoDonoAgora({
        agora: new Date(COMECA.getTime() - H),
        comeca: COMECA,
        degraus: [0, -5, 60, 60],
        marcadoEm: MARCADO,
        jaReivindicados: [],
      }),
    ).toBe(60);
  });
});
