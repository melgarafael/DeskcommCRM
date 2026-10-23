import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as PropostaDeDado from "@/lib/contacts/proposta-de-dado";

/**
 * O TRECHO DO CLIENTE NÃO VAI PARA A AUDITORIA (#2593).
 *
 * `api_audit_log` não é alcançada pela anonimização (só sai pela retenção, 5
 * anos por padrão). O `trecho` é texto livre do cliente — numa clínica pode
 * trazer dado de saúde — e não faz parte do par antes/depois da L-06. Por isso
 * ele mora na linha da timeline (`registrarTelefoneAplicadoNaTimeline`), que a
 * cascata da LGPD limpa; o caso do payload está em
 * `lib/contacts/proposta-de-dado.test.ts`.
 *
 * SABOTAGEM: recolocar `trecho: input.trecho ?? null` no metadata de
 * `contact.field_auto_applied` em `lib/mcp/tools/contacts.ts` — este caso cai.
 */

const { audit, proporDadoDoContato } = vi.hoisted(() => ({
  audit: vi.fn(async (_entrada: unknown) => undefined),
  proporDadoDoContato: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit }));
vi.mock("@/lib/contacts/proposta-de-dado", async (original) => ({
  ...(await original<typeof PropostaDeDado>()),
  proporDadoDoContato,
}));

const { crmProposeContactField } = await import("@/lib/mcp/tools/contacts");

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "33333333-3333-4333-8333-333333333333";

describe("telefone aplicado sozinho: o trecho fica fora da auditoria", () => {
  beforeEach(() => {
    audit.mockClear();
    proporDadoDoContato.mockReset();
  });

  it("contact.field_auto_applied guarda quem, o quê e quando — sem a chave trecho", async () => {
    proporDadoDoContato.mockResolvedValue({
      criada: false,
      motivo: "aplicado_automaticamente",
      telefone: "+5511999998888",
    });

    await crmProposeContactField.handler(
      {
        contact_id: CONTATO,
        campo: "phone_number",
        valor: "(11) 99999-8888",
        trecho: "meu número é (11) 99999-8888, e estou com dor de dente",
      },
      {
        organizationId: ORG,
        role: "agent",
        actor: { type: "ai_agent", id: "run-1", agent_id: null, role: "agent" },
        apiTokenId: "tok",
        requestId: "req-1",
        supabase: {} as never,
      } as never,
    );

    // O trecho ainda chega a quem grava a linha da timeline.
    expect(proporDadoDoContato.mock.calls[0]?.[1]).toMatchObject({
      trecho: "meu número é (11) 99999-8888, e estou com dor de dente",
    });

    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = audit.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(entrada.action).toBe("contact.field_auto_applied");
    expect(entrada.metadata).toMatchObject({
      campo: "phone_number",
      old_value: null,
      new_value: "+5511999998888",
      automatico: true,
    });
    expect(Object.keys(entrada.metadata)).not.toContain("trecho");
  });
});
