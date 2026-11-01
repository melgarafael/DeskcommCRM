/**
 * A inscrição aceita só serviços de push conhecidos (`servicos-de-push.ts`):
 * https, host do serviço do navegador, sem porta nem credencial na URL.
 *
 * Roda com: npx vitest run lib/notifications/servicos-de-push.test.ts
 */
import { describe, expect, it } from "vitest";

import { ehServicoDePushConhecido } from "./servicos-de-push";

describe("a inscrição aceita só serviços de push conhecidos", () => {
  it.each([
    ["FCM (Chrome, Edge Android, Opera, Samsung)", "https://fcm.googleapis.com/fcm/send/dXJ0:APA91bH-abc"],
    ["FCM, caminho wp", "https://fcm.googleapis.com/wp/dXJ0:APA91bH-abc"],
    ["Apple (Safari)", "https://web.push.apple.com/QGuQyavXutnMH3NIxgxM9Q"],
    ["Mozilla (Firefox)", "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk-abc"],
    ["Windows (Edge)", "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAD"],
  ])("aceita %s", (_nome, endpoint) => {
    expect(ehServicoDePushConhecido(endpoint)).toBe(true);
  });

  it.each([
    ["http", "http://fcm.googleapis.com/fcm/send/abc"],
    ["IPv4", "https://142.250.79.10/fcm/send/abc"],
    ["IPv6", "https://[::1]/fcm/send/abc"],
    ["localhost", "https://localhost/fcm/send/abc"],
    ["loopback", "https://127.0.0.1/fcm/send/abc"],
    ["host parecido (sufixo)", "https://fcm.googleapis.com.evil.tld/fcm/send/abc"],
    ["host parecido (prefixo)", "https://evilfcm.googleapis.com/fcm/send/abc"],
    ["host parecido (Windows)", "https://notify.windows.com.evil.tld/w/?token=x"],
    ["host parecido (Apple sem ponto)", "https://evilpush.apple.com/abc"],
    ["domínio do serviço sem subdomínio", "https://push.apple.com/abc"],
    ["outro host do Google", "https://googleapis.com/fcm/send/abc"],
    ["porta explícita", "https://fcm.googleapis.com:8443/fcm/send/abc"],
    ["credencial na URL", "https://user:senha@fcm.googleapis.com/fcm/send/abc"],
    ["ponto final no host", "https://fcm.googleapis.com./fcm/send/abc"],
    ["não é URL", "fcm.googleapis.com/fcm/send/abc"],
  ])("recusa %s", (_nome, endpoint) => {
    expect(ehServicoDePushConhecido(endpoint)).toBe(false);
  });
});
