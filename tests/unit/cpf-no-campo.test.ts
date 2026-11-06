/**
 * DEFESA EM PROFUNDIDADE: A ROTA CONTINUA RECUSANDO CPF INVÁLIDO (#3496).
 *
 * O conserto da #3496 é de TELA — o aviso passa a nascer no próprio campo. A
 * rota NÃO muda: `POST /api/v1/contacts` valida o corpo com
 * `contactCreateSchemaDoPais(perfil)`, cujo `cpf` é
 * `z.string().refine(isValidCpf, "CPF inválido").optional()`.
 *
 * Este arquivo exercita a rota de verdade, com corpo JSON direto e SEM passar
 * pelo formulário: é a prova de que um cliente que ignore o aviso (ou uma tela
 * futura que esqueça o `validate`) continua sendo barrado no servidor. Também
 * fixa que a máscara não muda o veredito do servidor — `isValidCpf` descarta os
 * separadores — e que o documento ausente segue opcional.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/legal/perfil-do-pais", async () => {
  const actual = await vi.importActual<typeof import("@/lib/legal/perfil-do-pais")>(
    "@/lib/legal/perfil-do-pais",
  );
  // A organização deste teste é brasileira: quem responde pelo documento é o
  // perfil BR, a MESMA régua que o formulário usa na tela.
  return { ...actual, perfilDaOrganizacao: vi.fn(async () => actual.perfilDoPais("BR")) };
});
vi.mock("@/app/api/v1/contacts/_handler", () => ({
  listContactsHandler: vi.fn(),
  createContactHandler: vi.fn(async () => ({ contact: { id: "contato-teste" }, action: "created" })),
}));

import { requireRole } from "@/lib/auth/require-role";
import { createContactHandler } from "@/app/api/v1/contacts/_handler";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function sessaoDeAgente(): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: USER_ID,
      email: "agente@example.test",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "agent" }],
    },
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  });
}

async function postar(corpo: Record<string, unknown>) {
  const { POST } = await import("@/app/api/v1/contacts/route");
  const req = new NextRequest("http://localhost/api/v1/contacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
  const res = await POST(req);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessaoDeAgente();
});

describe("POST /api/v1/contacts — o CPF que a tela deixar passar", () => {
  it("dígito verificador errado → 422 com o erro no CAMPO cpf, sem gravar", async () => {
    const { status, body } = await postar({ name: "Ana", cpf: "123.456.789-00" });

    expect(status).toBe(422);
    const erro = body.error as { code: string; details: { fieldErrors: Record<string, string[]> } };
    expect(erro.code).toBe("validation_error");
    expect(erro.details.fieldErrors.cpf).toContain("CPF inválido");
    expect(createContactHandler).not.toHaveBeenCalled();
  });

  it("onze dígitos repetidos → 422 (o mod-11 não aceita 111.111.111-11)", async () => {
    const { status, body } = await postar({ name: "Ana", cpf: "11111111111" });

    expect(status).toBe(422);
    const erro = body.error as { details: { fieldErrors: Record<string, string[]> } };
    expect(erro.details.fieldErrors.cpf).toContain("CPF inválido");
    expect(createContactHandler).not.toHaveBeenCalled();
  });

  it("válido COM máscara → 201, e o servidor recebe o documento como veio", async () => {
    const { status } = await postar({ name: "Ana", cpf: "529.982.247-25" });

    expect(status).toBe(201);
    expect(vi.mocked(createContactHandler).mock.calls[0]?.[2]).toMatchObject({
      cpf: "529.982.247-25",
    });
  });

  it("válido SEM máscara → 201, mesmo veredito da máscara", async () => {
    const { status } = await postar({ name: "Ana", cpf: "52998224725" });

    expect(status).toBe(201);
  });

  it("ausente continua opcional → 201", async () => {
    const { status } = await postar({ name: "Ana" });

    expect(status).toBe(201);
  });
});
