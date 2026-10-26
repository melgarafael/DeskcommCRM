import { describe, expect, it } from "vitest";

import {
  MAXIMO_DE_PARTES,
  PISO_DO_AGENDAMENTO_MS,
  TETO_DO_CORPO,
  desfechoDasPartes,
  esperaDaTentativa,
  podeCancelar,
  podeEditar,
  validaAgendamento,
  vereditoDoDisparo,
  type FatosDoDisparo,
} from "./regras";

const AGORA = new Date("2026-10-26T12:00:00.000Z");
const DAQUI_A_UMA_HORA = new Date(AGORA.getTime() + 3_600_000).toISOString();

function base(over: Record<string, unknown> = {}) {
  return {
    conversation_id: "conv-1",
    scheduled_for: DAQUI_A_UMA_HORA,
    parts: [{ body: "oi" }],
    ...over,
  };
}

describe("validaAgendamento", () => {
  it("aceita o caso normal e numera as partes a partir de 0", () => {
    const r = validaAgendamento(
      base({ parts: [{ body: " um " }, { body: "dois" }, { media_storage_path: "org/c/a.jpg" }] }),
      AGORA,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.partes.map((p) => p.position)).toEqual([0, 1, 2]);
    expect(r.partes[0]?.body).toBe("um");
    expect(r.cancelarSeResponder).toBe(false);
    expect(r.tz).toBe("UTC");
  });

  it("recusa sem conversa nem contato", () => {
    const r = validaAgendamento(base({ conversation_id: null }), AGORA);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("sem_conversa");
  });

  it("recusa instante no passado e instante a menos de 30 s", () => {
    const passado = validaAgendamento(
      base({ scheduled_for: new Date(AGORA.getTime() - 1).toISOString() }),
      AGORA,
    );
    expect(passado.ok).toBe(false);
    if (!passado.ok) expect(passado.codigo).toBe("instante_no_passado");

    const quase = validaAgendamento(
      base({ scheduled_for: new Date(AGORA.getTime() + PISO_DO_AGENDAMENTO_MS - 1).toISOString() }),
      AGORA,
    );
    expect(quase.ok).toBe(false);
  });

  it("recusa instante inválido, ISO sem fuso relativo e data de um ano à frente", () => {
    for (const scheduled_for of [
      "amanhã",
      new Date(AGORA.getTime() + 366 * 24 * 3_600_000).toISOString(),
    ]) {
      const r = validaAgendamento(base({ scheduled_for }), AGORA);
      expect(r.ok).toBe(false);
    }
  });

  it("recusa fuso que o Intl não conhece", () => {
    const r = validaAgendamento(base({ tz: "Marte/Olympus" }), AGORA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("fuso_invalido");
  });

  it(`recusa mais de ${MAXIMO_DE_PARTES} partes`, () => {
    const partes = Array.from({ length: MAXIMO_DE_PARTES + 1 }, () => ({ body: "x" }));
    const r = validaAgendamento(base({ parts: partes }), AGORA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("partes_demais");
  });

  it(`recusa corpo acima de ${TETO_DO_CORPO} e parte sem texto nem anexo`, () => {
    const longo = validaAgendamento(base({ parts: [{ body: "a".repeat(TETO_DO_CORPO + 1) }] }), AGORA);
    expect(longo.ok).toBe(false);
    if (!longo.ok) expect(longo.codigo).toBe("corpo_longo_demais");

    const vazia = validaAgendamento(base({ parts: [{ body: "   " }] }), AGORA);
    expect(vazia.ok).toBe(false);
    if (!vazia.ok) expect(vazia.codigo).toBe("parte_vazia");
  });

  it("aceita exatamente o teto do corpo (o limite é do canal)", () => {
    const r = validaAgendamento(base({ parts: [{ body: "a".repeat(TETO_DO_CORPO) }] }), AGORA);
    expect(r.ok).toBe(true);
  });
});

describe("as réguas compartilhadas", () => {
  it("só pacote `scheduled` pode ser cancelado ou editado", () => {
    expect(podeCancelar("scheduled")).toBe(true);
    expect(podeEditar("scheduled")).toBe(true);
    for (const status of ["sending", "sent", "partial", "failed", "cancelled"] as const) {
      expect(podeCancelar(status)).toBe(false);
      expect(podeEditar(status)).toBe(false);
    }
  });

  it("desfecho: todas sent → sent; nenhuma → failed; meio → partial", () => {
    expect(desfechoDasPartes([{ status: "sent" }, { status: "sent" }])).toBe("sent");
    expect(desfechoDasPartes([{ status: "failed" }, { status: "skipped" }])).toBe("failed");
    expect(desfechoDasPartes([{ status: "sent" }, { status: "skipped" }])).toBe("partial");
  });

  it("backoff cresce e para nos 30 min", () => {
    expect([1, 2, 3, 4, 5].map(esperaDaTentativa)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000,
    ]);
    expect(esperaDaTentativa(9)).toBe(30 * 60_000);
  });
});

describe("vereditoDoDisparo", () => {
  const ok: FatosDoDisparo = {
    organizacaoOperante: true,
    contatoBloqueado: false,
    contatoAnonimizado: false,
    canalArquivado: false,
    sessaoEmDia: true,
    contatoRespondeu: false,
    janelaReabreEm: null,
  };
  const semMarca = { cancelarSeResponder: false };

  it("nada impedindo: envia", () => {
    expect(vereditoDoDisparo(ok, semMarca, AGORA)).toEqual({ acao: "enviar" });
  });

  it("a ORDEM: opt-out vence janela, e janela vence sessão", () => {
    const bloqueado = vereditoDoDisparo(
      { ...ok, contatoBloqueado: true, janelaReabreEm: new Date(AGORA.getTime() + 60_000) },
      semMarca,
      AGORA,
    );
    expect(bloqueado.acao).toBe("cancelar");

    const janela = vereditoDoDisparo(
      { ...ok, sessaoEmDia: false, janelaReabreEm: new Date(AGORA.getTime() + 60_000) },
      semMarca,
      AGORA,
    );
    expect(janela.acao).toBe("reagendar");
    if (janela.acao === "reagendar") expect(janela.motivo).toBe("fora_da_janela");
  });

  it("janela já reaberta não reagenda", () => {
    const v = vereditoDoDisparo(
      { ...ok, janelaReabreEm: new Date(AGORA.getTime() - 1) },
      semMarca,
      AGORA,
    );
    expect(v.acao).toBe("enviar");
  });

  it("contato respondeu só cancela com a marca ligada", () => {
    expect(vereditoDoDisparo({ ...ok, contatoRespondeu: true }, semMarca, AGORA).acao).toBe("enviar");
    expect(
      vereditoDoDisparo({ ...ok, contatoRespondeu: true }, { cancelarSeResponder: true }, AGORA).acao,
    ).toBe("cancelar");
  });
});
