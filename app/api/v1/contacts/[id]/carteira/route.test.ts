import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";

/**
 * A PORTA DA CARTEIRA (#3026, herdada do #2591) — as DUAS pontas do gate.
 *
 * O bloco Carteira do painel do Inbox não tem regra própria de permissão: ele
 * chama a MESMA porta da ficha (`PATCH /api/v1/contacts/[id]/carteira`), e a
 * régua de escrita é a do servidor. Este arquivo mede o lado que a tela não
 * pode provar sozinha:
 *
 *   1. a rota COBRA `manager`+ (o `requireRole("manager")` é a régua, não o
 *      `ROLE_RANK` da tela);
 *   2. com a autorização NEGADA, a rota devolve a própria recusa (403) e não
 *      toca no banco — nada de gravar antes de decidir;
 *   3. com `manager`, a gravação sai pela função do banco
 *      (`fn_definir_carteira_do_cliente`) — a mesma porta que a ficha usa, sem
 *      segunda regra.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
  contato: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.auth }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit, isServiceRoleConfigured: () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => mocks.contato() }),
}));

import { PATCH } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "c0000000-0000-4000-8000-000000000001";
const DONO = "22222222-2222-4222-8222-222222222222";

/** A leitura do "antes" (audit) — encadeia os dois `.eq` como a rota escreve. */
function contatoAtual(carteira: string | null = null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: { id: CONTATO, carteira_user_id: carteira }, error: null }),
  };
  return chain;
}

function pedido(dono: string | null) {
  return new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/carteira`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dono_user_id: dono }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contato.mockReturnValue(contatoAtual());
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  mocks.auth.mockResolvedValue({
    ok: true,
    user: { id: DONO, idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: "manager" },
  });
});

describe("#3026 — a porta da carteira: quem não é manager+ não grava", () => {
  it("cobra a régua `manager`+ no servidor (não a da tela)", async () => {
    await PATCH(pedido(DONO), { params: Promise.resolve({ id: CONTATO }) });

    expect(mocks.auth).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "contacts" }));
  });

  it("com a autorização NEGADA devolve a recusa e não toca no banco", async () => {
    // É a recusa que o `requireRole` produz para um viewer/agent: 403 canônico.
    mocks.auth.mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Seu papel não permite esta ação.", 403),
    });

    const resposta = await PATCH(pedido(DONO), { params: Promise.resolve({ id: CONTATO }) });

    expect(resposta.status).toBe(403);
    expect(((await resposta.json()) as { error: { code: string } }).error.code).toBe("forbidden_role");
    // Nada de gravar antes de decidir: nem a RPC, nem a auditoria.
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("com `manager`, a gravação sai pela função do banco da carteira (mesma porta da ficha)", async () => {
    const resposta = await PATCH(pedido(DONO), { params: Promise.resolve({ id: CONTATO }) });

    expect(resposta.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fn_definir_carteira_do_cliente",
      expect.objectContaining({ p_org: ORG, p_actor: DONO, p_contact: CONTATO, p_dono: DONO }),
    );
  });
});
