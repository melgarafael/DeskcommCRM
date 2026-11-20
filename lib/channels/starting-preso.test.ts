import { describe, expect, it } from "vitest";

import {
  ESTADO_INICIAL_DO_VIGIA,
  INTERVALO_ENTRE_RESTARTS_MS,
  LIMITE_DE_RESTARTS,
  PRAZO_STARTING_MS,
  decidirStartingPreso,
  estadoParaMetadata,
  lerEstadoDoVigia,
  limitesDoStartingPreso,
  restartsEsgotados,
  startingPresoHa,
  type EstadoDoVigiaDeStarting,
} from "./starting-preso";

/**
 * A SESSÃO PRESA EM `STARTING` (#4870).
 *
 * O defeito medido: o número ficou dias sem receber mensagem, o espelho dizia
 * `STARTING`, e nada religava nem avisava. `deveRetomarSessao` só aceita
 * `STOPPED`, o vigia de restart era Fase 4 e `STATUS_QUE_AVISAM` deixa
 * `STARTING` de fora de propósito (é o estado normal de todo boot).
 *
 * O que estes casos prendem:
 *
 *   - `STARTING` recente é boot e NÃO se toca — o defeito não pode virar um
 *     vigia que reinicia toda sessão a cada reinício do WAHA;
 *   - `STARTING` acima do prazo reinicia UMA vez, respeita o intervalo e PARA no
 *     limite (insistir num número que pode estar banido é o erro que o repo já
 *     recusa para `FAILED`);
 *   - sessão CONECTADA (`WORKING`) nunca é reiniciada por este caminho;
 *   - prazo, intervalo e limite são os MESMOS para o vigia e para o aviso.
 */
const AGORA = Date.parse("2026-11-17T15:00:00Z");
const minutos = (n: number) => n * 60_000;

const estado = (parcial: Partial<EstadoDoVigiaDeStarting> = {}): EstadoDoVigiaDeStarting => ({
  ...ESTADO_INICIAL_DO_VIGIA,
  ...parcial,
});

describe("os três números moram num lugar só", () => {
  it("os defaults são conservadores e explícitos", () => {
    expect(PRAZO_STARTING_MS).toBe(5 * 60_000);
    expect(INTERVALO_ENTRE_RESTARTS_MS).toBe(5 * 60_000);
    expect(LIMITE_DE_RESTARTS).toBe(3);
    expect(limitesDoStartingPreso({})).toEqual({
      prazoMs: PRAZO_STARTING_MS,
      intervaloMs: INTERVALO_ENTRE_RESTARTS_MS,
      limite: LIMITE_DE_RESTARTS,
    });
  });

  it("a configuração entra por ambiente", () => {
    expect(
      limitesDoStartingPreso({
        WHATSAPP_STARTING_PRAZO_MS: "90000",
        WHATSAPP_STARTING_INTERVALO_MS: "30000",
        WHATSAPP_STARTING_LIMITE: "1",
      }),
    ).toEqual({ prazoMs: 90_000, intervaloMs: 30_000, limite: 1 });
  });

  it("env torto não derruba o vigia: cai no default", () => {
    expect(
      limitesDoStartingPreso({
        WHATSAPP_STARTING_PRAZO_MS: "cinco minutos",
        WHATSAPP_STARTING_INTERVALO_MS: "-1",
        WHATSAPP_STARTING_LIMITE: "0",
      }),
    ).toEqual({
      prazoMs: PRAZO_STARTING_MS,
      intervaloMs: INTERVALO_ENTRE_RESTARTS_MS,
      limite: LIMITE_DE_RESTARTS,
    });
  });

  it("o aviso de saúde usa o MESMO prazo configurado", () => {
    // Sem isto, `WHATSAPP_STARTING_PRAZO_MS` mudaria o vigia e o aviso seguiria
    // gritando (ou calado) no prazo de fábrica: duas verdades sobre o mesmo
    // relógio.
    expect(startingPresoHa(minutos(2), minutos(5))).toBe(false);
    expect(startingPresoHa(minutos(5), minutos(5))).toBe(true);
    expect(startingPresoHa(minutos(3), minutos(2))).toBe(true);
  });

  it("sem carimbo ninguém é acusado", () => {
    expect(startingPresoHa(null)).toBe(false);
    expect(startingPresoHa(undefined)).toBe(false);
    expect(startingPresoHa(Number.NaN)).toBe(false);
    expect(startingPresoHa(-1)).toBe(false);
  });
});

describe("a decisão do vigia", () => {
  it("⭐ STARTING dentro do prazo é boot: NÃO reinicia", () => {
    expect(
      decidirStartingPreso({ status: "STARTING", msNoStatus: minutos(1), estado: estado(), agoraMs: AGORA }),
    ).toEqual({ acao: "aguardar", motivo: "dentro_do_prazo" });
  });

  it("⭐ sessão CONECTADA nunca sofre restart", () => {
    expect(
      decidirStartingPreso({ status: "WORKING", msNoStatus: minutos(600), estado: estado(), agoraMs: AGORA }),
    ).toEqual({ acao: "aguardar", motivo: "fora_do_starting" });
  });

  it("STOPPED e FAILED seguem com as regras que já existiam", () => {
    for (const status of ["STOPPED", "FAILED", "SCAN_QR_CODE"]) {
      expect(
        decidirStartingPreso({ status, msNoStatus: minutos(600), estado: estado(), agoraMs: AGORA }),
        status,
      ).toEqual({ acao: "aguardar", motivo: "fora_do_starting" });
    }
  });

  it("⭐ STARTING acima do prazo: reinicia, contando a tentativa", () => {
    expect(
      decidirStartingPreso({ status: "starting", msNoStatus: minutos(6), estado: estado(), agoraMs: AGORA }),
    ).toEqual({ acao: "reiniciar", tentativas: 1 });
  });

  it("respeita o intervalo entre duas tentativas", () => {
    const logoDepois = estado({ tentativas: 1, ultimoRestartEm: AGORA - minutos(1) });
    expect(
      decidirStartingPreso({ status: "STARTING", msNoStatus: minutos(7), estado: logoDepois, agoraMs: AGORA }),
    ).toEqual({ acao: "aguardar", motivo: "intervalo" });

    expect(
      decidirStartingPreso({
        status: "STARTING",
        msNoStatus: minutos(12),
        estado: logoDepois,
        agoraMs: AGORA + minutos(5),
      }),
    ).toEqual({ acao: "reiniciar", tentativas: 2 });
  });

  it("⭐ no limite, para de tentar e avisa UMA vez", () => {
    const esgotadoPelaPrimeiraVez = estado({
      tentativas: LIMITE_DE_RESTARTS,
      ultimoRestartEm: AGORA - minutos(6),
    });
    expect(
      decidirStartingPreso({
        status: "STARTING",
        msNoStatus: minutos(30),
        estado: esgotadoPelaPrimeiraVez,
        agoraMs: AGORA,
      }),
    ).toEqual({ acao: "esgotado", tentativas: LIMITE_DE_RESTARTS, avisarAgora: true });

    // O aviso já saiu: a Central não recebe o mesmo crítico a cada tick.
    expect(
      decidirStartingPreso({
        status: "STARTING",
        msNoStatus: minutos(40),
        estado: { ...esgotadoPelaPrimeiraVez, esgotado: true },
        agoraMs: AGORA + minutos(10),
      }),
    ).toEqual({ acao: "esgotado", tentativas: LIMITE_DE_RESTARTS, avisarAgora: false });
  });

  it("não declara esgotamento antes de dar à última tentativa a mesma janela de boot", () => {
    // Terceiro restart há um minuto: ainda é cedo para dizer que não voltou.
    const acabouDeTentar = estado({ tentativas: LIMITE_DE_RESTARTS, ultimoRestartEm: AGORA - minutos(1) });
    expect(
      decidirStartingPreso({
        status: "STARTING",
        msNoStatus: minutos(20),
        estado: acabouDeTentar,
        agoraMs: AGORA,
      }),
    ).toEqual({ acao: "aguardar", motivo: "intervalo" });
  });

  it("o limite e o intervalo vêm da configuração", () => {
    const limites = { prazoMs: minutos(1), intervaloMs: minutos(1), limite: 1 };
    expect(
      decidirStartingPreso({
        status: "STARTING",
        msNoStatus: minutos(2),
        estado: estado(),
        agoraMs: AGORA,
        limites,
      }),
    ).toEqual({ acao: "reiniciar", tentativas: 1 });
    expect(
      decidirStartingPreso({
        status: "STARTING",
        msNoStatus: minutos(3),
        estado: estado({ tentativas: 1, ultimoRestartEm: AGORA - minutos(2) }),
        agoraMs: AGORA,
        limites,
      }),
    ).toEqual({ acao: "esgotado", tentativas: 1, avisarAgora: true });
  });
});

describe("o contador em metadata", () => {
  it("volta do metadata na mesma forma que foi gravado", () => {
    const gravado = { tentativas: 2, ultimoRestartEm: AGORA, esgotado: false };
    const lido = lerEstadoDoVigia({ vigia_starting: estadoParaMetadata(gravado), ai_gate: "allowlist" });
    expect(lido).toEqual(gravado);
  });

  it("metadata sem a chave, ou com lixo, é episódio novo", () => {
    expect(lerEstadoDoVigia(null)).toEqual(ESTADO_INICIAL_DO_VIGIA);
    expect(lerEstadoDoVigia({ ai_gate: "allowlist" })).toEqual(ESTADO_INICIAL_DO_VIGIA);
    expect(lerEstadoDoVigia({ vigia_starting: "oi" })).toEqual(ESTADO_INICIAL_DO_VIGIA);
    expect(lerEstadoDoVigia({ vigia_starting: { tentativas: -3, ultimo_restart_em: "ontem" } })).toEqual(
      ESTADO_INICIAL_DO_VIGIA,
    );
  });

  it("o aviso lê o esgotamento da MESMA chave", () => {
    expect(restartsEsgotados({ vigia_starting: { tentativas: 3, esgotado: true } })).toBe(true);
    expect(restartsEsgotados({ vigia_starting: { tentativas: 1, esgotado: false } })).toBe(false);
    expect(restartsEsgotados(undefined)).toBe(false);
  });
});
