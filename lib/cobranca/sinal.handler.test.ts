import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { bancoFalso, type BancoFalso } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({ sincronizar: vi.fn(), linha: null as { relida_em: string | null } | null, banco: undefined as unknown as BancoFalso }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("./sincronizar", () => ({ sincronizar: h.sincronizar }));

import { cobrancaSinalHandler, JANELA_DO_COALESCER_MS } from "./sinal.handler";

const ORG = "dddddddd-0000-4000-8000-000000000001";
const linha = (): EventRow => ({
  id: "ev-1", organization_id: ORG, event_type: "cobranca.sinal", entity_kind: "organization", entity_id: ORG,
  payload: { provedor: "stripe", evento_id: "evt_1" }, metadata: {}, consumed_by: [], attempts: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.banco = bancoFalso(() => ({ data: h.linha }));
  h.sincronizar.mockResolvedValue({ tipo: "aplicada", estado: "ativa", mudou: true, acao: "reativar" });
});

describe("cobrancaSinalHandler", () => {
  it("roda com a empresa suspensa: é por aqui que quem pagou volta", () => {
    expect(cobrancaSinalHandler.naOrgParada).toBe("roda");
    expect(cobrancaSinalHandler.events).toEqual(["cobranca.sinal"]);
    expect(JANELA_DO_COALESCER_MS).toBe(30_000);
  });

  it("⭐ leitura aplicada há 10 s: retry para depois dela, sem reler", async () => {
    const relida = new Date(Date.now() - 10_000);
    h.linha = { relida_em: relida.toISOString() };
    const r = await cobrancaSinalHandler.handle(linha());
    expect(r).toMatchObject({ consumer_key: "cobranca.sinal", status: "retry", retry_at: new Date(relida.getTime() + 30_000).toISOString() });
    expect(h.sincronizar).not.toHaveBeenCalled();
  });

  it("leitura antiga: relê", async () => {
    h.linha = { relida_em: new Date(Date.now() - 60_000).toISOString() };
    expect(await cobrancaSinalHandler.handle(linha())).toMatchObject({ status: "ok", detail: "aplicada" });
    expect(h.sincronizar).toHaveBeenCalledWith(h.banco.cliente, ORG);
  });

  it("empresa isenta: skipped", async () => {
    h.linha = null;
    expect(await cobrancaSinalHandler.handle(linha())).toMatchObject({ status: "skipped", detail: "org_isenta" });
  });

  it("leitura do provedor falhou por instabilidade: error (o dreno aplica o backoff e, no teto, avisa event_dead)", async () => {
    h.linha = { relida_em: null };
    h.sincronizar.mockResolvedValue({ tipo: "falhou", erro: "provedor_fora", transitorio: true });
    expect(await cobrancaSinalHandler.handle(linha())).toMatchObject({ status: "error", detail: "leitura do provedor falhou: provedor_fora" });
  });

  it.each(["credencial_invalida", "leitura_invalida"] as const)(
    "⭐ %s não se cura com retry: skipped, sem event_dead na Central DA EMPRESA (o problema é do dono)",
    async (erro) => {
      h.linha = { relida_em: null };
      h.sincronizar.mockResolvedValue({ tipo: "falhou", erro, transitorio: false });
      expect(await cobrancaSinalHandler.handle(linha())).toMatchObject({ status: "skipped", detail: `leitura_nao_transitoria:${erro}` });
    },
  );
});
