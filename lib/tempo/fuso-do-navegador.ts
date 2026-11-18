/**
 * O fuso IANA que o navegador declara (`America/Mexico_City`), ou `undefined`.
 *
 * Para o CLIENTE: é a pista de onde a pessoa está, usada no cadastro e na
 * primeira escolha do "Onde você atende". Nunca lança — navegador antigo ou
 * `Intl` restrito devolve `undefined`, e quem chama segue com o padrão.
 */
export function fusoDoNavegador(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz.trim() !== "" ? tz : undefined;
  } catch {
    return undefined;
  }
}
