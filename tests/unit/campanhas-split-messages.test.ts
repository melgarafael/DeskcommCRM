/**
 * Campanha de texto em balões (migration 0765, PR #3329 de @imcempreendimentos).
 *
 * Importa o código de produção (`lib/campanhas/baloes.ts`), que é o MESMO
 * caminho da rodada e do envio de teste: divisão, teto de balões, um
 * `recordSend` por balão e parada no primeiro balão que falha.
 */
import { describe, expect, it, vi } from "vitest";

import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import {
  MAX_BALOES_POR_DESTINATARIO,
  baloesDaCampanha,
  enviarEmBaloes,
  pausaEntreBaloes,
} from "@/lib/campanhas/baloes";
import { editarCampanhaSchema } from "@/lib/campanhas/schemas";
import type { Message } from "@/lib/types/messaging";

type Envio = Pick<Message, "id" | "status" | "error_code" | "error_message">;

const envio = (id: string, status: string): Envio => ({ id, status, error_code: null, error_message: null });

describe("baloesDaCampanha", () => {
  const texto = "Oi, Ana!\n\nChegou a coleção nova.\n\nQuer ver?";

  it("desligada, sai um balão só com o corpo intacto", () => {
    expect(baloesDaCampanha(texto, false)).toEqual([texto]);
  });

  it("ligada, um balão por parágrafo", () => {
    expect(baloesDaCampanha(texto, true)).toEqual(["Oi, Ana!", "Chegou a coleção nova.", "Quer ver?"]);
  });

  it(`passa de ${MAX_BALOES_POR_DESTINATARIO} parágrafos: o resto vai junto no último, sem perder texto`, () => {
    const cinco = "A\n\nB\n\nC\n\nD\n\nE";
    const baloes = baloesDaCampanha(cinco, true);
    expect(baloes).toHaveLength(MAX_BALOES_POR_DESTINATARIO);
    expect(baloes).toEqual(["A", "B", "C\n\nD\n\nE"]);
  });

  it("parágrafo longo não é picotado: a campanha divide só por parágrafo", () => {
    const longo = "palavra ".repeat(200).trim();
    expect(baloesDaCampanha(longo, true)).toEqual([longo]);
  });

  it("corpo vazio ligado ainda devolve um balão (o canal decide)", () => {
    expect(baloesDaCampanha("", true)).toEqual([""]);
  });
});

describe("enviarEmBaloes", () => {
  it("cada balão enviado conta um recordSend, e a pausa só entre balões", async () => {
    const enviar = vi.fn<(corpo: string, indice: number) => Promise<Envio>>(async (_c, i) => envio(`m${i}`, "sent"));
    const registrar = vi.fn<() => Promise<void>>(async () => {});
    const esperar = vi.fn<() => Promise<void>>(async () => {});

    const r = await enviarEmBaloes(["A", "B", "C"], { enviar, registrar, esperar });

    expect(enviar.mock.calls.map(([c]) => c)).toEqual(["A", "B", "C"]);
    expect(registrar).toHaveBeenCalledTimes(3);
    expect(esperar).toHaveBeenCalledTimes(2);
    expect(r.primeira.id).toBe("m0");
    expect(r.desfecho.status).toBe("sent");
  });

  it("para no primeiro balão que falha, e ele vira o desfecho do destinatário", async () => {
    const enviar = vi.fn<(corpo: string, indice: number) => Promise<Envio>>(async (_c, i) =>
      envio(`m${i}`, i === 1 ? "failed" : "sent"),
    );
    const registrar = vi.fn<() => Promise<void>>(async () => {});

    const r = await enviarEmBaloes(["A", "B", "C"], { enviar, registrar, esperar: async () => {} });

    expect(enviar).toHaveBeenCalledTimes(2);
    expect(registrar).toHaveBeenCalledTimes(2);
    expect(r.desfecho.status).toBe("failed");
    expect(r.indiceDoDesfecho).toBe(1);
    expect(r.primeira.id).toBe("m0");
  });

  it("um balão só: um envio, um recordSend, nenhuma pausa", async () => {
    const registrar = vi.fn<() => Promise<void>>(async () => {});
    const esperar = vi.fn<() => Promise<void>>(async () => {});
    const r = await enviarEmBaloes(["só"], { enviar: async () => envio("m0", "sent"), registrar, esperar });
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(esperar).not.toHaveBeenCalled();
    expect(r.indiceDoDesfecho).toBe(0);
  });
});

describe("pausaEntreBaloes", () => {
  it("fica no ritmo anti-ban do número (throttle + jitter), não no intervalo da campanha", () => {
    expect(pausaEntreBaloes(PACING_DEFAULTS, () => 0)).toBe(PACING_DEFAULTS.throttleMs);
    const maxima = pausaEntreBaloes(PACING_DEFAULTS, () => 0.999);
    expect(maxima).toBeLessThan(PACING_DEFAULTS.throttleMs + PACING_DEFAULTS.jitterMaxMs);
  });
});

describe("editarCampanhaSchema", () => {
  it("aceita split_messages booleano e recusa o resto", () => {
    expect(editarCampanhaSchema.safeParse({ split_messages: true }).success).toBe(true);
    expect(editarCampanhaSchema.safeParse({ split_messages: false }).success).toBe(true);
    expect(editarCampanhaSchema.safeParse({ split_messages: "sim" }).success).toBe(false);
    expect(editarCampanhaSchema.safeParse({ split_messages: null }).success).toBe(false);
  });
});
