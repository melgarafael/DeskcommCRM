// tests/unit/cabecalhos-de-seguranca-do-painel.test.ts
//
// Os cabeçalhos vivem na configuração do Next, que só é exercitada num servidor
// de verdade: um erro aqui não aparece em teste de componente nem em typecheck,
// e chega em produção com o painel aceitando ser embutido ou servido em http.
// Este teste lê a MESMA função que o Next lê no boot.
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

describe("cabeçalhos de segurança do painel", () => {
  it("toda resposta traz transporte forçado, CSP de enquadramento e MIME não adivinhado", async () => {
    const grupos = (await nextConfig.headers?.()) ?? [];
    const doApp = grupos.find((grupo) => grupo.source === "/(.*)");
    expect(doApp, "o grupo de cabeçalhos da aplicação desapareceu").toBeDefined();

    const porNome = new Map((doApp?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]));

    // O proxy na frente (Caddy do kit, Traefik, Cloudflare) não manda HSTS: quem responde é a origem.
    expect(porNome.get("strict-transport-security")).toMatch(/^max-age=\d{8,}/);
    // O domínio é do cliente e pode ser o apex: includeSubDomains forçaria HTTPS em subdomínios que o app não conhece.
    expect(porNome.get("strict-transport-security")).not.toContain("includeSubDomains");
    const csp = porNome.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    // Curta de propósito: restringir script-src sem nonce quebraria o bootstrap do Next.
    expect(csp).not.toContain("script-src");

    // O que já existia não pode cair numa edição futura desta lista.
    expect(porNome.get("x-frame-options")).toBe("DENY");
    expect(porNome.get("x-content-type-options")).toBe("nosniff");
    expect(porNome.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    // microphone=(self) é o gravador de voz do composer: bloquear quebraria o PTT.
    expect(porNome.get("permissions-policy")).toContain("microphone=(self)");
  });

  it("o service worker continua fora do cache", async () => {
    const grupos = (await nextConfig.headers?.()) ?? [];
    const doWorker = grupos.find((grupo) => grupo.source === "/notify-sw.js");
    const porNome = new Map((doWorker?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]));
    expect(porNome.get("cache-control")).toBe("no-cache");
  });
});
