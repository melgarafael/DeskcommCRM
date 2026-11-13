/**
 * A régua do contato pessoal COM DONO (issue #4434).
 *
 * ─── Por que esta régua existe ──────────────────────────────────────
 *
 * A spec 21 escondeu o contato pessoal da operação e, no mesmo gesto, o tornou
 * inalcançável para TODOS — inclusive para quem marcou. O recorte aprovado na
 * #4434 separa as duas coisas:
 *
 *   esconder da OPERAÇÃO   → continua valendo (IA, automação, campanha,
 *                            prospecção, follow-up, funil, RAG, métricas,
 *                            webhooks, busca da equipe, MCP);
 *   alcançar o PRÓPRIO     → quem marcou lê e responde o seu.
 *
 * ─── A régua, e o que ela NÃO aceita ────────────────────────────────
 *
 * A única entrada é ser o DONO da marca (`contacts.personal_owner_user_id`).
 * Papel NÃO entra: `admin` e `manager` não leem o pessoal de outra pessoa, nem
 * por lista, nem por link direto, nem no envio. O dano de uma porta esquecida
 * aqui não é bug de UX — é a conversa de família de alguém aparecendo na tela
 * de outro, e é por isso que a função não recebe `role` nem `verTodos`: sem
 * parâmetro, não há como ligar a exceção por papel sem escrever código novo.
 *
 * Contato sem dono (marcado antes da migration 9360, ou cujo dono foi removido)
 * não casa ninguém: fica invisível até alguém marcar de novo e adotar.
 *
 * Ator que não é pessoa (`api_token`/`ai_agent`/automação) nunca passa: o MCP e
 * a automação continuam sem ver pessoal (spec 21 §6.1, mantida).
 */
import type { Actor } from "@/lib/api/handlers/types";

/** O mínimo da ficha que a régua precisa — o embed `contacts:contact_id(...)`. */
export interface ContatoDaMarcaPessoal {
  is_personal?: boolean | null;
  personal_owner_user_id?: string | null;
}

/**
 * Este ator pode ler/responder o pessoal deste contato?
 *
 * `true` para contato que não é pessoal (a régua só existe para pessoal).
 * `false` para ator que não é pessoa, e para quem não é o dono — inclusive
 * `admin` e `manager`.
 */
export function podeVerPessoal(
  actor: Actor,
  contato: ContatoDaMarcaPessoal | null | undefined,
): boolean {
  if (contato?.is_personal !== true) return true;
  if (actor.type !== "user") return false;
  // Dono nulo (legado) não casa ninguém: `null === id` é falso por construção.
  return contato.personal_owner_user_id === actor.id;
}

/** Quantas conversas de pessoal a aba carrega antes de cortar (teto da URL). */
export const TETO_DE_PESSOAIS = 500;
