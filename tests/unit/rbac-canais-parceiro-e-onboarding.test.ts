/**
 * 3 rotas de canal/onboarding sem gate de papel — achado ALTO de auditoria.
 *
 * `channels/partner/templates` (criar/sincronizar template aprovado pela
 * Meta), `.../templates/media` (subir cabeçalho de template) e
 * `onboarding/whatsapp/session` (POST reinicia a sessão oficial de WhatsApp,
 * `?restart=1` derruba antes de reabrir) resolviam org sem checar papel —
 * qualquer membro do tenant, inclusive `viewer`, chamava. Rotas irmãs do
 * mesmo domínio (`channels/templates`, `channels/official`) sempre exigiram
 * `admin`. O que se prova aqui: o gate barra ANTES de qualquer efeito
 * (nenhum client admin, adapter ou transporte WAHA é acionado).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getAdapter } from "@/lib/channels";
import { findPartnerSession } from "@/lib/channels/connect";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWahaClient } from "@/lib/waha/client";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/channels/connect", () => ({ findPartnerSession: vi.fn() }));
vi.mock("@/lib/channels", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, getAdapter: vi.fn() };
});
vi.mock("@/lib/waha/client", () => ({ getWahaClient: vi.fn() }));

const NEGADO = fail("forbidden_role", "Permissão insuficiente. Requer role >= admin.", 403, {});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: false, response: NEGADO });
});

describe("POST /api/v1/channels/partner/templates — viewer não cria/sincroniza template", () => {
  it("403 antes de resolver a conexão de parceiro ou chamar o adapter", async () => {
    const { POST } = await import("@/app/api/v1/channels/partner/templates/route");
    const req = new NextRequest("http://localhost/api/v1/channels/partner/templates", {
      method: "POST",
      body: JSON.stringify({ acao: "criar" }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(findPartnerSession).not.toHaveBeenCalled();
    expect(getAdapter).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/channels/partner/templates/media — viewer não sobe imagem de template", () => {
  it("403 antes de ler o multipart ou tocar o storage", async () => {
    const { POST } = await import("@/app/api/v1/channels/partner/templates/media/route");
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" }));
    const req = new NextRequest("http://localhost/api/v1/channels/partner/templates/media", {
      method: "POST",
      body: form,
    });

    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/onboarding/whatsapp/session — viewer não reinicia a sessão oficial", () => {
  it("403 antes de tocar channel_sessions ou o transporte WAHA", async () => {
    const { POST } = await import("@/app/api/v1/onboarding/whatsapp/session/route");
    const req = new Request("http://localhost/api/v1/onboarding/whatsapp/session?restart=1", {
      method: "POST",
    });

    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(getWahaClient).not.toHaveBeenCalled();
  });
});
