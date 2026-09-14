import { afterEach, describe, expect, it, vi } from "vitest";

import { advomaxAppUrl, advomaxProcessUrl } from "./navigation";

describe("navegação Advomax", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("usa o destino configurado e mantém o caminho interno", () => {
    vi.stubEnv("NEXT_PUBLIC_ADVOMAX_APP_URL", "http://localhost:5173");
    expect(advomaxAppUrl("/documentos")).toBe("http://localhost:5173/documentos");
  });

  it("recusa esquema inválido e mantém o destino local fora de produção", () => {
    vi.stubEnv("NEXT_PUBLIC_ADVOMAX_APP_URL", "javascript:alert(1)");
    expect(advomaxAppUrl("/home")).toBe("http://127.0.0.1:5173/home");
  });

  it("só usa o domínio público quando o runtime é produção", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ADVOMAX_APP_URL", "javascript:alert(1)");
    expect(advomaxAppUrl("/home")).toBe("https://advomax.com.br/home");
  });

  it("recusa host externo configurado em desenvolvimento", () => {
    vi.stubEnv("NEXT_PUBLIC_ADVOMAX_APP_URL", "https://advomax.com.br");
    expect(advomaxAppUrl("/home")).toBe("http://127.0.0.1:5173/home");
  });

  it("só cria deep link para códigos de processo válidos", () => {
    vi.stubEnv("NEXT_PUBLIC_ADVOMAX_APP_URL", "http://localhost:5173");
    expect(advomaxProcessUrl(42)).toBe("http://localhost:5173/fichaProcesso/42");
    expect(advomaxProcessUrl(0)).toBe("http://localhost:5173/home");
  });
});
