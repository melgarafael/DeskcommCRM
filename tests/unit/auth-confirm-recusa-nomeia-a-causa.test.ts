/**
 * A RECUSA DE UM LINK DE E-MAIL PRECISA DIZER QUAL DAS DUAS COISAS QUEBROU.
 *
 * `/auth/confirm` aceita dois formatos de link e, até 2026-08-14, mandava os
 * dois para a MESMA tela: `/login?error=link_invalido` → "Link inválido ou
 * expirado. Peça um novo em Recuperar senha". Isso é conselho certo para um
 * caso e conselho ERRADO para o outro:
 *
 *  - `token_hash` (nossos templates): o link realmente expirou ou já foi usado.
 *    Pedir outro resolve.
 *  - `code` (template PADRÃO do Supabase): o link chega por PKCE, o verificador
 *    vive num cookie `sameSite: "strict"` (`lib/supabase/server.ts:35`, aplicado
 *    a TODO cookie do cliente — `@supabase/ssr/cookies.js:227,232`), e clique
 *    vindo de webmail é navegação cross-site: o cookie não viaja. Pedir outro
 *    link NÃO resolve — cada novo link falha igual. O conserto é configurar os
 *    templates (`self-host-kit/marca-emails.sh`).
 *
 * O sintoma enganoso mandava o operador caçar TTL e relógio do servidor. Este
 * teste prende a distinção nos DOIS sentidos: sem o segundo caso, alguém
 * "simplifica" os dois ramos de volta para uma mensagem só; sem o primeiro,
 * alguém troca tudo por `template_padrao` e passa a acusar de configuração o
 * link que de fato expirou.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/provision", () => ({ ensureTenantForUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com.br" } }));

import { GET } from "@/app/auth/confirm/route";

type Resultado = { data: { user: unknown }; error: { message: string } | null };

const RECUSA: Resultado = { data: { user: null }, error: { message: "Token has expired" } };

function supabaseQue(resposta: Resultado) {
  const verifyOtp = vi.fn(async () => resposta);
  const exchangeCodeForSession = vi.fn(async () => resposta);
  vi.mocked(createClient).mockResolvedValue({
    auth: { verifyOtp, exchangeCodeForSession },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return { verifyOtp, exchangeCodeForSession };
}

const chamar = (query: string) =>
  GET(new NextRequest(`https://crm.exemplo.com.br/auth/confirm${query}`));

/** O `Location` do redirect, sem o host. */
async function destino(query: string): Promise<string> {
  const res = await chamar(query);
  return new URL(res.headers.get("location") ?? "").search;
}

describe("/auth/confirm nomeia a causa da recusa", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("token_hash que falhou continua sendo `link_invalido` — pedir outro resolve", () => {
    supabaseQue(RECUSA);
    return expect(destino("?token_hash=abc&type=recovery")).resolves.toBe("?error=link_invalido");
  });

  it("code que falhou vira `template_padrao` — pedir outro NÃO resolve", async () => {
    supabaseQue(RECUSA);
    expect(await destino("?code=pkce_abc")).toBe("?error=template_padrao");
  });

  it("link sem token nenhum continua `link_invalido` e não chama o Supabase", async () => {
    const { verifyOtp, exchangeCodeForSession } = supabaseQue(RECUSA);
    expect(await destino("")).toBe("?error=link_invalido");
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("o audit registra QUAL formato falhou — sem isso a triagem começa do zero", async () => {
    supabaseQue(RECUSA);
    await chamar("?code=pkce_abc");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.email_link_rejected",
        metadata: expect.objectContaining({ formato: "code" }),
      }),
    );

    vi.clearAllMocks();
    supabaseQue(RECUSA);
    await chamar("?token_hash=abc&type=signup");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.email_link_rejected",
        metadata: expect.objectContaining({ formato: "token_hash" }),
      }),
    );
  });

  it("a tela do login tem texto para o código novo — senão a recusa fica muda", () => {
    // Sem este caso, `?error=template_padrao` chegaria a uma página que só
    // conhece `link_invalido` e `provisionamento`: nenhum aviso renderiza, e o
    // usuário vê a tela de login limpa, como se nada tivesse acontecido.
    // É o modo de falha mais silencioso possível — pior que a mensagem errada.
    const fonte = fs.readFileSync(
      path.join(process.cwd(), "app/(public)/login/page.tsx"),
      "utf8",
    );
    expect(fonte).toContain('error === "template_padrao"');
    expect(fonte).toContain("marca-emails.sh");
  });
});
