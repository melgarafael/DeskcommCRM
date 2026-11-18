/**
 * O NOME DE QUEM ENVIOU DENTRO DO BALÃO (#4031) — só o primeiro nome.
 *
 * O rótulo é `Atendente · Andreia`, no mesmo formato de `IA · Clara`. Por que o
 * primeiro nome e não o nome inteiro: o balão tem a largura de uma mensagem de
 * conversa, e o rótulo divide essa linha com hora e confirmação de leitura. Numa
 * equipe de duas consultoras — o caso que abriu a issue — "Andreia" e "Thamyres"
 * distinguem o que "Andreia Cristina de Souza Lima" só faria esticar.
 *
 * A regra é pura e mora aqui, fora do componente, por dois motivos: é fácil de
 * prender num teste (nome composto, nome em branco, tipo errado) e o balão não
 * ganha mais um `if`.
 */

/**
 * O primeiro nome de `full_name`, ou `null` quando não há nome utilizável.
 *
 * `null` — e não `""` — de propósito: quem chama decide o rótulo de reserva
 * ("Atendente"), e uma string vazia viraria `"Atendente · "` com o separador
 * pendurado.
 *
 * Aceita `unknown` porque o dado chega de `auth.users.user_metadata`, que é
 * JSONB: já foi string, e um dia pode ser número, objeto ou o que o GoTrue
 * deixar. Nome que não é texto não vira rótulo.
 */
export function primeiroNomeDeQuemEnviou(nome: unknown): string | null {
  if (typeof nome !== "string") return null;
  const limpo = nome.trim();
  if (!limpo) return null;
  // `\s+` cobre espaço duplo, tab e quebra de linha — nome colado do cadastro
  // do Google chega com tudo isso.
  const primeiro = limpo.split(/\s+/)[0] ?? "";
  return primeiro.length > 0 ? primeiro : null;
}
