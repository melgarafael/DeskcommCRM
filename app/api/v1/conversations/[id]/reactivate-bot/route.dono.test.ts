/**
 * "Devolver ao automático" NÃO TIRA A CONVERSA DE OUTRO ATENDENTE (#3436).
 *
 * A rota soltava o dono (`fn_conversation_assign` com `release`), limpava o
 * silêncio e devolvia o comando ao agente para qualquer `agent` da organização,
 * sem olhar `conversations.assigned_to_user_id`. Agora: conversa com dono que
 * não é quem pediu só é devolvida por `manager` ou acima.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tirar o ramo de recusa da rota (`if (dono && … roleAtLeast …)`): o caso
 *   "agent na conversa de OUTRO atendente" acusa (200 em vez de 403).
 * - Trocar `roleAtLeast(activeOrg.role, "manager")` por `true`: o mesmo caso
 *   acusa — é o papel que decide, não a leitura do dono sozinha.
 *
 * O que este arquivo mede: a REGRA da rota (`devolverAtendimentoAoAgente` é
 * mockada). O isolamento por organização, com a função de verdade e dois
 * tenants semeados, está em `route.isolamento.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/escalacao/retomada", () => ({ devolverAtendimentoAoAgente: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const EU = "22222222-2222-4222-8222-222222222222";
const COLEGA = "33333333-3333-4333-8333-333333333333";
const CONVERSA = "44444444-4444-4444-8444-444444444444";

function sessao(role: string) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: EU, idioma: "pt-BR" },
    org: { orgId: ORG, role },
  } as Awaited<ReturnType<typeof requireRole>>);
}

/**
 * A conversa pertence a `dono` (ou a ninguém, com `null`). O dublê responde a
 * única leitura que a rota faz antes de devolver — e é de propósito que ele
 * NÃO implementa filtro: quem prova que o filtro de org existe é o teste de
 * isolamento, com a função de verdade.
 */
function conversaDe(dono: string | null) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.maybeSingle = async () => ({ data: { id: CONVERSA, assigned_to_user_id: dono }, error: null });
  vi.mocked(createClient).mockResolvedValue({ from: () => b } as never);
}

const chamar = () =>
  POST(new NextRequest(`http://localhost/api/v1/conversations/${CONVERSA}/reactivate-bot`, { method: "POST" }), {
    params: Promise.resolve({ id: CONVERSA }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(devolverAtendimentoAoAgente).mockResolvedValue({
    ok: true,
    conversationId: CONVERSA,
    jaEstavaComOAgente: false,
    continuidade: {
      houveAtendimentoHumano: true,
      resumo: "",
      decisoes: [],
      notas: [],
      chamados: [],
      pendenciaComOCliente: null,
    },
  } as Awaited<ReturnType<typeof devolverAtendimentoAoAgente>>);
});

describe("reactivate-bot e o dono da conversa (#3436)", () => {
  it("agent na conversa de OUTRO atendente: 403 e nada é devolvido", async () => {
    sessao("agent");
    conversaDe(COLEGA);
    const res = await chamar();
    const corpo = await res.json();

    expect(res.status).toBe(403);
    expect(corpo.error.code).toBe("forbidden");
    expect(corpo.error.message).toContain("outro atendente");
    expect(devolverAtendimentoAoAgente).not.toHaveBeenCalled();
  });

  it("CONTROLE: agent na conversa sem dono devolve (200)", async () => {
    sessao("agent");
    conversaDe(null);
    const res = await chamar();

    expect(res.status).toBe(200);
    expect(devolverAtendimentoAoAgente).toHaveBeenCalledTimes(1);
  });

  it("CONTROLE: agent na PRÓPRIA conversa devolve (200)", async () => {
    sessao("agent");
    conversaDe(EU);
    const res = await chamar();

    expect(res.status).toBe(200);
    expect(devolverAtendimentoAoAgente).toHaveBeenCalledTimes(1);
  });

  it("CONTROLE: manager na conversa do colega devolve (200)", async () => {
    sessao("manager");
    conversaDe(COLEGA);
    const res = await chamar();

    expect(res.status).toBe(200);
    expect(devolverAtendimentoAoAgente).toHaveBeenCalledTimes(1);
  });
});
