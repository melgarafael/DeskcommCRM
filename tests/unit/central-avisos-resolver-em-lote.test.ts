/**
 * RESOLVER TODOS OS AVISOS SÓ ALCANÇA A ORGANIZAÇÃO DE QUEM CLICOU.
 *
 * ## Por que uma tabela de mentira em vez de espiar as chamadas
 *
 * O jeito barato de "provar" escopo é gravar os `.eq()` e conferir que
 * `["organization_id", org]` está na lista. Isso guarda a CHAMADA, não o
 * efeito: um `.eq("organization_id", …)` aplicado ao lugar errado, ou um
 * `.or()` acrescentado depois dele, satisfaz a asserção e continua resolvendo o
 * aviso do vizinho. O `admin` daqui é service role — ele bypassa RLS, então o
 * único filtro que existe é o que a rota escreve, e o teste tem de medir o que
 * SOBROU na tabela.
 *
 * Por isso a fixture é uma tabelinha em memória que APLICA os predicados: se a
 * rota perder o filtro de organização, a linha da outra org muda de status e o
 * caso estoura; se perder o `status = 'open'`, a contagem sobe e estoura
 * também. Nenhum dos dois é visível espiando argumento.
 *
 * ## O que mais está preso aqui
 *
 * `resourceId: null` no audit. `api_audit_log.resource_id` é `uuid`; um rótulo
 * como `"bulk"` faz o insert falhar com `invalid input syntax for type uuid` —
 * e o audit é fire-and-forget, então a mutação de 144 linhas seguiria verde com
 * a trilha PERDIDA. O modo de falha está documentado no cabeçalho de
 * `lib/audit/index.ts`; aqui ele fica preso.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/v1/ai/inbox/resolve-all/route";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const ATOR = "22222222-2222-4222-8222-222222222222";

interface Linha {
  id: string;
  organization_id: string;
  status: "open" | "ack" | "resolved";
}

let tabela: Linha[];
let erroDoBanco: { message: string } | null;

/** Cliente de mentira que APLICA os `.eq()` — o efeito é o que se mede. */
function adminFalso() {
  return {
    from(nome: string) {
      expect(nome).toBe("agent_inbox_items");
      const filtros: Array<[keyof Linha, unknown]> = [];
      let patch: Partial<Linha> | null = null;
      const cadeia = {
        update(p: Partial<Linha>) {
          patch = p;
          return cadeia;
        },
        eq(coluna: keyof Linha, valor: unknown) {
          filtros.push([coluna, valor]);
          return cadeia;
        },
        // O recorte de destinatário (0689) — os avisos daqui são todos da
        // empresa; o efeito dele é medido em `central-aviso-com-destinatario`.
        or() {
          return cadeia;
        },
        select() {
          if (erroDoBanco) return Promise.resolve({ data: null, error: erroDoBanco });
          const alvo = tabela.filter((linha) => filtros.every(([c, v]) => linha[c] === v));
          if (patch) for (const linha of alvo) Object.assign(linha, patch);
          return Promise.resolve({ data: alvo.map((l) => ({ id: l.id })), error: null });
        },
      };
      return cadeia;
    },
  };
}

const abertosDe = (org: string) =>
  tabela.filter((l) => l.organization_id === org && l.status === "open").map((l) => l.id);

beforeEach(() => {
  vi.clearAllMocks();
  erroDoBanco = null;
  tabela = [
    { id: "a1", organization_id: ORG, status: "open" },
    { id: "a2", organization_id: ORG, status: "open" },
    { id: "a3", organization_id: ORG, status: "resolved" },
    { id: "b1", organization_id: OUTRA_ORG, status: "open" },
  ];
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG, role: "agent", name: "Org" },
    user: { id: ATOR, idioma: "pt-BR" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockReturnValue(
    adminFalso() as unknown as ReturnType<typeof createAdminClient>,
  );
});

describe("POST /api/v1/ai/inbox/resolve-all", () => {
  it("resolve os abertos da org de quem chamou e NÃO encosta na outra organização", async () => {
    const resposta = await POST();

    expect(resposta.status).toBe(200);
    expect((await resposta.json()).data).toEqual({ resolved_count: 2 });
    expect(abertosDe(ORG), "sobrou aviso aberto na org de quem clicou").toEqual([]);
    expect(
      abertosDe(OUTRA_ORG),
      "o lote alcançou a organização vizinha — o service role bypassa RLS, o filtro é a única cerca",
    ).toEqual(["b1"]);
    // A linha já resolvida não entra na conta: `status = 'open'` é predicado, não enfeite.
    expect(tabela.find((l) => l.id === "a3")!.status).toBe("resolved");
  });

  it("audita UMA vez, com a contagem, sem resource_id e correlacionado ao X-Request-Id", async () => {
    const resposta = await POST();
    const requestId = resposta.headers.get("X-Request-Id");

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(audit).toHaveBeenCalledExactlyOnceWith({
      action: "ai.inbox_item_status_changed",
      actorUserId: ATOR,
      organizationId: ORG,
      resourceType: "agent_inbox_items",
      // `uuid` no banco: um rótulo aqui derruba o insert e a trilha some em silêncio.
      resourceId: null,
      requestId,
      metadata: { status: "resolved", bulk: true, count: 2 },
    });
  });

  it("rodada sem nada aberto responde zero e NÃO audita (não houve mutação)", async () => {
    tabela = tabela.map((l) => ({ ...l, status: "resolved" as const }));
    const resposta = await POST();

    expect((await resposta.json()).data).toEqual({ resolved_count: 0 });
    expect(audit).not.toHaveBeenCalled();
  });

  it("erro do banco vira 500 e não afirma que resolveu nada", async () => {
    erroDoBanco = { message: "boom" };
    const resposta = await POST();

    expect(resposta.status).toBe(500);
    expect((await resposta.json()).error.code).toBe("internal_error");
    expect(audit).not.toHaveBeenCalled();
    expect(abertosDe(ORG)).toEqual(["a1", "a2"]);
  });

  it("acompanhamento somente-leitura é barrado ANTES de o service role existir", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(
      new Response(null, { status: 403 }) as Awaited<ReturnType<typeof requireSupportWrite>>,
    );
    const resposta = await POST();

    expect(resposta.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(abertosDe(ORG)).toEqual(["a1", "a2"]);
  });

  it.each([401, 403])("sem papel suficiente (%i) o banco não é tocado", async (status) => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status }),
    } as Awaited<ReturnType<typeof requireRole>>);
    const resposta = await POST();

    expect(resposta.status).toBe(status);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.any(Object));
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(abertosDe(ORG)).toEqual(["a1", "a2"]);
  });
});
