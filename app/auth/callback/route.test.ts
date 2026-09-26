import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import { ensureTenantForUser, vinculoAtivo } from "@/lib/auth/provision";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { acessoFoiRevogado } from "@/lib/auth/vinculo-revogado";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /auth/callback — a volta da entrada com Google (issue #1388).
 *
 * O defeito que este arquivo existe para não deixar voltar: a volta do OAuth é
 * o ÚNICO ponto em que "entrar" e "criar conta" chegam juntos, sem e-mail no
 * meio para dizer qual é qual. Tratar todo mundo como cadastro novo tranca do
 * lado de fora quem já é de casa numa instalação `so_convite`; tratar todo mundo
 * como entrada abre organização para quem chegou sem convite. A bifurcação é o
 * VÍNCULO, e é ela que estes casos prendem.
 *
 * O SEGUNDO defeito deste arquivo é a ENTREGA (issue #1646): o destino final não
 * bastava. A falha fecha em `/login`, tela pública, e um 302 para lá funciona; o
 * SUCESSO vai para tela que exige sessão, e ali o 302 final continua a cadeia de
 * navegação começada em `accounts.google.com` — o cookie de sessão é
 * `sameSite: "strict"` e não viaja num initiator cross-site, então o `proxy.ts`
 * manda para `/login?next=%2Fapp` com a sessão já criada. Por isso os destinos
 * autenticados saem pela PONTE same-origin (`respostaDePonte`), e é isso que os
 * casos do fim do arquivo prendem.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/aplicar-convite", () => ({ aplicarConvite: vi.fn() }));
vi.mock("@/lib/auth/convite-no-signup", () => ({ decidirConviteDoSignup: vi.fn() }));
vi.mock("@/lib/auth/provision", () => ({
  ensureTenantForUser: vi.fn(async () => ({ provisioned: true })),
  vinculoAtivo: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: vi.fn(async () => "aberto") }));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: vi.fn(async () => false) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// A marca da ponte vem do banco (instalação → `.env` → padrão). Aqui é fixa:
// o caso é da PONTE, e sem o mock cada teste esperava a leitura que não responde.
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: vi.fn(async () => ({ nome: "Central de Teste" })),
}));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "http://localhost:3000" } }));

const USUARIO = { id: "11111111-1111-4111-8111-111111111111", email: "convidado@example.com" };
const PAYLOAD = {
  invite_id: "22222222-2222-4222-8222-222222222222",
  email: "convidado@example.com",
  organization_id: "33333333-3333-4333-8333-333333333333",
  role: "manager",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

interface Cenario {
  /** o que `exchangeCodeForSession` devolve */
  troca: { data: { user: unknown } | null; error: { message: string } | null };
  /** fatores TOTP que a conta já tem verificados */
  fatores?: { id: string; status: string }[];
}

function stubSupabase(c: Cenario) {
  return {
    auth: {
      exchangeCodeForSession: vi.fn(async () => c.troca),
      mfa: {
        listFactors: vi.fn(async () => ({ data: { totp: c.fatores ?? [] } })),
      },
    },
  };
}

function requisicao(qs: string) {
  return new NextRequest(`http://localhost:3000/auth/callback?${qs}`);
}

/**
 * O destino prometido pela resposta, sem o host — é o que o teste realmente
 * afirma. São DUAS entregas, e as duas aparecem aqui de propósito: as telas
 * públicas continuam saindo por `Location` (302), e a volta autenticada sai pela
 * PONTE, que leva o destino no script. Quem prende a ponte contra o 302 é a
 * asserção explícita de `location` nula — o destino sozinho não distingue as
 * duas, porque é o mesmo.
 */
async function destino(res: Response): Promise<string> {
  const location = res.headers.get("location");
  if (location) {
    const url = new URL(location);
    return url.pathname + url.search;
  }
  const script = (await res.clone().text()).match(/<script>(.*?)<\/script>/)![1]!;
  return JSON.parse(
    script.replace(/^window\.location\.replace\(/, "").replace(/\);$/, ""),
  ) as string;
}

async function comSupabase(c: Cenario) {
  vi.mocked(createClient).mockResolvedValue(
    stubSupabase(c) as unknown as Awaited<ReturnType<typeof createClient>>,
  );
  return await import("./route");
}

describe("GET /auth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: true, membershipId: "m1", mudou: true });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({ tipo: "provisionar" });
    vi.mocked(vinculoAtivo).mockResolvedValue(null);
    vi.mocked(modoDeCadastro).mockResolvedValue("aberto");
    vi.mocked(acessoFoiRevogado).mockResolvedValue(false);
  });

  it("conta nova com convite na URL: grava o vínculo e entra no app, sem empresa nova", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "convite",
      token: "tok",
      payload: PAYLOAD,
    } as ReturnType<typeof decidirConviteDoSignup>);

    const res = await GET(requisicao("code=abc&convite=tok"));

    // O convite da URL precisa CHEGAR à decisão: sem isto, quem foi convidado
    // e entrou com Google ganha uma organização própria.
    expect(vi.mocked(decidirConviteDoSignup)).toHaveBeenCalledWith(USUARIO, "tok");
    expect(vi.mocked(aplicarConvite)).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USUARIO.id, payload: PAYLOAD }),
    );
    expect(await destino(res)).toBe("/app");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("quem JÁ tem vínculo entra: vai para o destino pedido, e a política de cadastro não o alcança", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(vinculoAtivo).mockResolvedValue("org-existente");
    // Instalação fechada: quem já é de casa continua entrando.
    vi.mocked(modoDeCadastro).mockResolvedValue("so_convite");

    const res = await GET(requisicao("code=abc&next=%2Fapp%2Finbox"));

    expect(await destino(res)).toBe("/app/inbox");
    expect(vi.mocked(decidirConviteDoSignup)).not.toHaveBeenCalled();
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("conta nova sem convite em instalação so_convite: recusa pela política, sem provisionar", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(modoDeCadastro).mockResolvedValue("so_convite");

    const res = await GET(requisicao("code=abc"));

    expect(await destino(res)).toBe("/login?error=cadastro_por_convite");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("conta nova sem convite em instalação com_aprovacao: vai pedir a empresa, sem provisionar", async () => {
    // Recorte do PR #714 (migration 0383). A empresa nasce só na aprovação do
    // administrador da instalação; a volta do Google não pode ser o atalho.
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(modoDeCadastro).mockResolvedValue("com_aprovacao");

    const res = await GET(requisicao("code=abc"));

    expect(await destino(res)).toBe("/get-started");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("convite que não vale: falha FECHADA — não provisiona e diz o motivo", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "recusar",
      motivo: "email_divergente",
    });

    const res = await GET(requisicao("code=abc&convite=de-outra-pessoa"));

    expect(await destino(res)).toBe("/login?error=convite_invalido");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("conta nova sem convite em instalação aberta: provisiona e entra no onboarding", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });

    const res = await GET(requisicao("code=abc"));

    expect(vi.mocked(ensureTenantForUser)).toHaveBeenCalledWith(USUARIO, { source: "signup" });
    expect(await destino(res)).toBe("/onboarding/welcome");
  });

  it("quem tem TOTP verificado não entra sem o segundo fator", async () => {
    const { GET } = await comSupabase({
      troca: { data: { user: USUARIO }, error: null },
      fatores: [{ id: "factor-1", status: "verified" }],
    });

    const res = await GET(requisicao("code=abc&next=%2Fapp%2Finbox"));

    expect(await destino(res)).toBe("/login/mfa?factor=factor-1&next=%2Fapp%2Finbox");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("code que não vira sessão: nenhum provisionamento, e a tela de login explica", async () => {
    const { GET } = await comSupabase({
      troca: { data: null, error: { message: "PKCE code verifier not found in storage" } },
    });

    const res = await GET(requisicao("code=abc"));

    expect(await destino(res)).toBe("/login?error=entrada_com_google");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
    expect(vi.mocked(vinculoAtivo)).not.toHaveBeenCalled();
  });

  it("desistência no Google: mensagem própria, e não se troca code nenhum", async () => {
    const { GET } = await comSupabase({ troca: { data: null, error: null } });

    const res = await GET(requisicao("error=access_denied&error_description=denied"));

    expect(await destino(res)).toBe("/login?error=entrada_com_google_cancelada");
    expect(vi.mocked(createClient)).not.toHaveBeenCalled();
  });

  it("sem code nenhum: recusa em vez de tela em branco", async () => {
    const { GET } = await comSupabase({ troca: { data: null, error: null } });

    const res = await GET(requisicao(""));

    expect(await destino(res)).toBe("/login?error=entrada_com_google");
    expect(vi.mocked(createClient)).not.toHaveBeenCalled();
  });

  it("banco fora no provisionamento: a sessão JÁ está firme, então manda pro /get-started", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(ensureTenantForUser).mockRejectedValueOnce(new Error("sem banco"));

    const res = await GET(requisicao("code=abc"));

    expect(await destino(res)).toBe("/get-started");
  });

  it("membro com acesso revogado não vira admin de tenant novo: para na porta e diz o motivo", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(acessoFoiRevogado).mockResolvedValue(true);

    const res = await GET(requisicao("code=abc"));

    // `vinculoAtivo` não distingue "nunca pertenceu" de "teve o acesso
    // retirado" — e é essa diferença que impede a revogação de virar
    // organização nova com `role: "admin"`.
    expect(await destino(res)).toBe("/login?error=acesso_revogado");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
    expect(vi.mocked(aplicarConvite)).not.toHaveBeenCalled();
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.signup_provision_recusado",
        actorUserId: USUARIO.id,
        metadata: expect.objectContaining({ motivo: "acesso_revogado" }),
      }),
    );
  });

  it("a guarda do revogado vem ANTES da decisão de convite: o motivo auditado é o verdadeiro", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(acessoFoiRevogado).mockResolvedValue(true);

    const res = await GET(requisicao("code=abc&convite=de-outra-pessoa"));

    // Fora desta ordem a rota auditaria `convite_invalido` — motivo que não é a
    // verdade sobre o que aconteceu com quem foi revogado.
    expect(vi.mocked(decidirConviteDoSignup)).not.toHaveBeenCalled();
    expect(await destino(res)).toBe("/login?error=acesso_revogado");
  });

  it("leitura do vínculo falhou: FALHA FECHADA — não provisiona e a tela diz o motivo", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(vinculoAtivo).mockRejectedValueOnce(new Error("sem banco"));

    const res = await GET(requisicao("code=abc"));

    // "não consegui ler" não é "não há vínculo": a rota não pode seguir para o
    // provisionamento por causa de um tropeço de leitura.
    expect(await destino(res)).toBe("/login?error=entrada_com_google");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
    expect(vi.mocked(decidirConviteDoSignup)).not.toHaveBeenCalled();
  });

  it("ramo anônimo não escreve no rastro: sem `code` não há linha de auditoria", async () => {
    const { GET } = await comSupabase({ troca: { data: null, error: null } });

    const res = await GET(requisicao(""));

    // Rota pública: um GET por requisição de qualquer anônimo não pode virar
    // escrita em `api_audit_log`.
    expect(await destino(res)).toBe("/login?error=entrada_com_google");
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("desistência no Google também não escreve no rastro, mesmo com texto cru gigante na URL", async () => {
    const { GET } = await comSupabase({ troca: { data: null, error: null } });

    const res = await GET(requisicao(`error=access_denied&error_description=${"x".repeat(4000)}`));

    expect(await destino(res)).toBe("/login?error=entrada_com_google_cancelada");
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  // ─── #1646: a volta para tela AUTENTICADA sai pela PONTE, nunca por 302 ─────
  //
  // Um 302 daqui para `/app` continua a cadeia de navegação que começou em
  // `accounts.google.com`; o cookie de sessão é `sameSite: "strict"` e não viaja
  // num initiator cross-site. O `proxy.ts` não enxerga sessão e manda para
  // `/login?next=%2Fapp` — com a sessão JÁ criada. O que estes casos prendem é a
  // ENTREGA (documento same-origin com 200), não o destino: o destino é o mesmo
  // nos dois defeitos, e é por isso que a asserção de `location` nula importa.

  const CENARIOS_AUTENTICADOS: Array<[string, () => void, string]> = [
    [
      "entrada de quem já tem vínculo",
      () => vi.mocked(vinculoAtivo).mockResolvedValue("org-existente"),
      "/app",
    ],
    [
      "convite aceito na volta",
      () =>
        vi.mocked(decidirConviteDoSignup).mockReturnValue({
          tipo: "convite",
          token: "tok",
          payload: PAYLOAD,
        } as ReturnType<typeof decidirConviteDoSignup>),
      "/app",
    ],
    [
      "cadastro com aprovação",
      () => vi.mocked(modoDeCadastro).mockResolvedValue("com_aprovacao"),
      "/get-started",
    ],
    ["cadastro provisionado", () => {}, "/onboarding/welcome"],
  ];

  it.each(CENARIOS_AUTENTICADOS)(
    "todo destino que EXIGE sessão volta pela ponte same-origin: %s",
    async (_nome, montar, esperado) => {
      montar();
      const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });

      const res = await GET(requisicao("code=abc"));

      expect(
        res.headers.get("location"),
        "302 para tela autenticada continua a cadeia cross-site do Google: o cookie Strict não viaja nela",
      ).toBeNull();
      expect(res.status).toBe(200);
      expect(await destino(res)).toBe(esperado);
    },
  );

  it("a ponte volta com 200, hash de CSP que confere e sem `Location`", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(vinculoAtivo).mockResolvedValue("org-existente");

    const res = await GET(requisicao("code=abc&next=%2Fapp%2Finbox"));
    const html = await res.clone().text();
    const script = html.match(/<script>(.*?)<\/script>/)![1]!;

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(script).toBe('window.location.replace("/app/inbox");');
    // Hash que não bate = script bloqueado pelo CSP = pessoa presa no documento
    // em branco, que é pior do que o defeito original.
    expect(res.headers.get("content-security-policy")).toContain(
      createHash("sha256").update(script).digest("base64"),
    );
    expect(html).toContain('href="/app/inbox"');
  });

  it("a ponte não reflete o `next` cru: destino externo vira /app e nada dele entra no documento", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(vinculoAtivo).mockResolvedValue("org-existente");

    const res = await GET(
      requisicao(`code=abc&next=${encodeURIComponent("https://evil.example/app")}`),
    );
    const html = await res.clone().text();

    expect(await destino(res)).toBe("/app");
    expect(html).not.toContain("evil.example");
    expect(res.headers.get("location")).toBeNull();
  });

  it("`next` com `</script>` não quebra a ponte: um script só, e o valor sai escapado", async () => {
    // `safeNext` filtra o ESQUEMA, não sanitiza o conteúdo: `/app/</script>…` é
    // caminho relativo-na-raiz válido, e o destino dele chega a esta rota vindo
    // da URL. Sem escapar o `<`, o navegador fecharia o `<script>` da ponte no
    // meio do valor e o resto viraria script executável.
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(vinculoAtivo).mockResolvedValue("org-existente");
    const sujo = "/app/</script><script>alert(1)</script>";

    const res = await GET(requisicao(`code=abc&next=${encodeURIComponent(sujo)}`));
    const html = await res.clone().text();

    expect(await destino(res)).toBe(sujo);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toContain("</script><script>");
  });

  it("as recusas continuam 302 para a tela de login, com o cliente de jar Strict de sempre", async () => {
    // A ponte é só do SUCESSO. O caminho de falha termina em tela pública, onde
    // o 302 funciona e o cookie de sessão não é necessário — e o endurecimento
    // NÃO foi revertido: quem troca o `code` por sessão continua sendo o
    // `createClient` de `lib/supabase/server.ts` (jar Strict; o `lax` é só o
    // verificador de PKCE da IDA, cercado em
    // `tests/unit/entrada-com-google-verificador-viaja.test.ts`).
    const { GET } = await comSupabase({
      troca: { data: null, error: { message: "PKCE code verifier not found in storage" } },
    });

    const res = await GET(requisicao("code=abc"));

    expect(res.headers.get("location")).toContain("/login?error=entrada_com_google");
    expect([301, 302, 303, 307, 308]).toContain(res.status);
    expect(vi.mocked(createClient)).toHaveBeenCalledTimes(1);
  });
});
