import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { env } from "@/lib/env";
import { cookieSecure } from "./cookie-secure";

vi.mock("@/lib/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "http://localhost:3000" },
}));

/** Achado nº 8 (VPS): Secure=true em HTTP descartava o cookie → login em loop. */
describe("cookieSecure — derivado do protocolo do app, não de NODE_ENV", () => {
  it("https → Secure (produção com TLS)", () => {
    env.NEXT_PUBLIC_APP_URL = "https://crm.exemplo.com.br";
    expect(cookieSecure()).toBe(true);
  });

  it("http → NÃO-Secure (self-host sem TLS — o caso da VPS em porta alta)", () => {
    env.NEXT_PUBLIC_APP_URL = "http://129.121.45.100:18080";
    expect(cookieSecure()).toBe(false);
  });

  it("default de lib/env (http://localhost:3000) → NÃO-Secure em dev", () => {
    env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    expect(cookieSecure()).toBe(false);
  });

  /**
   * Regressão da 2ª causa raiz (VPS): `process.env.NEXT_PUBLIC_*` como acesso
   * literal é INLINADO pelo compilador do Next em build time — a imagem Docker
   * genérica builda com placeholder https e Secure congela em true. O valor
   * TEM de vir de lib/env (parse do objeto process.env em runtime).
   */
  it("nunca lê process.env.NEXT_PUBLIC_* direto (inline de build quebraria o runtime)", () => {
    const source = readFileSync(join(__dirname, "cookie-secure.ts"), "utf8");
    expect(source).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
    expect(source).toMatch(/from "@\/lib\/env"/);
  });
});
