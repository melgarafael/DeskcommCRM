/**
 * Os serviços de push dos navegadores aceitos como destino de uma inscrição.
 * O servidor faz POST no `endpoint` gravado, então só entram hosts dos
 * serviços de push conhecidos, por https, sem porta nem credencial na URL.
 *
 * Testes: `servicos-de-push.test.ts`.
 */

/** Host exato. */
const HOSTS = new Set([
  "fcm.googleapis.com", // Chrome, Edge Android, Opera, Samsung Internet
  "updates.push.services.mozilla.com", // Firefox
]);

/** Subdomínio do serviço (o ponto inicial impede `evilpush.apple.com`). */
const SUFIXOS = [
  ".push.apple.com", // Safari (web.push.apple.com)
  ".notify.windows.com", // Edge no Windows (WNS)
];

export function ehServicoDePushConhecido(endpoint: string): boolean {
  if (!URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return false;
  return HOSTS.has(url.hostname) || SUFIXOS.some((s) => url.hostname.endsWith(s));
}
