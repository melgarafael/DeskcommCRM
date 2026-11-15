import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A RECUSA "SEM INTERESSE" SÓ SE DESFAZ PELA PORTA DELA (decisão D3).
 *
 * O DELETE de `/api/v1/contacts/[id]/sem-interesse` exige administrador e audita
 * `recusa_desfeita`. O PATCH de contato (papel `agent`, inclusive por token de API)
 * aceita `consent` livre e faz merge por finalidade: sem a trava, mandar
 * `marketing: { granted: true }` apagava a recusa sem rastro e devolvia o contato à
 * prospecção e às Campanhas.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * Tirar o `if` da recusa em `patchContactHandler` (`app/api/v1/contacts/_handler.ts`):
 * o primeiro caso fica vermelho, e só ele.
 */
const auditSpy = vi.fn(async (_entrada: { metadata?: Record<string, unknown> }) => undefined);
vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

import { consentComSemInteresse } from "@/lib/lgpd/sem-interesse";

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const CONTATO = "c05e7a00-0000-4000-8000-0000000000c1";
const USUARIO = "c05e7a00-0000-4000-8000-0000000000a1";

let estadoAtual: Record<string, unknown>;
let gravado: Record<string, unknown> | null;

function clienteFalso(): unknown {
  return {
    from: () => ({
      select: () => {
        const chain = { eq: () => chain, maybeSingle: async () => ({ data: estadoAtual, error: null }) };
        return chain;
      },
      update: (patch: Record<string, unknown>) => {
        gravado = patch;
        const chain = {
          eq: () => chain,
          select: () => chain,
          maybeSingle: async () => ({ data: { ...estadoAtual, ...patch }, error: null }),
        };
        return chain;
      },
    }),
    rpc: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }),
  };
}

async function patch(input: Record<string, unknown>): Promise<void> {
  const { patchContactHandler } = await import("@/app/api/v1/contacts/_handler");
  await patchContactHandler(
    clienteFalso() as never,
    { organization_id: ORG, actor: { type: "user", id: USUARIO }, requestId: "req-1" },
    CONTATO,
    input as never,
  );
}

const RECUSA = consentComSemInteresse(
  { transactional: { granted: true } },
  { agora: "2026-11-14T12:00:00.000Z", origem: "conversa_de_prospeccao" },
) as Record<string, unknown>;

beforeEach(() => {
  auditSpy.mockClear();
  gravado = null;
  estadoAtual = {
    id: CONTATO,
    organization_id: ORG,
    is_anonymized: false,
    tags: [],
    email: null,
    phone_number: "+5585999999999",
    name: "Oficina do Zé",
    display_name: "Oficina do Zé",
    consent: RECUSA,
  };
});

describe("PATCH de contato e a recusa 'sem interesse'", () => {
  it("trocar consent.marketing por cima da recusa é recusado (409), e nada é gravado", async () => {
    await expect(patch({ consent: { marketing: { granted: true } } })).rejects.toMatchObject({
      status: 409,
      code: "state_conflict",
    });
    expect(gravado).toBeNull();
  });

  it("reenviar a MESMA recusa passa (o editor que manda o objeto que leu)", async () => {
    await patch({ consent: { marketing: RECUSA.marketing } });
    expect(gravado).not.toBeNull();
  });

  it("gravar outra finalidade passa e mantém a recusa", async () => {
    await patch({ consent: { profiling: { granted: true } } });
    expect((gravado?.consent as Record<string, unknown>).marketing).toEqual(RECUSA.marketing);
  });

  it("sem a recusa 'sem interesse', o PATCH de marketing segue como sempre", async () => {
    estadoAtual.consent = { marketing: { granted: false, declined_at: "2026-11-01T00:00:00.000Z" } };
    await patch({ consent: { marketing: { granted: true } } });
    expect((gravado?.consent as Record<string, unknown>).marketing).toEqual({ granted: true });
  });
});
