/**
 * Identidades do contato — a mesma pessoa vista por cada rede social.
 *
 * ─── Por que isto não é `contacts.social_identity` com outro nome ───────────
 * `contacts.social_identity` guarda UM perfil por ficha, e é por ele que a
 * ingestão das redes acha a ficha de quem escreveu. Quando duas fichas são
 * juntadas e cada uma tem o seu (o Instagram de uma, o Facebook da outra), o da
 * absorvida ficava na lápide, e a próxima conversa daquela pessoa criava uma
 * ficha nova. `contact_identities` (migration 9419) guarda quantas identidades a
 * ficha tiver, e a fusão as reponta para a vencedora.
 *
 * Telefone e e-mail NÃO moram aqui: já têm guarda única por organização
 * (`contacts.phone_number` + `contact_phones`, `contacts.email_normalized`).
 *
 * ─── O que mora aqui ────────────────────────────────────────────────────────
 * Só a forma canônica do identificador (`normalizarIdentificador`). Quem lê e
 * grava é a ingestão das redes sociais, e a régua do banco é a
 * MESMA — `fn_identificador_canonico` roda no gatilho e na constraint da
 * tabela. A duplicação lib×SQL é deliberada: normalizar só aqui deixaria a
 * porta do PostgREST aberta para gravar variante. As duas réguas são comparadas
 * de verdade em `tests/invariants/identidades-do-contato-canonico-paridade.test.ts`.
 */

/**
 * As redes desta fatia. Lista FECHADA no mesmo vocabulário do CHECK de
 * `contact_identities.canal` (migration 9419) — acrescentar uma rede é
 * acrescentar aqui, na constraint e na régua de normalização, na mesma entrega.
 */
export const CANAIS_DE_IDENTIDADE = ["instagram", "facebook"] as const;

export type CanalDeIdentidade = (typeof CANAIS_DE_IDENTIDADE)[number];

export function ehCanalDeIdentidade(valor: string): valor is CanalDeIdentidade {
  return (CANAIS_DE_IDENTIDADE as readonly string[]).includes(valor);
}

/**
 * A forma canônica do identificador por rede — ou `null` quando o valor não é
 * um identificador daquela rede.
 *
 *   instagram  o perfil, sem `@`, sem URL e em minúsculas. O Instagram não
 *              diferencia maiúsculas no handle, e `@Fulano`/`fulano` é a mesma
 *              pessoa. O id numérico do participante (o que a DM entrega) passa
 *              intacto.
 *   facebook   idem, aceitando também hífen e o id numérico da página.
 *
 * `null` em vez de `""`: valor inválido NÃO vira identidade vazia, senão duas
 * fichas "sem identificador" colidiriam no índice.
 */
export function normalizarIdentificador(
  canal: CanalDeIdentidade,
  bruto: string | null | undefined,
): string | null {
  if (typeof bruto !== "string") return null;
  const texto = bruto.trim();
  if (!texto) return null;
  const perfil = perfilDaUrl(texto).toLowerCase();

  switch (canal) {
    case "instagram":
      // 1..30 caracteres, letra/número/ponto/underscore: a régua do próprio
      // Instagram. Qualquer outra coisa é link colado errado, não identidade.
      return /^[a-z0-9._]{1,30}$/.test(perfil) && !/^\.+$/.test(perfil) ? perfil : null;
    case "facebook":
      // Mais largo que o Instagram de propósito: o Facebook aceita ponto,
      // hífen e o id numérico da página.
      return /^[a-z0-9._-]{1,64}$/.test(perfil) ? perfil : null;
  }
}

/**
 * Tira o que o atendente cola junto com o perfil: protocolo, domínio, `@`,
 * caminho final, query (`?hl=pt`) e fragmento.
 *
 * `https://www.instagram.com/fulano/?hl=pt` e `@fulano` são a mesma pessoa, e a
 * segunda forma é a que o cliente digita no direct.
 */
function perfilDaUrl(texto: string): string {
  return texto
    .replace(/^https?:\/\//i, "")
    // `www.` e `m.` na frente de QUALQUER um dos domínios: o link do celular
    // (`https://m.instagram.com/fulano`) é o mesmo perfil, e a régua do banco
    // (`fn_identificador_canonico`) também os tira.
    .replace(/^(?:www\.|m\.)?(?:instagram\.com|facebook\.com|fb\.com|fb\.me)\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    // O `@` que o cliente digita no direct. Vem DEPOIS da URL: `@fulano` não é
    // URL, e `instagram.com/@fulano` também existe.
    .replace(/^@+/, "")
    .trim();
}
