/**
 * A ida do OAuth do Google: quem pode conectar, e o que a pessoa vê quando não dá.
 *
 * O que estes casos prendem é o CONTRATO DE NAVEGADOR: este endereço é aberto
 * por um clique, então nenhum desfecho pode ser JSON. Um erro em JSON deixa o
 * operador olhando para um objeto — e o defeito nem parece defeito, parece a
 * tela ter sumido.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
// O contrato da rota é testado contra as variáveis passadas ao cenário. Sem
// dublê, uma credencial salva no banco da máquina de quem roda a suíte vence o
// ambiente e torna os casos "sem chave" dependentes do estado local.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  }),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";

const usuario: AuthUser = {
  id: ANA,
  email: "ana@clinica.com.br",
  full_name: "Ana",
  avatar_url: null,
  is_platform_admin: false,
  idioma: "pt-BR" as const,
  // `organizations` é obrigatório em `AuthUser` e o dublê não o tinha — o
  // typecheck da árvore integrada pegou, o vitest não pegaria nunca: esbuild
  // apaga tipo sem conferir. É o motivo de `pnpm typecheck` não ser opcional.
  organizations: [{ organization_id: ORG, organization_name: "Clínica", role: "agent" }],
};
const orgAtiva: ActiveOrg = { orgId: ORG, name: "Clínica", role: "agent" };

function pedido(): NextRequest {
  return new NextRequest("https://crm.exemplo/api/v1/agenda/google/connect", {
    headers: { "x-request-id": "req-1" },
  });
}

function pedidoLocal(): NextRequest {
  return new NextRequest("http://localhost:3001/api/v1/agenda/google/connect", {
    headers: { "x-request-id": "req-local", host: "localhost:3001" },
  });
}

async function rotaComEnv(vars: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  return import("@/app/api/v1/agenda/google/connect/route");
}

const CONFIGURADO = {
  GOOGLE_CALENDAR_CLIENT_ID: "123.apps.googleusercontent.com",
  GOOGLE_CALENDAR_CLIENT_SECRET: "GOCSPX-segredo",
  NEXT_PUBLIC_APP_URL: "https://crm.exemplo",
  INTERNAL_SECRET: "um-segredo-de-instalacao-bem-comprido",
};

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva });
  vi.mocked(audit).mockClear();
});

describe("GET /api/v1/agenda/google/connect", () => {
  it("manda para o consentimento do Google com offline + consent + state", async () => {
    const { GET } = await rotaComEnv(CONFIGURADO);
    const res = await GET(pedido());

    expect(res.status).toBe(307);
    const destino = new URL(res.headers.get("location") ?? "");
    expect(destino.origin + destino.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(destino.searchParams.get("access_type")).toBe("offline");
    expect(destino.searchParams.get("prompt")).toBe("consent");
    expect(destino.searchParams.get("state")).toBeTruthy();
    // Sugerir a conta evita autorizar com a conta pessoal que já estava logada
    // no navegador e ver a agenda errada aparecer no CRM.
    expect(destino.searchParams.get("login_hint")).toBe("ana@clinica.com.br");
  });

  it("usa localhost como callback quando o navegador abre a instalação local por localhost", async () => {
    const { GET } = await rotaComEnv({ ...CONFIGURADO, NEXT_PUBLIC_APP_URL: "http://192.168.0.21:3001" });
    const res = await GET(pedidoLocal());
    const destino = new URL(res.headers.get("location") ?? "");
    expect(destino.searchParams.get("redirect_uri")).toBe("http://localhost:3001/api/v1/agenda/google/callback");
  });

  it("o `state` carrega a PESSOA, não só a organização", async () => {
    // A agenda do Google é por pessoa (`unique (organization_id, user_id, …)`).
    // Sem o user_id assinado no state, o callback teria de adivinhar de quem é
    // a agenda que acabou de ser autorizada.
    const { GET } = await rotaComEnv(CONFIGURADO);
    const res = await GET(pedido());
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";

    const { verificarEstado } = await import("@/lib/agenda/google/estado");
    expect(verificarEstado(state, { segredo: CONFIGURADO.INTERNAL_SECRET, agora: new Date() })).toMatchObject({
      organizationId: ORG,
      userId: ANA,
    });
  });

  it("sem chave na instalação, volta para a Agenda — nunca JSON, nunca 500", async () => {
    const { GET } = await rotaComEnv({ ...CONFIGURADO, GOOGLE_CALENDAR_CLIENT_ID: "" });
    const res = await GET(pedido());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://crm.exemplo/app/agenda?erro=google_nao_configurado");
  });

  it("instalação sem chave NÃO enche o audit log", async () => {
    // Audit se paga por linha, e "a instalação não configurou o Google" não é
    // tentativa de conectar nada — é o estado normal de um primeiro deploy.
    const { GET } = await rotaComEnv({ ...CONFIGURADO, GOOGLE_CALENDAR_CLIENT_SECRET: "" });
    await GET(pedido());
    expect(audit).not.toHaveBeenCalled();
  });

  it("segredo de assinatura curto RECUSA, e a recusa é auditada", async () => {
    // Com chave fraca o retorno do Google não seria verificável, e numa
    // instalação com mais de uma réplica o state de um processo não validaria no
    // outro — o sintoma seria "conectei e deu erro", intermitente e sem rastro.
    const { GET } = await rotaComEnv({ ...CONFIGURADO, INTERNAL_SECRET: "curto" });
    const res = await GET(pedido());
    expect(res.headers.get("location")).toBe("https://crm.exemplo/app/agenda?erro=segredo_indisponivel");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agenda.google.conexao_falhou" }),
    );
  });

  it("quem não tem papel não passa, e a resposta é a do gate — não um redirect", async () => {
    // Trocar o 403 do gate por um redirect esconderia a negativa do audit.
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "sem permissão", 403, { requestId: "req-1" }),
    });
    const { GET } = await rotaComEnv(CONFIGURADO);
    const res = await GET(pedido());
    expect(res.status).toBe(403);
  });

  it("pede `agent`, que é o mesmo piso que a 0177 exige para escrever compromisso", async () => {
    const { GET } = await rotaComEnv(CONFIGURADO);
    await GET(pedido());
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "calendar_connections" }));
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
