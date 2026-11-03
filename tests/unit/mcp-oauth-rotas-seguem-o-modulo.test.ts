/**
 * As duas rotas públicas do OAuth por contato (#3857) seguem o módulo opcional
 * `mcp_por_agente` (doc 252): desligado, 404 — a resposta de uma rota nunca
 * instalada — sem tocar no `state`. Ligado, a rota chega ao fluxo.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ligado = vi.fn<(db: unknown, modulo: string) => Promise<boolean>>();
const iniciar = vi.fn();
const processar = vi.fn();

vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: (db: unknown, m: string) => ligado(db, m) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/mcp/servidor-externo/do-agente/retorno", () => ({
  iniciarAutorizacao: (...a: unknown[]) => iniciar(...a),
  processarRetorno: (...a: unknown[]) => processar(...a),
  paginaDoDesfecho: () => "<html></html>",
}));

import { GET as callback } from "@/app/api/v1/mcp-oauth/callback/[servidor]/route";
import { GET as inicio } from "@/app/api/v1/mcp-oauth/iniciar/[state]/route";

const STATE = "a".repeat(43);
const SERVIDOR = "5e5e5e5e-0000-4000-8000-000000000001";

function chamarInicio() {
  return inicio(new NextRequest(`http://localhost/api/v1/mcp-oauth/iniciar/${STATE}`), {
    params: Promise.resolve({ state: STATE }),
  });
}
function chamarCallback() {
  return callback(new NextRequest(`http://localhost/api/v1/mcp-oauth/callback/${SERVIDOR}?state=${STATE}&code=c&iss=https%3A%2F%2Fas.example`), {
    params: Promise.resolve({ servidor: SERVIDOR }),
  });
}

beforeEach(() => {
  ligado.mockReset();
  iniciar.mockReset();
  processar.mockReset();
});

describe("módulo mcp_por_agente desligado", () => {
  it("as duas rotas respondem 404 e não leem o state", async () => {
    ligado.mockResolvedValue(false);
    expect((await chamarInicio()).status).toBe(404);
    expect((await chamarCallback()).status).toBe(404);
    expect(iniciar).not.toHaveBeenCalled();
    expect(processar).not.toHaveBeenCalled();
    expect(ligado.mock.calls.map((c) => c[1])).toEqual(["mcp_por_agente", "mcp_por_agente"]);
  });
});

describe("controle: módulo ligado", () => {
  it("as rotas chegam ao fluxo", async () => {
    ligado.mockResolvedValue(true);
    iniciar.mockResolvedValue({ ok: true, destino: "https://as.example/authorize" });
    processar.mockResolvedValue("autorizado");
    const r = await chamarInicio();
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://as.example/authorize");
    expect((await chamarCallback()).status).toBe(200);
    expect(iniciar).toHaveBeenCalledTimes(1);
    expect(processar).toHaveBeenCalledTimes(1);
    // O servidor da URL e o `iss` chegam ao fluxo, para ele conferir contra o pedido.
    expect(processar.mock.calls[0]![1]).toMatchObject({ servidor: SERVIDOR, iss: "https://as.example", state: STATE });
  });
});
