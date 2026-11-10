/**
 * Leva o navegador ao desafio do código, de volta para a tela atual. É a saída
 * de uma ação recusada com `mfa_required`: "entre de novo" não serve a quem
 * entrou por um dispositivo confiável, porque o login não pede o código.
 */
export function irAoDesafioDeMfa(): void {
  window.location.assign(`/login/mfa?next=${encodeURIComponent(window.location.pathname)}`);
}
