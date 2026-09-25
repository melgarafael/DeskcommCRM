import { describe, expect, it, vi } from "vitest";

// A marca vem do banco (instalação → `.env` → padrão). Aqui ela é fixa: o teste
// é da ponte, e sem o mock cada caso esperava ~7s pela leitura que não responde.
// O nome traz `<` e `&` de propósito — ele entra no HTML e tem de sair escapado.
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: vi.fn(async () => ({ nome: "Marca <b>& Cia</b>" })),
}));
import { createHash } from "node:crypto";
import { GET } from "@/app/auth/social-return/route";
import { isPublicPath } from "@/lib/auth/public-paths";
import { readFileSync } from "node:fs";

describe("social OAuth return", () => {
  it("expõe apenas o landing inerte, nunca a rota protegida de conexões", () => {
    expect(isPublicPath("/auth/social-return")).toBe(true);
    expect(isPublicPath("/auth/social-return/admin")).toBe(false);
    expect(isPublicPath("/app/connections")).toBe(false);
    expect(isPublicPath("/api/v1/channels/social")).toBe(false);
  });

  it("entrega um documento same-origin com destino fixo sem refletir tokens", async () => {
    const response = await GET(new Request("http://localhost/auth/social-return"));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const script = html.match(/<script>(.*?)<\/script>/)![1]!;
    expect(script).toBe('window.location.replace("/app/connections?aba=sociais");');
    expect(response.headers.get("content-security-policy")).toContain(
      createHash("sha256").update(script).digest("base64"),
    );
    expect(html).not.toContain("connect_token");
    expect(html).toContain("Voltando para suas conexões…");
    expect(html).toContain("Marca &lt;b&gt;&amp; Cia&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });

  // A tela de Redes sociais lê `error` e `connected` para dizer se a autorização
  // deu certo ou falhou. A ponte passa adiante só o SINAL, escolhido entre destinos
  // fixos — nenhum valor recebido (nem o `connect_token`) chega ao documento.
  it.each([
    ["?connected=facebook&connect_token=SEGREDO", "/app/connections?aba=sociais&connected=1"],
    ["?error=access_denied", "/app/connections?aba=sociais&error=1"],
    ["?error=x&connected=facebook", "/app/connections?aba=sociais&error=1"],
    ["", "/app/connections?aba=sociais"],
  ])("volta %j com o desfecho para %s sem refletir a query", async (query, esperado) => {
    const response = await GET(new Request(`http://localhost/auth/social-return${query}`));
    const html = await response.text();
    const script = html.match(/<script>(.*?)<\/script>/)![1]!;
    expect(script).toBe(`window.location.replace(${JSON.stringify(esperado)});`);
    expect(response.headers.get("content-security-policy")).toContain(
      createHash("sha256").update(script).digest("base64"),
    );
    for (const vazado of ["SEGREDO", "connect_token", "facebook", "access_denied"]) {
      expect(html).not.toContain(vazado);
    }
  });

  it("aponta novos fluxos de autorização emitidos para o landing", () => {
    expect(readFileSync("app/api/v1/channels/social/route.ts", "utf8")).toContain(
      "redirect_url: `${publicBase()}/auth/social-return`",
    );
  });
});
