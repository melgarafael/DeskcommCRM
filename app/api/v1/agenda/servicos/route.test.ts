import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { moduloLigado } from "@/lib/instalacao/modulos";
import { rpcDoServico } from "@/lib/agenda/servicos/escrita";

import { POST } from "./route";

/**
 * Doc 283 (A): o LUGAR da agenda (mesa, camarote, quadra — #4029) é o módulo
 * `reservas_de_lugar`, desligado de fábrica. Desligado, criar ou converter um
 * recurso em lugar responde 404 ANTES de chegar ao banco; o recurso comum
 * (exigência com unidades) segue como sempre, com o módulo ligado ou não.
 */

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(async () => ({ ok: true, organizationId: "org-1", actor: { type: "user", id: "u-1" }, idioma: "pt-BR", apiTokenId: null })),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn() }));
vi.mock("@/lib/agenda/servicos/escrita", () => ({ rpcDoServico: vi.fn(async () => ({ id: "r-1" })) }));

function pedido(input: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/v1/agenda/servicos", {
    method: "POST",
    body: JSON.stringify({ action: "resource", input: { name: "Mesa 1", capacity: 4, ...input } }),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/v1/agenda/servicos — o lugar segue o módulo reservas_de_lugar", () => {
  it("desligado: criar um lugar responde 404 e não chega ao banco", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    const res = await POST(pedido({ kind: "space", sector: "Salão" }));
    expect(res.status).toBe(404);
    expect(vi.mocked(moduloLigado).mock.calls[0]![1]).toBe("reservas_de_lugar");
    expect(rpcDoServico).not.toHaveBeenCalled();
  });

  it("ligado: o lugar chega à função do banco com o tipo e a área", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(true);
    const res = await POST(pedido({ kind: "space", sector: "Salão" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(rpcDoServico).mock.calls[0]![2]).toBe("fn_calendar_service_resource");
    expect(vi.mocked(rpcDoServico).mock.calls[0]![3]).toMatchObject({ p_config: { kind: "space", sector: "Salão" } });
  });

  it("recurso comum não depende do módulo, desligado ou não", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    expect((await POST(pedido({}))).status).toBe(200);
    expect((await POST(pedido({ kind: "resource" }))).status).toBe(200);
    expect(rpcDoServico).toHaveBeenCalledTimes(2);
    expect(moduloLigado).not.toHaveBeenCalled();
  });
});
