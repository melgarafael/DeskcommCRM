import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { enviarPushDaOrg } from "@/lib/notifications/web_push";

import { POST } from "./route";

/**
 * POST /api/v1/admin/avisos — o aviso escrito pelo ADMIN (#1418, fatia 1).
 *
 * O que este teste protege é a diferença entre "salvei o recado" e "o recado
 * tocou o celular de alguém": a janela. Publicar cedo demais entrega antes da
 * hora combinada; publicar um aviso já expirado entrega o que não vale mais.
 * Nos dois casos o certo é gravar e NÃO empurrar.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushDaOrg: vi.fn(async () => undefined),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const AUTOR = "11111111-1111-4111-8111-111111111111";

function avisoSalvo(extra: Record<string, unknown> = {}) {
  return {
    id: "aviso-1",
    organization_id: ORG,
    autor_id: AUTOR,
    titulo: "Manutenção às 22h",
    corpo: "O WhatsApp fica ~20 min fora.",
    publicar_em: new Date().toISOString(),
    expira_em: null,
    created_at: new Date().toISOString(),
    ...extra,
  };
}

function bancoQueSalva(salvo: Record<string, unknown>) {
  const single = vi.fn(async () => ({ data: salvo, error: null }));
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ insert }));
  return { from, insert, select, single };
}

function pedido(corpo: unknown) {
  return new NextRequest("http://localhost/api/v1/admin/avisos", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

const CORPO_VALIDO = { titulo: "Manutenção às 22h", corpo: "O WhatsApp fica ~20 min fora." };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG },
    user: { id: AUTOR },
  } as never);
});

describe("POST /api/v1/admin/avisos", () => {
  it("publica quando o aviso está dentro da janela", async () => {
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const resposta = await POST(pedido(CORPO_VALIDO));

    expect(resposta.status).toBe(201);
    expect(banco.insert).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: ORG, autor_id: AUTOR }),
    );
    expect(enviarPushDaOrg).toHaveBeenCalledTimes(1);
    expect(enviarPushDaOrg).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ title: "Manutenção às 22h" }),
    );
  });

  it("grava mas NÃO publica quando a hora de publicar ainda não chegou", async () => {
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const futuro = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const resposta = await POST(pedido({ ...CORPO_VALIDO, publicar_em: futuro }));

    expect(resposta.status).toBe(201);
    expect(banco.insert).toHaveBeenCalledTimes(1);
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });

  it("grava mas NÃO publica quando o aviso já expirou", async () => {
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const passado = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const resposta = await POST(pedido({ ...CORPO_VALIDO, expira_em: passado }));

    expect(resposta.status).toBe(201);
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });

  it("recusa quem não é admin", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    } as never);
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const resposta = await POST(pedido(CORPO_VALIDO));

    expect(resposta.status).toBe(403);
    expect(banco.insert).not.toHaveBeenCalled();
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
  });

  it("recusa aviso sem corpo", async () => {
    const banco = bancoQueSalva(avisoSalvo());
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const resposta = await POST(pedido({ titulo: "Só o título" }));

    expect(resposta.status).toBe(400);
    expect(banco.insert).not.toHaveBeenCalled();
  });
});
