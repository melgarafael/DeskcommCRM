/**
 * A SEMENTE DA SEMANA PINADA NA BORDA QUE ABRIU A #1350 — a virada que o fuso
 * faz em relação ao UTC.
 *
 * O defeito que a #1350 nomeia é exatamente esta borda: entre 21h e 00h de
 * sábado no fuso da organização (00:00Z–03:00Z de domingo em UTC), o servidor
 * que calculava a semana no relógio do PROCESSO (UTC, no contêiner) já tinha
 * virado domingo e desenhava a semana SEGUINTE — enquanto o usuário real, a
 * oeste de UTC (o Brasil inteiro), ainda estava no sábado. A tela saltava para
 * a semana certa só na hidratação.
 *
 * O conserto (PRs #1353 e #1386, já em `main`) fez a semana sair do fuso da
 * ORGANIZAÇÃO — decisão do dono do produto (2026-09-20, #1350) — via a função
 * pura `semanaSemente(agora, fuso)`, com o `agora` injetado em vez de um
 * `new Date()` cru.
 *
 * Teste puro: o `agora` é FIXO (um instante, nunca `new Date()`), então a
 * asserção é verde em qualquer dia e em qualquer fuso do runner. E o
 * discriminador é explícito: o MESMO instante que já é domingo em UTC ainda é
 * sábado no fuso da org, e a semente tem de devolver a semana desse sábado —
 * nunca a semana seguinte que o UTC entregaria.
 */
import { describe, expect, it } from "vitest";

import {
  diaDeHojeNoFuso,
  semanaSemente,
} from "@/lib/agenda/semana-semente";

// Domingo 00:00Z = sábado 21:00 no Brasil: a janela exata da issue #1350.
const BORDA = new Date("2026-09-20T00:00:00.000Z");

describe("semanaSemente na borda da #1350 (sábado à noite em SP, já domingo em UTC)", () => {
  it("no fuso da ORGANIZAÇÃO devolve a semana do sábado, não a seguinte", () => {
    const semana = semanaSemente(BORDA, "America/Sao_Paulo");

    // A semana que contém sábado 2026-09-19 começa no domingo 13/09.
    expect(semana.de.toISOString()).toBe("2026-09-13T03:00:00.000Z");
    // Fim exclusivo = o domingo seguinte (20/09 à meia-noite em SP).
    expect(semana.ate.toISOString()).toBe("2026-09-20T03:00:00.000Z");
  });

  it("o MESMO instante em UTC já é a semana seguinte — o discriminador", () => {
    const emUtc = semanaSemente(BORDA, "UTC");
    const naOrg = semanaSemente(BORDA, "America/Sao_Paulo");

    // Em UTC o relógio já virou domingo 20/09 e começou a semana 20–26.
    expect(emUtc.de.toISOString()).toBe("2026-09-20T00:00:00.000Z");

    // O fuso muda a semana: em UTC já é a seguinte; na org ainda é a do sábado.
    // Esta DESIGUALDADE é o que prova que a função lê o fuso pedido — sem ela,
    // um cálculo que ignorasse o `fuso` passaria verde.
    expect(naOrg.de.toISOString()).not.toBe(emUtc.de.toISOString());
  });

  it("diaDeHojeNoFuso na borda: a org ainda vê SÁBADO 19, UTC vê domingo 20", () => {
    expect(diaDeHojeNoFuso(BORDA, "America/Sao_Paulo")).toBe("2026-09-19");
    expect(diaDeHojeNoFuso(BORDA, "UTC")).toBe("2026-09-20");
  });
});