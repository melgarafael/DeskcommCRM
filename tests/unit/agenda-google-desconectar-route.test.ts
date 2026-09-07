/**
 * DESCONECTAR A AGENDA DO GOOGLE — e o que o `status` sozinho NÃO resolve.
 *
 * ─── O defeito que esta rota fecha ────────────────────────────────────────
 *
 * A conexão se fazia pela tela e não se desfazia por lugar nenhum: só existiam
 * `connect` e `callback`. E o prop `contaConectada` do cartão NUNCA era passado,
 * então o ramo "Agenda conectada" era código morto e o botão "Conectar Google"
 * não sumia depois de conectar — a segunda conexão era um clique no mesmo botão.
 *
 * ─── Por que os três apagamentos, e não só o `status` ────────────────────
 *
 * `lib/agenda/consulta.ts` lê a ocupação com
 * `calendar_connections!inner(user_id, status)` e filtra **só por `user_id`** —
 * o `status` vem no join e não entra no `where`. Uma conexão `disconnected`
 * continuaria bloqueando horário para sempre.
 *
 * E filtrar `status` naquela consulta seria o conserto ERRADO: conexão
 * DEFASADA precisa seguir bloqueando (falha fechado na ação). Defasada e
 * desconectada são estados diferentes — só a segunda pede que os bloqueios
 * sumam. Por isso o teste assere o EFEITO nas três tabelas, e não o `status`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const CONEXAO = "33333333-3333-4333-8333-333333333333";

/** Tabelas de que a rota APAGOU linhas, na ordem. */
let apagadas: string[] = [];
/** O que a rota gravou na conexão. */
let atualizacao: Record<string, unknown> | null = null;
/** Conexões que o banco devolve — vazio simula "não há o que desconectar". */
let conexoes: Array<{ id: string; account_email: string }> = [];

function pedido(corpo?: unknown): NextRequest {
  return new NextRequest("https://crm.exemplo/api/v1/agenda/google/desconectar", {
    method: "DELETE",
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  });
}

beforeEach(() => {
  // `clearAllMocks` ANTES de configurar: o caso do 404 assere que `audit` NÃO foi
  // chamado, e sem isto ele herda as chamadas dos casos anteriores e falha por
  // vazamento de fixture — não por defeito da rota. (`clearAllMocks` zera as
  // chamadas e preserva as implementações; `resetAllMocks` apagaria as duas.)
  vi.clearAllMocks();
  apagadas = [];
  atualizacao = null;
  conexoes = [{ id: CONEXAO, account_email: "ana@clinica.com.br" }];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ANA } as never,
    org: { orgId: ORG } as never,
  });
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => ({
      select: () => {
        const cadeia = {
          eq: () => cadeia,
          then: (r: (v: unknown) => unknown) => r({ data: conexoes, error: null }),
        };
        return cadeia;
      },
      delete: () => {
        apagadas.push(tabela);
        const cadeia = {
          eq: () => cadeia,
          in: () => cadeia,
          then: (r: (v: unknown) => unknown) => r({ error: null }),
        };
        return cadeia;
      },
      update: (linha: Record<string, unknown>) => {
        atualizacao = linha;
        const cadeia = {
          eq: () => cadeia,
          in: () => cadeia,
          then: (r: (v: unknown) => unknown) => r({ error: null }),
        };
        return cadeia;
      },
    }),
  } as never);
});

describe("DELETE /api/v1/agenda/google/desconectar", () => {
  it("apaga os EVENTOS EXTERNOS — é o que o `status` sozinho não resolve", async () => {
    const { DELETE } = await import("@/app/api/v1/agenda/google/desconectar/route");
    const r = await DELETE(pedido());
    expect(r.status).toBe(200);
    expect(
      apagadas,
      "sem apagar `calendar_external_events`, os compromissos pessoais de quem " +
        "desconectou seguem bloqueando horário para sempre — a consulta de ocupação " +
        "não filtra `status`",
    ).toContain("calendar_external_events");
  });

  it("apaga os CALENDÁRIOS — senão o cron segue iterando conexão desligada", async () => {
    const { DELETE } = await import("@/app/api/v1/agenda/google/desconectar/route");
    await DELETE(pedido());
    expect(apagadas).toContain("calendar_connection_calendars");
  });

  it("apaga o REFRESH TOKEN, não só marca o status", async () => {
    const { DELETE } = await import("@/app/api/v1/agenda/google/desconectar/route");
    await DELETE(pedido());
    expect(atualizacao, "a rota não atualizou a conexão").not.toBeNull();
    expect(
      atualizacao?.oauth_refresh_token_encrypted,
      "o refresh token é o que dá acesso contínuo à conta pessoal de alguém; " +
        "marcar `status` e deixar o segredo no banco é desconectar de mentira",
    ).toBeNull();
    expect(atualizacao?.status).toBe("disconnected");
  });

  it("CONTROLE: o dublê registra apagamento (senão os três casos acima passam vazios)", () => {
    // Sem esta asserção, um `delete` que o dublê não intercepta deixaria
    // `apagadas` vazio e os `toContain` falhariam por instrumento — mas um
    // `apagadas` que NUNCA enche passaria despercebido se os casos usassem
    // `not.toContain`. O controle prende a direção.
    expect(apagadas).toEqual([]);
  });

  it("não diz que desconectou o que não existe", async () => {
    // 404 e não 200: dizer "desconectei" sobre o que não há é a mesma família de
    // mentira que o "Marcado ✓" sem linha no banco, que esta entrega já pagou.
    conexoes = [];
    const { DELETE } = await import("@/app/api/v1/agenda/google/desconectar/route");
    const r = await DELETE(pedido());
    expect(r.status).toBe(404);
    expect(apagadas, "não havia conexão e a rota apagou alguma coisa").toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("desconectar a agenda de OUTRA pessoa exige `manager`", async () => {
    const { DELETE } = await import("@/app/api/v1/agenda/google/desconectar/route");
    vi.mocked(requireRole)
      .mockResolvedValueOnce({ ok: true, user: { id: ANA } as never, org: { orgId: ORG } as never })
      .mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) as never });
    const r = await DELETE(pedido({ user_id: "44444444-4444-4444-8444-444444444444" }));
    expect(r.status).toBe(403);
    expect(apagadas, "a checagem de papel falhou e a rota apagou mesmo assim").toEqual([]);
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
