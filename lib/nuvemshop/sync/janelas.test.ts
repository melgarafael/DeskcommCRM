import { describe, expect, it } from "vitest";
import { PAGINA_MAXIMA, PAGINA_TAMANHO, type PassoDoSync } from "./constantes";
import { mesDoBackfill, primeiroPasso, proximoPasso } from "./janelas";

const RUN = "00000000-0000-4000-8000-000000000001";
const AGORA = new Date("2026-10-08T12:00:00.000Z");

describe("primeiroPasso", () => {
  it("sem cursor: backfill de 12 meses, primeira janela mensal", () => {
    expect(primeiroPasso({ runId: RUN, cursor: null, agora: AGORA })).toEqual({
      run_id: RUN,
      janela_ini: "2025-10-08T12:00:00.000Z",
      janela_fim: "2025-11-08T12:00:00.000Z",
      alvo_fim: "2026-10-08T12:00:00.000Z",
      pagina: 1,
    });
  });
  it("com cursor recente: uma janela [cursor, agora]", () => {
    expect(primeiroPasso({ runId: RUN, cursor: "2026-10-08T11:30:00.000Z", agora: AGORA })).toMatchObject({
      janela_ini: "2026-10-08T11:30:00.000Z",
      janela_fim: "2026-10-08T12:00:00.000Z",
    });
  });
});

describe("proximoPasso", () => {
  const p = (over: Partial<PassoDoSync> = {}): PassoDoSync => ({
    run_id: RUN,
    janela_ini: "2026-01-01T00:00:00.000Z",
    janela_fim: "2026-02-01T00:00:00.000Z",
    alvo_fim: "2026-10-08T12:00:00.000Z",
    pagina: 1,
    ...over,
  });

  it("página cheia → próxima página da mesma janela", () => {
    expect(proximoPasso(p({ pagina: 3 }), PAGINA_TAMANHO)).toEqual({ tipo: "pagina", passo: p({ pagina: 4 }), perda: false });
  });

  it("página incompleta → próxima janela mensal, página 1", () => {
    expect(proximoPasso(p({ pagina: 3 }), 7)).toEqual({
      tipo: "pagina",
      passo: p({ janela_ini: "2026-02-01T00:00:00.000Z", janela_fim: "2026-03-01T00:00:00.000Z", pagina: 1 }),
      perda: false,
    });
  });

  it("última janela é cortada no alvo", () => {
    const r = proximoPasso(p({ janela_ini: "2026-09-01T00:00:00.000Z", janela_fim: "2026-10-01T00:00:00.000Z" }), 0);
    expect(r).toMatchObject({ tipo: "pagina", passo: { janela_ini: "2026-10-01T00:00:00.000Z", janela_fim: "2026-10-08T12:00:00.000Z" } });
  });

  it("janela que chega ao alvo e não está cheia → fim", () => {
    expect(proximoPasso(p({ janela_fim: "2026-10-08T12:00:00.000Z" }), 10)).toEqual({ tipo: "fim", perda: false });
  });

  it("última janela indivisível e cheia no teto → fim com perda", () => {
    const ultima = p({ janela_ini: "2026-10-08T11:59:00.000Z", janela_fim: "2026-10-08T12:00:00.000Z", pagina: PAGINA_MAXIMA });
    expect(proximoPasso(ultima, PAGINA_TAMANHO)).toEqual({ tipo: "fim", perda: true });
  });

  it("página máxima cheia → divide a janela ao meio e recomeça na página 1", () => {
    expect(proximoPasso(p({ pagina: PAGINA_MAXIMA }), PAGINA_TAMANHO)).toEqual({
      tipo: "pagina",
      passo: p({ janela_fim: "2026-01-16T12:00:00.000Z", pagina: 1 }),
      perda: false,
    });
  });

  it("janela indivisível (≤ 2 min) e cheia no teto → segue e marca perda", () => {
    const curta = p({ janela_ini: "2026-01-01T00:00:00.000Z", janela_fim: "2026-01-01T00:01:00.000Z", pagina: PAGINA_MAXIMA });
    const r = proximoPasso(curta, PAGINA_TAMANHO);
    expect(r).toMatchObject({ tipo: "pagina", perda: true, passo: { janela_ini: "2026-01-01T00:01:00.000Z", pagina: 1 } });
  });

  it("encadeia 12 janelas no backfill", () => {
    let passo = primeiroPasso({ runId: RUN, cursor: null, agora: AGORA });
    let janelas = 1;
    for (;;) {
      const r = proximoPasso(passo, 0);
      if (r.tipo === "fim") break;
      passo = r.passo;
      janelas++;
    }
    expect(janelas).toBe(12);
    expect(passo.janela_fim).toBe("2026-10-08T12:00:00.000Z");
  });
});

describe("mesDoBackfill", () => {
  it("primeira janela é o mês 1, a última o 12", () => {
    expect(mesDoBackfill("2025-10-08T12:00:00.000Z", "2026-10-08T12:00:00.000Z")).toBe(1);
    expect(mesDoBackfill("2026-09-08T12:00:00.000Z", "2026-10-08T12:00:00.000Z")).toBe(12);
  });
});
