/**
 * COM O PROVEDOR DESLIGADO, ENTRAR COM GOOGLE NÃO PODE SAIR DO CRM.
 *
 * ─── O defeito, medido na issue #1652 ───────────────────────────────────────
 *
 * Com `external.google: false`, clicar em "Entrar com Google" mandava a pessoa
 * para uma página do GoTrue com JSON cru
 * (`{"code":400,"error_code":"validation_failed","msg":"Unsupported provider:
 * provider is not enabled"}`) — fora do CRM e sem caminho de volta. A tela já
 * tinha a mensagem certa embaixo do botão; quem não a mostrava era esta action,
 * porque esperava um `error` do `signInWithOAuth` que nunca vem: o auth-js só
 * monta a URL do `/authorize` localmente e devolve `{ data: { url } },
 * error: null`. O ramo `google_indisponivel` era código morto.
 *
 * ─── O que este arquivo guarda ──────────────────────────────────────────────
 *
 * 1. `external.google: false` → NÃO chama `redirect`, nem `signInWithOAuth`:
 *    devolve `google_indisponivel`, que é o que a tela transforma na mensagem.
 * 2. `external.google: true` → devolve a URL do Google para a TELA navegar
 *    (controle: sem ele, "nunca sai do CRM" ficaria verde e trancava o login).
 * 3. Leitura que FALHA (rede, HTTP 500, campo ausente) → comportamento de
 *    sempre, URL incluída: falta de rede não prova provedor desligado.
 *
 * ─── Por que a action NÃO chama `redirect()` ────────────────────────────────
 *
 * Quando o Supabase responde no MESMO domínio do app (o Traefik/Caddy manda
 * `/auth/v1` para o gateway — é o caso do `Caddyfile.single-server`), a URL do
 * `/authorize` é same-origin. O `redirect()` de server action vira então
 * navegação INTERNA do roteador do Next: a barra mostra `/auth/v1/authorize`,
 * nenhum pedido sai para o GoTrue e a tela de login fica parada até alguém
 * recarregar. Medido em produção (crm.seax.com.br, 29/10/2026): a resposta da
 * action trazia `x-action-redirect` e o navegador nunca pediu `/authorize`.
 * Quem navega é a tela, com `window.location.assign`, que é sempre carga
 * completa — qualquer que seja o domínio do Supabase.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { createClientDeEntradaComGoogle } from "@/lib/supabase/server";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
// Mock INTEIRA, e não parcial: o `@/lib/audit` de verdade puxa
// `createClient`/`createAdminClient` de `@/lib/supabase/server`, que este teste
// substitui por um cliente de mentira — o parcial quebraria no carregamento.
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({ createClientDeEntradaComGoogle: vi.fn() }));

const signInWithOAuth = vi.fn();
const URL_GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";

/** A forma exata que `GET /auth/v1/settings` devolve — só `external` importa. */
function settings(corpo: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
  } as unknown as Response;
}

function stubFetch(resposta: Response | Error) {
  const fetchFalso = vi.fn(async () => {
    if (resposta instanceof Error) throw resposta;
    return resposta;
  });
  vi.stubGlobal("fetch", fetchFalso);
  return fetchFalso;
}

beforeEach(() => {
  signInWithOAuth.mockReset().mockResolvedValue({ data: { url: URL_GOOGLE }, error: null });
  vi.mocked(redirect).mockClear();
  vi.mocked(audit).mockClear();
  vi.mocked(headers).mockResolvedValue({ get: () => null } as never);
  vi.mocked(createClientDeEntradaComGoogle).mockResolvedValue({
    auth: { signInWithOAuth },
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signInWithGoogle com o provedor Google desligado", () => {
  it("⭐ não redireciona: devolve google_indisponivel antes de montar a URL", async () => {
    const fetchFalso = stubFetch(settings({ external: { google: false } }));

    const { signInWithGoogle } = await import("./signInWithGoogle");
    const res = await signInWithGoogle();

    expect(res).toEqual({ ok: false, error: "google_indisponivel" });
    // Nem o OAuth (que montaria a URL do /authorize) nem o redirect: a pessoa
    // fica na tela, que é onde a mensagem embaixo do botão existe.
    expect(signInWithOAuth).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    // Nem auditoria: a action é pública e sem limite de tentativas, e cada
    // clique anônimo viraria 1 linha append-only em `api_audit_log`.
    expect(audit).not.toHaveBeenCalled();

    // A leitura é a rota pública certa, com a anon key — não um chute.
    const [url, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "")}/auth/v1/settings`);
    expect((init.headers as Record<string, string>).apikey).toBe(
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
  });

  it("CONTROLE — provedor LIGADO: devolve a URL do Google, sem redirect() do roteador", async () => {
    stubFetch(settings({ external: { google: true }, disable_signup: false }));

    const { signInWithGoogle } = await import("./signInWithGoogle");
    const res = await signInWithGoogle({ next: "/app/inbox" });

    expect(res).toEqual({ ok: true, url: URL_GOOGLE });
    expect(signInWithOAuth).toHaveBeenCalledTimes(1);
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: expect.stringContaining("/auth/callback") },
    });
    // `redirect()` de server action para URL same-origin vira navegação interna
    // do Next e trava a tela (ver cabeçalho). Quem navega é a tela.
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("a leitura das settings falha — o comportamento é o de sempre", () => {
  it("⭐ rede fora do ar: segue para o Google, sem inventar provedor desligado", async () => {
    stubFetch(new TypeError("fetch failed"));

    const { signInWithGoogle } = await import("./signInWithGoogle");
    const res = await signInWithGoogle();

    expect(signInWithOAuth).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, url: URL_GOOGLE });
  });

  it.each([
    ["HTTP 500", settings({ error: "boom" }, 500)],
    ["corpo sem o campo google", settings({ external: { github: true } })],
    ["corpo que não é JSON", { ok: true, status: 200, json: async () => { throw new SyntaxError("unexpected token"); } } as unknown as Response],
  ])("%s: comportamento atual, não regressão", async (_rotulo, resposta) => {
    stubFetch(resposta);

    const { signInWithGoogle } = await import("./signInWithGoogle");
    const res = await signInWithGoogle();

    expect(signInWithOAuth).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, url: URL_GOOGLE });
  });
});
