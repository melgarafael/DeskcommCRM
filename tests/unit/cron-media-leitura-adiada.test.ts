import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDaLeitura from "@/lib/messaging/media/leitura-adiada";

/**
 * O CRON QUE DEVOLVE A DESCRIÇÃO À FOTO ADIADA QUANDO A EMPRESA GANHA LEITOR.
 *
 * Com `MEDIA_VISION_WITHOUT_READER=defer` (o padrão), a foto de empresa sem
 * leitor fica guardada sem descrição. O dreno a reabre no turno de entrada; quem
 * lê FORA do dreno (follow-up de silêncio, rascunho, caso, REST, MCP, Meta)
 * depende desta varredura. Ela reabre só onde há leitor, e só a foto dos últimos
 * `JANELA_DO_CRON_DIAS` dias: ligar "ver as fotos" num agente não pode pagar
 * visão de meses de foto que ninguém abre. Com o knob em `always`, reabre tudo,
 * de qualquer data: a volta atrás é completa.
 */

const SEGREDO = "segredo-do-cron";
const ORG_SEM_LEITOR = "a0000000-0000-4000-8000-000000000001";
const ORG_COM_LEITOR = "b0000000-0000-4000-8000-000000000002";

const h = vi.hoisted(() => ({
  knob: "defer",
  pool: { query: async () => ({ rows: [] }) },
  organizacoes: vi.fn(async (..._a: unknown[]) => [] as string[]),
  haLeitor: vi.fn(async (..._a: unknown[]) => true),
  reabrir: vi.fn(async (..._a: unknown[]) => 0),
  auditar: vi.fn(),
  erroDeLog: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "segredo-do-cron",
    INTERNAL_SECRET: "",
    get MEDIA_VISION_WITHOUT_READER() {
      return h.knob;
    },
  },
}));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => h.auditar(...a) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => h.erroDeLog(...a) },
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => h.pool }));
vi.mock("@/lib/messaging/media/leitura-adiada", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloDaLeitura>()),
  organizacoesComLeituraAdiada: (...a: unknown[]) => h.organizacoes(...a),
  haLeitorDaDescricao: (...a: unknown[]) => h.haLeitor(...a),
  reabrirLeituraAdiada: (...a: unknown[]) => h.reabrir(...a),
}));

import { GET } from "@/app/api/v1/cron/media-leitura-adiada/route";
import { JANELA_DO_CRON_DIAS, LOTE_DE_REABERTURA } from "@/lib/messaging/media/leitura-adiada";

function chamar(segredo: string | null = SEGREDO): Promise<Response> {
  return GET(
    new NextRequest("http://localhost/api/v1/cron/media-leitura-adiada", {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );
}

const reabertasPara = () => h.reabrir.mock.calls.map((c) => c[1]);

beforeEach(() => {
  h.knob = "defer";
  h.organizacoes.mockReset().mockResolvedValue([ORG_SEM_LEITOR, ORG_COM_LEITOR]);
  h.haLeitor.mockReset().mockImplementation(async (_pool, org) => org === ORG_COM_LEITOR);
  h.reabrir.mockReset().mockResolvedValue(3);
  h.auditar.mockReset();
  h.erroDeLog.mockReset();
});

describe("GET /api/v1/cron/media-leitura-adiada", () => {
  it("reabre só na empresa que tem leitor, com o lote e a janela, e audita a rodada que teve efeito", async () => {
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(reabertasPara()).toEqual([ORG_COM_LEITOR]);
    expect(h.reabrir).toHaveBeenCalledWith(h.pool, ORG_COM_LEITOR, {
      limite: LOTE_DE_REABERTURA,
      maxIdadeDias: JANELA_DO_CRON_DIAS,
    });
    expect(h.auditar).toHaveBeenCalledTimes(1);
    expect(h.auditar).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "media.deferred_reading_run",
        metadata: expect.objectContaining({ reabertas: 3 }),
      }),
    );
    const corpo = (await res.json()) as { data: { reabertas: number } };
    expect(corpo.data.reabertas).toBe(3);
  });

  it("rodada sem nada reaberto não audita", async () => {
    h.reabrir.mockResolvedValue(0);
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(h.auditar).not.toHaveBeenCalled();
  });

  it("knob em 'always' (a volta atrás): reabre também onde não há leitor, sem perguntar e sem idade", async () => {
    h.knob = "always";
    await chamar();
    expect(reabertasPara()).toEqual([ORG_SEM_LEITOR, ORG_COM_LEITOR]);
    expect(h.haLeitor).not.toHaveBeenCalled();
    expect(h.reabrir).toHaveBeenCalledWith(h.pool, ORG_SEM_LEITOR, { limite: LOTE_DE_REABERTURA });
  });

  it("a janela é a do follow-up de silêncio mais longo (7 dias), não meses", () => {
    expect(JANELA_DO_CRON_DIAS).toBe(7);
  });

  it("uma empresa que falha não derruba a rodada das outras, e o erro vai para o log", async () => {
    h.knob = "always";
    h.reabrir.mockRejectedValueOnce(new Error("deadlock detected")).mockResolvedValueOnce(2);
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(reabertasPara()).toEqual([ORG_SEM_LEITOR, ORG_COM_LEITOR]);
    expect(h.erroDeLog).toHaveBeenCalledWith(
      expect.stringContaining("media-leitura-adiada"),
      expect.objectContaining({ organization_id: ORG_SEM_LEITOR }),
    );
  });

  it("sem o segredo: 403, e nada é lido nem reaberto", async () => {
    const res = await chamar(null);
    expect(res.status).toBe(403);
    expect(h.organizacoes).not.toHaveBeenCalled();
    expect(h.reabrir).not.toHaveBeenCalled();
  });
});
