import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextResponse } from "next/server";

const { env } = vi.hoisted(() => ({
  env: {
    ADVOMAX_API_URL: "https://api.advomax.example",
    ADVOMAX_CRM_INTEGRATION_KEY: "integration-key",
    NEXT_PUBLIC_APP_URL: "https://crm.example",
  },
}));

vi.mock("@/lib/env", () => ({ env }));
vi.mock("@/lib/advomax/navigation", () => ({ advomaxAppUrl: () => "https://advomax.example" }));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => true }));

import { GET } from "./route";

describe("GET /auth/advomax/start", () => {
  beforeEach(() => {
    env.ADVOMAX_API_URL = "https://api.advomax.example";
    env.ADVOMAX_CRM_INTEGRATION_KEY = "integration-key";
  });

  it("abre o destino fixo com state base64url e vínculo de navegador curto", async () => {
    const response = await GET() as NextResponse;
    const destination = new URL(response.headers.get("location") ?? "");
    const state = destination.searchParams.get("state") ?? "";
    const cookie = response.cookies.get("advomax_sso_state");

    expect(destination.origin + destination.pathname).toBe("https://advomax.example/crm/entrar");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toMatchObject({ value: state, httpOnly: true, secure: true, sameSite: "lax", path: "/auth/advomax", maxAge: 300 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("sem configuração, recusa antes de gerar state", async () => {
    env.ADVOMAX_CRM_INTEGRATION_KEY = "";

    const response = await GET();

    expect(response.headers.get("location")).toBe("https://crm.example/login?error=sso_indisponivel");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
