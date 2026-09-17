/**
 * A TELA E A ROTA DE ETIQUETAS PEDEM O MESMO PAPEL QUE O BANCO (PR #955).
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 *
 * O PR entregou a página e as duas metades da rota com atalho de platform admin
 * (`allowPlatformAdmin: true` / `user.is_platform_admin && !user.support`). Só
 * que quem grava é `fn_vocabulario_de_tags_operar`, cujo portão é
 * `fn_role_at_least(p_org, 'manager')` — e `fn_role_at_least` resolve SÓ por
 * `fn_user_role_in_org`, sem ramo de platform admin (`supabase/baseline.sql`).
 * Resultado: um platform admin que não é manager+ NESTA organização via a tela
 * e os três botões, e toda ação dele voltava 403 depois do clique — controle
 * decorativo. A triagem tirou o atalho (commit 1aaced861); este arquivo é a
 * catraca que faltava: sem ele, devolver o atalho a qualquer um dos três pontos
 * deixava a suíte verde.
 *
 * O `requireRole` é o DE VERDADE: só as bordas (sessão, papel efetivo, banco)
 * são dublês. Um dublê de `requireRole` mediria a chamada, não o portão.
 *
 *     npx vitest run tests/unit/tags-vocabulario-sem-atalho-de-platform-admin.test.ts
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "00000000-0000-4000-8000-0000000000e5";

const estado = vi.hoisted(() => ({ papelNoBanco: "viewer", papelDaMembresia: "viewer" }));
const rpc = vi.hoisted(() => vi.fn());
const redirecionar = vi.hoisted(() =>
  vi.fn((destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  }),
);

/** Um platform admin fora do modo de acompanhamento — o caso do atalho. */
const PLATFORM_ADMIN = {
  id: "u-platform-admin",
  email: "pa@example.com",
  is_platform_admin: true,
  support: null,
  idioma: "pt-BR",
};

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => PLATFORM_ADMIN,
  requireAuth: async () => PLATFORM_ADMIN,
  resolveActiveOrg: async () => ({ orgId: ORG, name: "Org", role: estado.papelDaMembresia }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("next/navigation", () => ({ redirect: redirecionar, useRouter: () => ({ refresh: vi.fn() }) }));

import { GET, POST } from "@/app/api/v1/tags/vocabulario/route";
import TagsPage from "@/app/app/settings/tags/page";

/** As RPCs que a rota e a página chamam, na ordem em que chamaram. */
const chamadas = () => rpc.mock.calls.map((c) => c[0] as string);

function postar(corpo: unknown) {
  return POST(
    new NextRequest("http://localhost/api/v1/tags/vocabulario", {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  estado.papelNoBanco = "viewer";
  estado.papelDaMembresia = "viewer";
  redirecionar.mockClear();
  rpc.mockReset();
  rpc.mockImplementation(async (fn: string) => {
    if (fn === "fn_user_role_in_org") return { data: estado.papelNoBanco, error: null };
    if (fn === "fn_vocabulario_de_tags") return { data: [], error: null };
    if (fn === "fn_vocabulario_de_tags_operar") return { data: { contatos: 0 }, error: null };
    return { data: null, error: { message: `rpc inesperada: ${fn}` } };
  });
});

describe("platform admin sem papel de gerente NESTA organização", () => {
  it("⭐ GET da rota recusa com 403 antes de ler o vocabulário", async () => {
    const resposta = await GET();
    expect(resposta.status).toBe(403);
    expect(chamadas()).not.toContain("fn_vocabulario_de_tags");
  });

  it("⭐ POST da rota recusa com 403 antes de chamar a operação", async () => {
    const resposta = await postar({ acao: "renomear", tag: "vip", destino: "cliente-vip" });
    expect(resposta.status).toBe(403);
    expect(chamadas()).not.toContain("fn_vocabulario_de_tags_operar");
  });

  it("⭐ a página manda para /403 em vez de oferecer os três botões", async () => {
    await expect(TagsPage()).rejects.toThrow("REDIRECT:/403");
    expect(chamadas()).not.toContain("fn_vocabulario_de_tags");
  });
});

describe("CONTROLE: com papel de gerente a porta abre — senão os casos acima mediriam uma rota quebrada", () => {
  beforeEach(() => {
    estado.papelNoBanco = "manager";
    estado.papelDaMembresia = "manager";
  });

  it("GET devolve 200 e lê o vocabulário", async () => {
    const resposta = await GET();
    expect(resposta.status, await resposta.clone().text()).toBe(200);
    expect(chamadas()).toContain("fn_vocabulario_de_tags");
  });

  it("POST devolve 200 e chama a operação", async () => {
    const resposta = await postar({ acao: "renomear", tag: "vip", destino: "cliente-vip" });
    expect(resposta.status, await resposta.clone().text()).toBe(200);
    expect(chamadas()).toContain("fn_vocabulario_de_tags_operar");
  });

  it("a página lê o vocabulário sem redirecionar", async () => {
    await TagsPage();
    expect(redirecionar).not.toHaveBeenCalled();
    expect(chamadas()).toContain("fn_vocabulario_de_tags");
  });
});
