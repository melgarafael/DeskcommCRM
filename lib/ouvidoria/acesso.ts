/**
 * OUVIDORIA — QUEM ENTRA NA OUVIDORIA (#3611, fatia 3).
 *
 * ─── Por que este arquivo existe ───────────────────────────────────────────
 *
 * A fatia 1 decidiu a régua de acesso e a escreveu DENTRO de
 * `app/actions/ouvidoria/ler-manifestacao.ts` (linha 64: a barreira de
 * acompanhamento, antes de resolver tenant; linha 68: o piso de papel). A fatia
 * 3 precisa da MESMA régua em quatro portas — a lista, o detalhe, a mudança de
 * status e as duas telas — e quatro cópias divergem no primeiro ajuste: é
 * sempre uma que fica para trás, e a que fica é a que ninguém abre.
 *
 * Então a régua saiu de lá e mora aqui. `ler-manifestacao.ts` passa a chamar
 * esta função, o que garante que a leitura da fatia 1 e a tela da fatia 3 não
 * possam discordar sobre quem lê o relato.
 *
 * ─── A ordem das recusas é parte do contrato, não detalhe ──────────────────
 *
 * 1. `unauthenticated` — sem sessão não há pergunta a fazer;
 * 2. `forbidden_role` — a sessão de ACOMPANHAMENTO cai aqui, ANTES de resolver
 *    tenant: quem está do lado de fora olhando a tela do cliente não lê o
 *    relato de quem reclamou, nem com `admin` no papel;
 * 3. `forbidden_tenant` — sessão sem organização ativa;
 * 4. `forbidden_role` — papel abaixo do piso.
 *
 * A barreira é `supportWriteError`, a mesma das actions de leitura desta
 * natureza. Ela responde pelo MODO do acompanhamento (somente leitura recusa);
 * para a ouvidoria isso é o que basta porque a leitura é a régua mais
 * restritiva do módulo: quem não pode ESCREVER na tela do cliente não recebe o
 * relato sigiloso.
 *
 * ─── Por que `admin`, e não `manager` ─────────────────────────────────────
 *
 * A issue pede perfis configuráveis, "incluindo a opção de somente
 * administradores". Enquanto a configuração não existe, a régua é a MAIS
 * restritiva das opções que a issue lista — abrir para `manager` seria escolher
 * pelo dono do produto a opção mais permissiva, e manifestação é o dado mais
 * sensível que este CRM guarda. É a mesma régua da RLS da 9030
 * (`fn_role_at_least(organization_id, 'admin')`): a tela e o banco não podem
 * discordar sobre quem lê.
 *
 * ─── O que esta função NÃO faz ────────────────────────────────────────────
 *
 * Não devolve a organização por argumento, não consulta a manifestação e não
 * decide transição de status. Ela responde uma pergunta só: esta sessão pode
 * olhar a ouvidoria desta organização? Quem chama usa a resposta para escolher
 * o cliente (sessão ou serviço) e o predicado.
 */
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, type ActiveOrg, type AuthUser, type Role } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";

/** O piso de papel da ouvidoria: `admin` e acima. Ver o cabeçalho. */
export const PAPEL_MINIMO_DA_OUVIDORIA: Role = "admin";

/**
 * As três recusas. Os nomes são os mesmos que as actions devolvem ao cliente —
 * a UI não inventa um quarto vocabulário para dizer "não pode".
 */
export type RecusaDaOuvidoria = "unauthenticated" | "forbidden_tenant" | "forbidden_role";

export type AcessoDaOuvidoria =
  | { ok: true; user: AuthUser; org: ActiveOrg }
  | { ok: false; error: RecusaDaOuvidoria };

/**
 * A porta única da ouvidoria. Nunca lança: devolve resultado, e cada ação
 * traduz o resultado na resposta que a tela sabe mostrar.
 */
export async function acessoDaOuvidoria(): Promise<AcessoDaOuvidoria> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  // ⚠️ ANTES de `resolveActiveOrg`, de propósito: a sessão de acompanhamento
  // não é a organização, e descobrir qual é a empresa ativa já é informação que
  // ela não precisa para ser recusada. O teste da fatia 1 fixa esta ordem.
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };

  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  if (ROLE_RANK[org.role] < ROLE_RANK[PAPEL_MINIMO_DA_OUVIDORIA]) {
    return { ok: false, error: "forbidden_role" };
  }

  return { ok: true, user, org };
}
