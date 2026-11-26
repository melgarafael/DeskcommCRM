/**
 * O PRAZO, em minutos, para o contato ABRIR o link de autorização — #5126.
 *
 * ── Por que isto é um módulo puro ───────────────────────────────────────────
 *
 * Três lugares precisam da MESMA régua: a tela (dica do campo), o cadastro
 * (gravação no jsonb `oauth_metadados`) e o pedido de autorização (cálculo do
 * `expira_em`). Se cada um escrevesse o clamp por conta própria, cedo ou tarde
 * a tela mostraria um número e o banco guardaria outro. Sem banco, sem logger,
 * sem `process.env` aqui — é importável do componente de cliente.
 *
 * ── O que NÃO muda ──────────────────────────────────────────────────────────
 *
 * O prazo é só o tempo em que o link pode ser ABERTO. `state` de 256 bits,
 * PKCE S256, `redirect_uri` fixo, uso único e `revogar_apos` seguem como
 * estavam. Quem não configura nada continua com 10 minutos, exatamente como
 * antes da issue — a faixa começa justamente no valor antigo (10), então não
 * existe configuração que ENCURTE o link.
 */

/** O prazo de quem não configurou nada — o comportamento anterior à #5126. */
export const PRAZO_DO_LINK_MINUTOS_PADRAO = 10;
/** Piso da faixa: igual ao padrão (a issue não permite encurtar o link de 10 min). */
export const PRAZO_DO_LINK_MINUTOS_MINIMO = 10;
/** Teto da faixa: 24 horas — um link de autorização não deve viver mais que um dia. */
export const PRAZO_DO_LINK_MINUTOS_MAXIMO = 1440;

/**
 * O prazo em minutos, JÁ saneado: inteiro, dentro de 10..1440.
 *
 * Ausente, `null`, `"abc"`, `NaN`, `Infinity`, booleano ou objeto → o padrão de
 * 10 minutos (fallback). Número fora da faixa → clamp no limite mais próximo
 * (0 e -5 viram 10; 99999 vira 1440). Nunca devolve `NaN`: quem multiplica por
 * 60_000 e soma em `Date.now()` nunca produz `Invalid Date`.
 */
export function prazoDoLinkEmMinutos(valor: unknown): number {
  const numero =
    typeof valor === "string" ? (valor.trim() === "" ? Number.NaN : Number(valor)) : valor;
  if (typeof numero !== "number" || !Number.isFinite(numero)) return PRAZO_DO_LINK_MINUTOS_PADRAO;
  const inteiro = Math.trunc(numero);
  return Math.min(PRAZO_DO_LINK_MINUTOS_MAXIMO, Math.max(PRAZO_DO_LINK_MINUTOS_MINIMO, inteiro));
}

/** O mesmo prazo em milissegundos — o que soma em `Date.now()` no pedido. */
export function validadeDoLinkMs(valor: unknown): number {
  return prazoDoLinkEmMinutos(valor) * 60 * 1000;
}
