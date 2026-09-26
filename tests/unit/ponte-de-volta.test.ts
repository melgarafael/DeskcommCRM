import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { respostaDePonte } from "@/lib/auth/ponte-de-volta";

/**
 * A PONTE DE VOLTA — o documento same-origin que fecha uma navegação de OAuth.
 *
 * O que este arquivo prende é o CONTRATO do documento, que é o que faz o cookie
 * `sameSite: "strict"` voltar a viajar: 200 sem `Location` (um 302 continuaria a
 * cadeia cross-site do provedor), destino no script, hash do CSP batendo com o
 * script entregue e nenhum valor de fora entrando como HTML.
 */

function scriptDe(html: string): string {
  return html.match(/<script>(.*?)<\/script>/)![1]!;
}

describe("a ponte de volta", () => {
  it("entrega 200 same-origin, sem `Location`, com o destino no script e no fallback", async () => {
    const res = respostaDePonte("/app/inbox?aba=1", "Central de Teste", "Voltando para o sistema…");
    const html = await res.text();
    const script = scriptDe(html);

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(script).toBe('window.location.replace("/app/inbox?aba=1");');
    // Hash que não bate com o script entregue = script bloqueado pelo CSP =
    // pessoa presa no documento, sem saída.
    expect(res.headers.get("content-security-policy")).toContain(
      createHash("sha256").update(script).digest("base64"),
    );
    // Sem JS não há `location.replace`: o `<a>` é o caminho que sobra.
    expect(html).toContain('href="/app/inbox?aba=1"');
    expect(html).toContain("Voltando para o sistema…");
    expect(html).toContain("Central de Teste");
  });

  it("escapa marca, mensagem e destino — nada de fora entra como HTML", async () => {
    const res = respostaDePonte(
      '/app/a"><img src=x onerror=1>',
      "Marca <b>& Cia</b>",
      "Voltando & voltando",
    );
    const html = await res.text();

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("Marca &lt;b&gt;&amp; Cia&lt;/b&gt;");
    expect(html).toContain("Voltando &amp; voltando");
    // Dentro do `<script>` entidade HTML NÃO é decodificada: o valor do literal é
    // o destino cru, com as aspas fechadas pelo `JSON.stringify` e o `<` fora do
    // `<script>` pelo escape Unicode.
    expect(scriptDe(html)).toBe(
      'window.location.replace("/app/a\\">\\u003cimg src=x onerror=1>");',
    );
  });

  it("destino com `</script>` não fecha o script: um só, e o hash continua valendo", async () => {
    // O destino desta ponte vem de um `next` de URL filtrado por `safeNext`, que
    // barra o ESQUEMA e não sanitiza o conteúdo — `</script><script>…` é caminho
    // relativo-na-raiz válido para ele.
    const sujo = "/app/</script><script>alert(1)</script>";
    const res = respostaDePonte(sujo, "Central de Teste", "Voltando para o sistema…");
    const html = await res.text();
    const script = scriptDe(html);

    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toContain("</script><script>");
    expect(script).toBe(
      'window.location.replace("/app/\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");',
    );
    expect(res.headers.get("content-security-policy")).toContain(
      createHash("sha256").update(script).digest("base64"),
    );
  });
});
