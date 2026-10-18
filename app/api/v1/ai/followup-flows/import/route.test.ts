/**
 * Seguimento do #3056 — a lista de problemas do arquivo recusado sai no idioma
 * de quem importa, com o caminho até o campo. Antes saía em inglês do Zod
 * («Invalid UUID»). O arquivo inválido é recusado antes de qualquer leitura do
 * banco, então os clients nem são chamados.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({ role: vi.fn(), support: vi.fn(), audit: vi.fn(), client: vi.fn(), admin: vi.fn(), modulo: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: deps.modulo }));

import { POST } from "./route";

const comoQuem = (idioma: "pt-BR" | "es") =>
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma },
    org: { orgId: "11111111-1111-4111-8111-111111111111", role: "manager" },
  });

const importar = (file: unknown) =>
  POST(
    new NextRequest("http://localhost/api/v1/ai/followup-flows/import", {
      method: "POST",
      body: JSON.stringify({ file }),
      headers: { "content-type": "application/json" },
    }),
  );

const ARQUIVO_SEM_GRAFO = { format: "followup_flow", version: 1, flow: { name: "X" } };

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
});

describe("POST /followup-flows/import — problemas no idioma de quem importa", () => {
  it.each([
    ["pt-BR", 'flow.graph: Entrada inválida: esperava um objeto, recebeu um valor "undefined"'],
    ["es", "flow.graph: Entrada inválida: se esperaba objeto, recibido indefinido"],
  ] as const)("%s", async (idioma, linha) => {
    comoQuem(idioma);
    const res = await importar(ARQUIVO_SEM_GRAFO);
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; details: { problemas: string[] } } };
    expect(corpo.error.code).toBe("invalid_flow_file");
    expect(corpo.error.details.problemas).toEqual([linha]);
    expect(deps.client).not.toHaveBeenCalled();
    expect(deps.admin).not.toHaveBeenCalled();
  });
});

describe("POST /followup-flows/import — o corpo do pedido também lê no idioma de quem importa", () => {
  it.each([
    ["pt-BR", "name: Entrada inválida: esperava um texto, recebeu um número"],
    ["es", "name: Entrada inválida: se esperaba texto, recibido número"],
  ] as const)("%s", async (idioma, linha) => {
    comoQuem(idioma);
    const res = await POST(
      new NextRequest("http://localhost/api/v1/ai/followup-flows/import", {
        method: "POST",
        body: JSON.stringify({ file: ARQUIVO_SEM_GRAFO, name: 5 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; details: { problemas: string[] } } };
    expect(corpo.error.code).toBe("validation_failed");
    expect(corpo.error.details.problemas).toEqual([linha]);
  });
});
