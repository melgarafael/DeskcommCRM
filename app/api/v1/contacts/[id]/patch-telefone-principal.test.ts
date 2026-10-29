/**
 * PATCH de contato e o telefone principal (Spec 31, B2, item 6 e B2 "PATCH aceita tipo e WhatsApp").
 *
 * Chama o handler real (`patchContactHandler`) com um cliente fake.
 *
 * ─── SABOTAGEM (o que faz este arquivo ficar vermelho) ─────────────────────
 * - Tirar o bloco de `primary_phone_has_extras` do handler: o caso "apagar o
 *   principal com extra → 409" cai (e o `update` aparece).
 * - Mover a checagem para DEPOIS do update: o caso "nada gravado" cai.
 * - Não copiar `phone_type` para o patch: o caso "tipo chega ao update" cai.
 */
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";

import { patchContactHandler } from "../_handler";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: () => Promise.resolve({ error: null }) }),
}));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: vi.fn(async () => null) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "44444444-4444-4444-8444-444444444444";

interface Fake {
  cliente: unknown;
  atualizou: () => boolean;
}

/**
 * `existing` é a ficha como o banco a devolve; `extras` é o que a consulta de
 * `contact_phones` acha. `update` registra se algo foi gravado na ficha.
 */
function fakeSupabase(existing: Record<string, unknown>, extras: unknown[]): Fake {
  let atualizou = false;
  const cliente = {
    from: (tabela: string) => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        is: () => q,
        limit: () => q,
        update: () => {
          if (tabela === "contacts") atualizou = true;
          return q;
        },
        maybeSingle: async () => ({
          data: tabela === "contacts" ? existing : null,
          error: null,
        }),
        then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
          Promise.resolve({ data: tabela === "contact_phones" ? extras : [], error: null }).then(ok, ko),
      };
      return q;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
  return { cliente, atualizou: () => atualizou };
}

const CTX = {
  organization_id: ORG,
  actor: { type: "user" as const, id: "11111111-1111-4111-8111-111111111111" },
  requestId: "req-1",
  idioma: "pt-BR" as const,
};

const FICHA = {
  id: CONTATO,
  organization_id: ORG,
  is_anonymized: false,
  tags: [],
  email: null,
  phone_number: "+5511999998888",
  name: "Cliente",
  display_name: null,
  consent: {},
  custom_fields: {},
};

describe("PATCH de contato — telefone principal", () => {
  it("apagar o principal (phone_number: null) de ficha COM extra → 409 primary_phone_has_extras, e nada gravado", async () => {
    const f = fakeSupabase(FICHA, [{ id: "55555555-5555-4555-8555-555555555555" }]);

    const erro = await patchContactHandler(f.cliente as never, CTX, CONTATO, { phone_number: null } as never).catch(
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(409);
    expect((erro as ApiError).code).toBe("primary_phone_has_extras");
    expect(f.atualizou()).toBe(false);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("apagar o principal de ficha SEM extra segue o caminho de sempre (grava o null)", async () => {
    const f = fakeSupabase(FICHA, []);

    await patchContactHandler(f.cliente as never, CTX, CONTATO, { phone_number: null } as never);

    expect(f.atualizou()).toBe(true);
  });

  it("phone_type e phone_whatsapp chegam ao update do contato", async () => {
    const f = fakeSupabase(FICHA, []);
    const gravados: Record<string, unknown>[] = [];
    const cliente = {
      ...(f.cliente as Record<string, unknown>),
      from: (tabela: string) => {
        const base = (f.cliente as { from: (t: string) => Record<string, unknown> }).from(tabela);
        return {
          ...base,
          update: (v: Record<string, unknown>) => {
            gravados.push(v);
            return base;
          },
        };
      },
    };

    await patchContactHandler(cliente as never, CTX, CONTATO, {
      phone_type: "fixo",
      phone_whatsapp: "nao",
    } as never);

    expect(gravados[0]).toMatchObject({ phone_type: "fixo", phone_whatsapp: "nao" });
  });
});
