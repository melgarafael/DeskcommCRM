/**
 * PUT /api/v1/ai/cases/alerta e POST /teste com o MODELO APROVADO (migration 9094).
 *
 * A rota faz a pergunta que o banco não faz — o modelo está aprovado e tem uma
 * variável só? — ANTES do RPC, que só confere organização e conexão. Recusa
 * aqui não toca o banco nem audita: nada foi salvo.
 *
 * E o teste da tela usa o modelo SALVO, para provar o caminho que o aviso real
 * vai usar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { enviarAvisoDeTeste } from "@/lib/escalacao/aviso-de-teste";
import { carregarModeloDoAviso } from "@/lib/escalacao/modelo-do-aviso";
import { lerEstadoDaTelaDeAviso } from "@/lib/escalacao/tela-do-aviso";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/escalacao/tela-do-aviso", () => ({ lerEstadoDaTelaDeAviso: vi.fn() }));
vi.mock("@/lib/escalacao/aviso-de-teste", () => ({ enviarAvisoDeTeste: vi.fn() }));
vi.mock("@/lib/escalacao/modelo-do-aviso", () => ({ carregarModeloDoAviso: vi.fn() }));
vi.mock("@/lib/escalacao/aviso-ao-suporte.handler", () => ({
  criarTransporteDoAviso: vi.fn(async () => ({})),
}));
vi.mock("@/lib/agent-engine/pacing/ledger-supabase", () => ({
  criarPacingDoCanal: vi.fn(async () => ({})),
}));

const { PUT } = await import("@/app/api/v1/ai/cases/alerta/route");
const { POST: TESTE } = await import("@/app/api/v1/ai/cases/alerta/teste/route");

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
const MODELO = "44444444-4444-4444-8444-444444444444";
const TELEFONE = "+5531900000001";

const CORPO = { channel_session_id: CANAL, telefone: TELEFONE, rotulo: null, ligado: true, modelo_id: MODELO };

function cliente(opts: { rpcErro?: string; config?: Record<string, unknown> | null } = {}) {
  const rpc = vi.fn(async () =>
    opts.rpcErro ? { data: null, error: { message: opts.rpcErro } } : { data: {}, error: null },
  );
  const from = vi.fn(() => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) c[m] = () => c;
    c.maybeSingle = async () => ({ data: opts.config ?? null, error: null });
    return c;
  });
  vi.mocked(createClient).mockResolvedValue({ rpc, from } as never);
  return { rpc };
}

function put(body: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/cases/alerta", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: "admin" },
  } as never);
  vi.mocked(lerEstadoDaTelaDeAviso).mockResolvedValue({} as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, limit: 3, count: 1 } as never);
});

describe("PUT — o modelo escolhido", () => {
  it("o modelo que serve vai para o RPC como `p_modelo`, e a auditoria o registra", async () => {
    const { rpc } = cliente();
    vi.mocked(carregarModeloDoAviso).mockResolvedValue({ ok: true, modelo: { id: MODELO } } as never);
    const r = await PUT(put(CORPO));
    expect(r.status).toBe(200);
    // A organização da SESSÃO, nunca do corpo.
    expect(carregarModeloDoAviso).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG,
      channelSessionId: CANAL,
      modeloId: MODELO,
    });
    expect(rpc).toHaveBeenCalledWith("fn_definir_aviso_de_caso", expect.objectContaining({ p_modelo: MODELO }));
    const entrada = vi.mocked(audit).mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(entrada.metadata.modelo).toBe(MODELO);
  });

  it("sem modelo, o RPC recebe `null` — é o que limpa o modelo de uma conexão antiga", async () => {
    const { rpc } = cliente();
    await PUT(put({ ...CORPO, modelo_id: null }));
    expect(carregarModeloDoAviso).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("fn_definir_aviso_de_caso", expect.objectContaining({ p_modelo: null }));
  });

  it("cada motivo da regra vira recusa própria, ANTES do banco e sem auditoria", async () => {
    const casos = [
      ["outra_conexao", 422, "aviso_modelo_invalido", "não é da conexão escolhida"],
      ["inexistente", 422, "aviso_modelo_invalido", "não existe mais"],
      ["nao_aprovado", 422, "aviso_modelo_invalido", "não está aprovado"],
      ["variaveis", 422, "aviso_modelo_invalido", "uma variável só"],
      ["indeterminado", 503, "unavailable", "Tente de novo"],
    ] as const;
    for (const [motivo, status, code, frase] of casos) {
      vi.clearAllMocks();
      vi.mocked(requireRole).mockResolvedValue({
        ok: true,
        user: { id: USER, idioma: "pt-BR" },
        org: { orgId: ORG, name: "Org", role: "admin" },
      } as never);
      const { rpc } = cliente();
      vi.mocked(carregarModeloDoAviso).mockResolvedValue({ ok: false, motivo } as never);
      const r = await PUT(put(CORPO));
      const corpo = (await r.json()) as { error: { code: string; message: string } };
      expect(r.status, motivo).toBe(status);
      expect(corpo.error.code, motivo).toBe(code);
      expect(corpo.error.message, motivo).toContain(frase);
      expect(rpc, motivo).not.toHaveBeenCalled();
      expect(audit, motivo).not.toHaveBeenCalled();
    }
  });

  it("a recusa do BANCO (modelo de outra organização ou conexão) tem código próprio", async () => {
    cliente({ rpcErro: "erro: aviso_de_caso_modelo_invalido" });
    vi.mocked(carregarModeloDoAviso).mockResolvedValue({ ok: true, modelo: { id: MODELO } } as never);
    const r = await PUT(put(CORPO));
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("aviso_modelo_invalido");
  });

  it("modelo que não é uuid nem chega à regra", async () => {
    const { rpc } = cliente();
    const r = await PUT(put({ ...CORPO, modelo_id: "aviso_da_equipe" }));
    expect(r.status).toBe(422);
    expect(carregarModeloDoAviso).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("POST /teste — o modelo SALVO", () => {
  const req = () => new NextRequest("http://localhost/api/v1/ai/cases/alerta/teste", { method: "POST" });

  it("vai para o teste, que prova o caminho do aviso real", async () => {
    cliente({ config: { channel_session_id: CANAL, telefone_destino: TELEFONE, modelo_id: MODELO } });
    vi.mocked(enviarAvisoDeTeste).mockResolvedValue({ enviado: true, destinoMascarado: "••••0001", externalId: null });
    await TESTE(req());
    expect(vi.mocked(enviarAvisoDeTeste).mock.calls[0]![1]).toMatchObject({ channelSessionId: CANAL, modeloId: MODELO });
  });
});
