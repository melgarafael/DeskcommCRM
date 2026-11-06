// @vitest-environment node
//
// LIGAR A ATUALIZAÇÃO DE CARD EXIGE ASSINATURA NA FONTE (#2316).
//
// "Atualizar card é integração entre sistemas, e o formulário HTML público não
// precisa disso" — a régua é a MESMA da autorização de IA, e por isso as duas
// moram numa pergunta só (`opcaoSemAssinatura`). O que ela decide, e que a rota
// do PATCH traduz em recusa `signature_required` (422):
//
//   - ligar a opção sem assinatura configurada → recusa, dizendo QUAL opção;
//   - definir a assinatura no MESMO patch → passa (o segredo entra junto);
//   - DESLIGAR qualquer uma das duas → passa sempre (a tela promete "desligue
//     primeiro", e uma recusa aqui deixaria a pessoa presa).

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import {
  assinaturaObrigatoriaAusente,
  opcaoSemAssinatura,
} from "@/lib/webhooks/assinatura-autorizacao";

// Só para o caso da ROTA (#3101, no fim do arquivo): a fonte lida do banco e
// quem pede. A regra em si é a de verdade.
const rota = vi.hoisted(() => ({
  fonte: null as Record<string, unknown> | null,
  update: vi.fn(),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "user-1", idioma: "pt" },
    org: { orgId: "org-1", role: "manager" },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const cadeia: Record<string, unknown> = {
      select: () => cadeia,
      eq: () => cadeia,
      update: (...args: unknown[]) => {
        rota.update(...args);
        return cadeia;
      },
      maybeSingle: async () => ({ data: rota.fonte, error: null }),
      single: async () => ({ data: { ...rota.fonte, secret_encrypted: null }, error: null }),
    };
    return { from: () => cadeia };
  },
}));

import { PATCH } from "@/app/api/v1/webhook-sources/[id]/route";

const SEM_SEGREDO = { authorize_ai_on_capture: false, secret_encrypted: null };
const COM_SEGREDO = { authorize_ai_on_capture: false, secret_encrypted: "cifrado" };
const CIFRADO = "cifrado";

describe("a opção de atualizar o card pela integração exige assinatura (#2316)", () => {
  it("⭐ ligar sem assinatura na fonte: recusa apontando a opção certa", () => {
    expect(
      opcaoSemAssinatura(SEM_SEGREDO, { update_existing_lead_on_capture: true }),
    ).toBe("update_lead");
  });

  it("fonte que já tem assinatura: liga sem pedir nada", () => {
    expect(
      opcaoSemAssinatura(COM_SEGREDO, { update_existing_lead_on_capture: true }),
    ).toBeNull();
  });

  it("assinatura definida no MESMO patch: liga junto", () => {
    expect(
      opcaoSemAssinatura(SEM_SEGREDO, {
        update_existing_lead_on_capture: true,
        secret: CIFRADO,
      }),
    ).toBeNull();
  });

  it("remover a assinatura com a opção LIGADA: recusa — desligue primeiro", () => {
    expect(
      opcaoSemAssinatura(
        { authorize_ai_on_capture: false, secret_encrypted: CIFRADO },
        { update_existing_lead_on_capture: true, secret: null },
      ),
    ).toBe("update_lead");
  });

  it("DESLIGAR a opção nunca pede assinatura", () => {
    expect(
      opcaoSemAssinatura(COM_SEGREDO, { update_existing_lead_on_capture: false }),
    ).toBeNull();
    expect(opcaoSemAssinatura(SEM_SEGREDO, { update_existing_lead_on_capture: false })).toBeNull();
  });
});

describe("a régua da autorização de IA continua a mesma", () => {
  it("ligar IA sem assinatura: recusa apontando a IA", () => {
    expect(opcaoSemAssinatura(SEM_SEGREDO, { authorize_ai_on_capture: true })).toBe("ai");
  });

  it("as duas ligadas de uma vez sem assinatura: a IA é a primeira resposta", () => {
    expect(
      opcaoSemAssinatura(SEM_SEGREDO, {
        authorize_ai_on_capture: true,
        update_existing_lead_on_capture: true,
      }),
    ).toBe("ai");
  });

  it("o booleano histórico continua respondendo o mesmo", () => {
    expect(assinaturaObrigatoriaAusente(SEM_SEGREDO, { authorize_ai_on_capture: true })).toBe(true);
    expect(
      assinaturaObrigatoriaAusente(SEM_SEGREDO, { update_existing_lead_on_capture: true }),
    ).toBe(true);
    expect(assinaturaObrigatoriaAusente(COM_SEGREDO, { authorize_ai_on_capture: true })).toBe(false);
    // Um patch que não toca em nenhuma das duas opções (definir a assinatura,
    // renomear, desativar) nunca recusa.
    expect(assinaturaObrigatoriaAusente(SEM_SEGREDO, { secret: CIFRADO })).toBe(false);
  });
});

describe("reaproveitar o card aberto do contato exige assinatura (#3101)", () => {
  it("⭐ o PATCH que liga o reuso numa fonte SEM assinatura recusa com 422 signature_required", async () => {
    rota.update.mockClear();
    rota.fonte = {
      id: "fonte-1",
      authorize_ai_on_capture: false,
      update_existing_lead_on_capture: false,
      reuse_open_lead_on_capture: false,
      secret_encrypted: null,
    };
    const req = new NextRequest("http://localhost/api/v1/webhook-sources/fonte-1", {
      method: "PATCH",
      body: JSON.stringify({ reuse_open_lead_on_capture: true }),
      headers: { "content-type": "application/json" },
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: "fonte-1" }) });

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("signature_required");
    expect(corpo.error.message).toContain("reaproveitar o card aberto");
    expect(rota.update, "a opção foi gravada sem assinatura na fonte").not.toHaveBeenCalled();
  });

  it("remover a assinatura com o reuso LIGADO: recusa — desligue primeiro", () => {
    expect(
      opcaoSemAssinatura(
        { authorize_ai_on_capture: false, reuse_open_lead_on_capture: true, secret_encrypted: CIFRADO },
        { secret: null },
      ),
    ).toBe("reuse_lead");
  });

  it("fonte com assinatura liga o reuso; desligar nunca pede assinatura", () => {
    expect(opcaoSemAssinatura(COM_SEGREDO, { reuse_open_lead_on_capture: true })).toBeNull();
    expect(opcaoSemAssinatura(SEM_SEGREDO, { reuse_open_lead_on_capture: false })).toBeNull();
  });
});
