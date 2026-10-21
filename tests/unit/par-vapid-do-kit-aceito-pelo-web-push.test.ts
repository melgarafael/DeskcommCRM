// @vitest-environment node
/**
 * O par VAPID que o kit gera (`gerar_par_vapid`, em hostgator-setup-kit/_common.sh)
 * é aceito pela MESMA biblioteca que envia o push em produção
 * (`lib/notifications/web_push.ts`), e a pública é de fato a da privada.
 *
 * O teste de shell confere o formato byte a byte; este confere o consumidor. Um
 * par com o formato certo e as metades trocadas, ou de outra curva, passaria no
 * shell e só falharia no primeiro envio, numa VPS, em silêncio. Rodando no job
 * `verify` do CI, ele também mede o openssl do Ubuntu do runner.
 */
import { execFileSync } from "node:child_process";
import { createECDH } from "node:crypto";
import path from "node:path";
import webpush from "web-push";
import { describe, expect, it } from "vitest";

const COMMON = path.join(process.cwd(), "hostgator-setup-kit", "_common.sh");

function gerarPar(): { pub: string; priv: string } {
  const out = execFileSync("bash", ["-c", `. '${COMMON}' && gerar_par_vapid`], {
    encoding: "utf8",
  }).trim();
  const [pub, priv, ...resto] = out.split(" ");
  expect(resto, `saída inesperada: ${out}`).toEqual([]);
  return { pub: pub ?? "", priv: priv ?? "" };
}

describe("par VAPID gerado pelo kit", () => {
  it("5 pares seguidos: formato, curva e aceite pelo web-push", () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { pub, priv } = gerarPar();

      const pubBytes = Buffer.from(pub, "base64url");
      const privBytes = Buffer.from(priv, "base64url");
      expect(pubBytes.length).toBe(65);
      expect(pubBytes[0]).toBe(4);
      expect(privBytes.length).toBe(32);

      // A pública é a da privada (P-256), não uma qualquer com o tamanho certo.
      const ecdh = createECDH("prime256v1");
      ecdh.setPrivateKey(privBytes);
      expect(ecdh.getPublicKey().equals(pubBytes)).toBe(true);

      expect(() => webpush.setVapidDetails("mailto:a@b.c", pub, priv)).not.toThrow();
      expect(() =>
        webpush.getVapidHeaders("https://push.exemplo.invalid", "mailto:a@b.c", pub, priv, "aes128gcm"),
      ).not.toThrow();

      vistos.add(priv);
    }
    // Cinco pares distintos: um gerador que devolvesse sempre o mesmo par
    // daria a todas as instalações a mesma chave.
    expect(vistos.size).toBe(5);
  });
});
