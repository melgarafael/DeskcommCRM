// @vitest-environment node
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import type { AuthUser } from "@/lib/auth/types";

/**
 * A FRONTEIRA ENTRE MARCA DA ORGANIZAÇÃO E MARCA DA INSTALAÇÃO — provada pela
 * ROTA, não só pelo texto de um E2E (issue #1272).
 *
 * ── O que aconteceu, e por que um E2E sozinho não basta ─────────────────────
 *
 * Um PR de fork mudou `route.ts` para gravar em `platform_branding` também no
 * escopo `organizacao` — o que deixa qualquer `admin` de qualquer tenant
 * repintar o `/login` da instalação inteira, e no DELETE apagar o arquivo do
 * dono do servidor. O MESMO diff inverteu a asserção de
 * `tests/e2e/marca-logo.spec.ts` para ela concordar com o bug. Uma guarda que
 * mora na mesma camada do código guardado pode ser afrouxada pelo commit que a
 * quebra, sem ninguém notar — o portão aprovou a própria quebra.
 *
 * `tests/invariants/marca-logo.test.ts` já prova que a FUNÇÃO do banco
 * (`fn_definir_logo_da_organizacao`) recusa caminho fora do escopo dela. O que
 * faltava é a metade de cima: prova de que a ROTA, para `escopo=organizacao`,
 * nem CHEGA a tocar `platform_branding` — porque o bug de origem não estava na
 * função (que segue correta), estava na ROTA decidindo chamar a coisa errada.
 *
 * ── Por que mock, e não Postgres real ────────────────────────────────────────
 *
 * A classe de regressão inteira é sobre QUAL tabela/RPC a ramificação de
 * `route.ts` chama para cada escopo — decisão em TypeScript, não em SQL. Um
 * espião no client do Supabase prova isso sem precisar de banco: mesmo padrão
 * de `app/api/v1/channels/social/route.test.ts` e outros 40 arquivos deste
 * repositório (`vi.mock` de `@/lib/auth/server` e `@/lib/supabase/admin`).
 */

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
// Nome no formato de `caminhoNovoDoLogo` (uuid.png): assim, quando `podeApagar`
// recusa, a recusa vem do PREFIXO, e não de um nome malformado.
const LOGO_DA_INSTALACAO = "platform/33333333-3333-4333-8333-333333333333.png";
const LOGO_DA_ORGANIZACAO = `${ORG_ID}/44444444-4444-4444-8444-444444444444.png`;

/** Só os 8 bytes que `farejarTipo` exige para reconhecer PNG (RFC 2083 §3.1). */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function arquivoPng(): File {
  return new File([PNG_BYTES], "logo.png", { type: "image/png" });
}

/**
 * O espião do admin client — registra toda tabela, RPC e remoção de storage
 * tocados, e simula sucesso em tudo. É ele que prova a ASSERÇÃO CENTRAL: para
 * `escopo=organizacao`, `platform_branding` nunca aparece em `fromChamadas`.
 */
function criarAdminEspiao(logoAnteriorDaOrganizacao: string | null = null) {
  const fromChamadas: string[] = [];
  const rpcChamadas: Array<{ nome: string; args: unknown }> = [];
  const removeChamadas: string[] = [];

  const client = {
    from: (tabela: string) => {
      fromChamadas.push(tabela);
      // Sem logo anterior, `apagarAnterior()` sai antes de `podeApagar` e o
      // `remove` nunca é chamado: qualquer asserção sobre `removeChamadas` passa
      // em branco. O DELETE que prova o Storage precisa de um caminho gravado.
      const linha =
        tabela === "organizations" && logoAnteriorDaOrganizacao
          ? { settings: { branding: { logo_path: logoAnteriorDaOrganizacao } } }
          : null;
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: linha, error: null }),
        upsert: async () => ({ error: null }),
      };
      return builder;
    },
    rpc: async (nome: string, args: unknown) => {
      rpcChamadas.push({ nome, args });
      return { data: 1, error: null };
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        remove: async (paths: string[]) => {
          removeChamadas.push(...paths);
          return { error: null };
        },
      }),
    },
  };

  return { client, fromChamadas, rpcChamadas, removeChamadas };
}

function usuarioAdminDeOrganizacao(): AuthUser {
  return {
    id: USER_ID,
    email: "admin@org.test",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "admin" }],
  } as AuthUser;
}

function usuarioDonoDoServidor(): AuthUser {
  return {
    id: USER_ID,
    email: "dono@instalacao.test",
    full_name: null,
    avatar_url: null,
    is_platform_admin: true,
    idioma: "pt-BR",
    organizations: [],
  } as AuthUser;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: "admin" } as never);
});

describe("POST /api/v1/marca/logo — escopo organizacao nunca toca platform_branding", () => {
  it("upload com escopo=organizacao nunca chama .from(\"platform_branding\")", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(usuarioAdminDeOrganizacao());
    const espiao = criarAdminEspiao();
    vi.mocked(createAdminClient).mockReturnValue(espiao.client as never);

    const form = new FormData();
    form.set("escopo", "organizacao");
    form.set("file", arquivoPng());

    const { POST } = await import("./route");
    const res = await POST(
      new NextRequest("http://localhost/api/v1/marca/logo", { method: "POST", body: form }),
    );

    expect(res.status, await res.clone().text()).toBe(200);
    expect(
      espiao.fromChamadas,
      "escopo=organizacao chamou .from() na tabela da INSTALAÇÃO",
    ).not.toContain("platform_branding");
    // Controle POSITIVO: a escrita aconteceu pelo caminho certo — sem isto,
    // "não chamou platform_branding" seria indistinguível de "não escreveu nada".
    expect(espiao.rpcChamadas.map((r) => r.nome)).toContain("fn_definir_logo_da_organizacao");
  });
});

describe("DELETE /api/v1/marca/logo — escopo organizacao nunca apaga o prefixo da instalação", () => {
  it("DELETE com escopo=organizacao nunca chama .from(\"platform_branding\") nem remove arquivo sob platform/", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(usuarioAdminDeOrganizacao());
    const espiao = criarAdminEspiao();
    vi.mocked(createAdminClient).mockReturnValue(espiao.client as never);

    const { DELETE } = await import("./route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/v1/marca/logo?escopo=organizacao", { method: "DELETE" }),
    );

    expect(res.status, await res.clone().text()).toBe(200);
    expect(
      espiao.fromChamadas,
      "DELETE de escopo=organizacao chamou .from() na tabela da INSTALAÇÃO",
    ).not.toContain("platform_branding");
    expect(
      espiao.removeChamadas.some((caminho) => caminho.startsWith("platform/")),
      `DELETE de escopo=organizacao removeu arquivo sob o prefixo da instalação: ${espiao.removeChamadas.join(", ")}`,
    ).toBe(false);
  });

  it("logo anterior adulterado para platform/ não é apagado, e a recusa fica no log", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(usuarioAdminDeOrganizacao());
    const espiao = criarAdminEspiao(LOGO_DA_INSTALACAO);
    vi.mocked(createAdminClient).mockReturnValue(espiao.client as never);
    const erro = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    onTestFinished(() => erro.mockRestore());

    const { DELETE } = await import("./route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/v1/marca/logo?escopo=organizacao", { method: "DELETE" }),
    );

    expect(res.status, await res.clone().text()).toBe(200);
    expect(
      espiao.removeChamadas,
      "DELETE de escopo=organizacao apagou o logo da INSTALAÇÃO a partir de um caminho adulterado",
    ).toEqual([]);
    expect(espiao.fromChamadas).not.toContain("platform_branding");
    // Recusa silenciosa seria indistinguível de "não havia nada para apagar".
    expect(erro).toHaveBeenCalledWith(
      expect.stringContaining("recusei apagar"),
      expect.objectContaining({ caminho_recusado: LOGO_DA_INSTALACAO }),
    );
  });

  it("controle positivo: logo anterior dentro do prefixo da organização é apagado", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(usuarioAdminDeOrganizacao());
    const espiao = criarAdminEspiao(LOGO_DA_ORGANIZACAO);
    vi.mocked(createAdminClient).mockReturnValue(espiao.client as never);

    const { DELETE } = await import("./route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/v1/marca/logo?escopo=organizacao", { method: "DELETE" }),
    );

    expect(res.status, await res.clone().text()).toBe(200);
    // Sem isto, "não removeu platform/" seria indistinguível de "o espião de
    // remove nunca é alcançado".
    expect(espiao.removeChamadas).toEqual([LOGO_DA_ORGANIZACAO]);
  });
});

describe("escopo=instalacao — só o dono do servidor alcança, e a organização nunca é tocada", () => {
  it("admin de ORGANIZAÇÃO (não platform admin) é barrado com 403 antes de qualquer escrita", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(usuarioAdminDeOrganizacao());
    const espiao = criarAdminEspiao();
    vi.mocked(createAdminClient).mockReturnValue(espiao.client as never);

    const form = new FormData();
    form.set("escopo", "instalacao");
    form.set("file", arquivoPng());

    const { POST } = await import("./route");
    const res = await POST(
      new NextRequest("http://localhost/api/v1/marca/logo", { method: "POST", body: form }),
    );

    expect(res.status).toBe(403);
    expect(espiao.fromChamadas, "recusou tarde: já tinha ido ao banco").toHaveLength(0);
    expect(espiao.rpcChamadas).toHaveLength(0);
  });

  it("dono do servidor grava em platform_branding, e a organização nunca é tocada", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(usuarioDonoDoServidor());
    const espiao = criarAdminEspiao();
    vi.mocked(createAdminClient).mockReturnValue(espiao.client as never);

    const form = new FormData();
    form.set("escopo", "instalacao");
    form.set("file", arquivoPng());

    const { POST } = await import("./route");
    const res = await POST(
      new NextRequest("http://localhost/api/v1/marca/logo", { method: "POST", body: form }),
    );

    expect(res.status, await res.clone().text()).toBe(200);
    expect(espiao.fromChamadas).toContain("platform_branding");
    expect(
      espiao.fromChamadas,
      "escopo=instalacao chamou .from() na tabela da ORGANIZAÇÃO",
    ).not.toContain("organizations");
    expect(espiao.rpcChamadas).toHaveLength(0);
  });
});
