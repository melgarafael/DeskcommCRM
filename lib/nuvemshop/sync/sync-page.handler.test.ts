import { describe, expect, it, vi } from "vitest";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { NuvemshopApiError } from "@/lib/nuvemshop/api-client";
import { PAGINA_TAMANHO } from "./constantes";
import type { DepsDoSync } from "./deps";
import type { EstadoDoSync } from "./estado";
import { processarPaginaDoSync } from "./sync-page.handler";

const RUN = "00000000-0000-4000-8000-0000000000aa";
const AGORA = new Date("2026-10-08T12:00:00.000Z");
const PASSO = { run_id: RUN, janela_ini: "2026-01-01T00:00:00.000Z", janela_fim: "2026-02-01T00:00:00.000Z", alvo_fim: "2026-10-08T12:00:00.000Z", pagina: 1 };
const INTEG = { id: "integ-1", organizationId: "org-1", status: "healthy", storeId: "s1", accessToken: "t" };
const ESTADO = { organization_id: "org-1", status: "running", run_id: RUN, pedidos_gravados: 0, pedidos_com_erro: 0 } as EstadoDoSync;

const row = (payload: Record<string, unknown> = PASSO): EventRow => ({
  id: "ev-1", organization_id: "org-1", event_type: "nuvemshop.sync_page", entity_kind: "tenant_integration",
  entity_id: "integ-1", payload, metadata: {}, consumed_by: [], attempts: 0,
});

function deps(itens: unknown[] | Error, over: Partial<DepsDoSync> = {}): DepsDoSync {
  const listOrders = itens instanceof Error ? vi.fn().mockRejectedValue(itens) : vi.fn().mockResolvedValue(itens);
  return {
    lerEstado: vi.fn().mockResolvedValue(ESTADO),
    carregarIntegracao: vi.fn().mockResolvedValue(INTEG),
    api: vi.fn(() => ({ listOrders, getOrder: vi.fn() })),
    gravarPedido: vi.fn().mockResolvedValue({ ok: true, orderId: "o" }),
    reservarRun: vi.fn(),
    registrarPagina: vi.fn().mockResolvedValue(undefined),
    fecharRun: vi.fn().mockResolvedValue({ ...ESTADO, pedidos_gravados: 3 }),
    liberarRun: vi.fn().mockResolvedValue(undefined),
    emitirPasso: vi.fn().mockResolvedValue(undefined),
    desautorizar: vi.fn().mockResolvedValue(undefined),
    auditar: vi.fn().mockResolvedValue(undefined),
    novoRunId: () => RUN,
    agora: () => AGORA,
    ...over,
  };
}

const cheia = Array.from({ length: PAGINA_TAMANHO }, (_, i) => ({ id: i }));

describe("nuvemshop-sync.v1", () => {
  it("payload inválido → skipped", async () => {
    expect((await processarPaginaDoSync(row({ x: 1 }), deps([]))).status).toBe("skipped");
  });

  it("run_id que não é o corrente → skipped run_obsoleto, sem chamar a API", async () => {
    const d = deps([], { lerEstado: vi.fn().mockResolvedValue({ ...ESTADO, run_id: "outro" }) });
    expect(await processarPaginaDoSync(row(), d)).toMatchObject({ status: "skipped", detail: "run_obsoleto" });
    expect(d.api).not.toHaveBeenCalled();
  });

  it("integração desconectada no meio → libera o run, nada encadeado", async () => {
    const d = deps([], { carregarIntegracao: vi.fn().mockResolvedValue({ ...INTEG, status: "disconnected" }) });
    expect(await processarPaginaDoSync(row(), d)).toMatchObject({ status: "skipped", detail: "integracao_inativa" });
    expect(d.liberarRun).toHaveBeenCalledWith("org-1", RUN);
    expect(d.emitirPasso).not.toHaveBeenCalled();
  });

  it("página cheia → grava todos e emite a página seguinte", async () => {
    const d = deps(cheia);
    expect((await processarPaginaDoSync(row(), d)).status).toBe("ok");
    expect(d.gravarPedido).toHaveBeenCalledTimes(PAGINA_TAMANHO);
    expect(d.emitirPasso).toHaveBeenCalledWith("org-1", "integ-1", { ...PASSO, pagina: 2 });
    expect(d.fecharRun).not.toHaveBeenCalled();
  });

  it("pedido ruim não trava a página: conta erro e segue", async () => {
    const gravar = vi.fn()
      .mockResolvedValueOnce({ ok: false, motivo: "total_invalido:1" })
      .mockResolvedValue({ ok: true, orderId: "o" });
    const d = deps([{ id: 1 }, { id: 2 }], { gravarPedido: gravar });
    await processarPaginaDoSync(row({ ...PASSO, janela_fim: PASSO.alvo_fim }), d);
    expect(d.registrarPagina).toHaveBeenCalledWith(ESTADO, expect.objectContaining({ gravados: 1, comErro: 1, ultimoErro: "total_invalido:1" }));
  });

  it("última janela incompleta → fecha o run e audita quando gravou algo", async () => {
    const d = deps([{ id: 1 }], {});
    expect(await processarPaginaDoSync(row({ ...PASSO, janela_fim: PASSO.alvo_fim }), d)).toMatchObject({ status: "ok", detail: "run_concluido" });
    expect(d.fecharRun).toHaveBeenCalled();
    expect(d.auditar).toHaveBeenCalledWith(expect.objectContaining({ action: "nuvemshop.sync_completed", organizationId: "org-1" }));
  });

  it("429 → retry com retry_at do cabeçalho", async () => {
    const d = deps(new NuvemshopApiError(429, "rate_limited", "", undefined, 1500));
    const r = await processarPaginaDoSync(row(), d);
    expect(r.status).toBe("retry");
    expect(r.retry_at).toBe(new Date(AGORA.getTime() + 1500).toISOString());
  });

  it("429 sem cabeçalho → retry em 2 s", async () => {
    const r = await processarPaginaDoSync(row(), deps(new NuvemshopApiError(429, "rate_limited", "")));
    expect(r.retry_at).toBe(new Date(AGORA.getTime() + 2000).toISOString());
  });

  it("401 → desautoriza e não pede retry", async () => {
    const d = deps(new NuvemshopApiError(401, "unauthorized", ""));
    expect(await processarPaginaDoSync(row(), d)).toMatchObject({ status: "skipped", detail: "desautorizada" });
    expect(d.desautorizar).toHaveBeenCalledWith(INTEG);
  });

  it("5xx → error (o dreno faz o backoff)", async () => {
    expect((await processarPaginaDoSync(row(), deps(new NuvemshopApiError(502, "upstream_error", "")))).status).toBe("error");
  });
});
