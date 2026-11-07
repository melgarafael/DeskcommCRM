/**
 * CONVIDADOS DA EQUIPE NO COMPROMISSO (#4006, itens 1 e 2).
 *
 * Numa equipe com SDR e closer, a SDR marca a reunião, mas o responsável é o
 * closer; o gestor ou um especialista também precisa estar. Hoje o compromisso
 * só aceita o dono do evento, o e-mail da ficha e UM "e-mail do convidado"
 * digitado à mão. Quem participa e não é o dono não vê o compromisso na própria
 * agenda — nem no Google, nem no CRM.
 *
 * ─── A REGRA DE PERMISSÃO É A DA AGENDA, e não uma nova ────────────────────
 *
 * Quem monta um compromisso nesta agenda já é `agent` ou acima (piso dos três
 * verbos de `/api/v1/agenda/agendamentos`) e já lê a lista de pessoas pelo
 * mesmo papel (`PAPEL_MINIMO_DA_LISTA`, `lib/agenda/lista-de-pessoas.ts`).
 * Escolher convidado é a MESMA permissão de ver de quem é o horário — não
 * inventa papel novo, não abre a lista para `viewer` e não exige `manager`.
 *
 * ─── O convidado NÃO vira dono ─────────────────────────────────────────────
 *
 * Carteira, distribuição e métricas continuam do responsável. Este módulo não
 * toca `owner_user_id`; ele só resolve endereços de convite. O dono é removido
 * da lista mesmo se alguém o mandar junto — convidar a si mesmo como terceiro
 * duplicaria o e-mail do organizador, que o Google recusa.
 *
 * ─── Qual e-mail vai ao Google ─────────────────────────────────────────────
 *
 * O da conta Google CONECTADA e saudável daquela pessoa; sem conta conectada
 * (ou com a conexão caída), o e-mail de LOGIN. É a régua da própria issue:
 * mandar para o endereço de login de quem conectou outra conta manda o convite
 * para uma caixa que a pessoa não abre.
 */

import { PAPEL_MINIMO_DA_LISTA } from "@/lib/agenda/lista-de-pessoas";
import { roleAtLeast, type Role } from "@/lib/auth/types";

/** A mesma régua da lista de pessoas da agenda. */
export const PAPEL_MINIMO_DO_CONVIDADO: Role = PAPEL_MINIMO_DA_LISTA;

/**
 * O teto de convidados por compromisso.
 *
 * Não é regra do Google (ele aceita centenas); é a régua do produto: uma lista
 * com a empresa inteira dentro do evento de um cliente é vazamento de agenda
 * interna, e o `attendees` do evento fica visível a todos os convidados.
 */
export const MAXIMO_DE_CONVIDADOS = 20;

/** Um membro no recorte que a resolução do convite precisa. */
export interface MembroConvidavel {
  user_id: string;
  /** Nome de apresentação (`full_name`), quando há. */
  nome?: string | null;
  /** E-mail de login — sempre existe. */
  emailDeLogin: string;
  /** E-mail da conta Google conectada, quando a pessoa conectou uma. */
  emailGoogle?: string | null;
  /** A conexão do Google está saudável AGORA (não arquivada, não recusada). */
  googleSaudavel?: boolean;
  /** Vínculo ativo com a organização (`user_organizations.revoked_at is null`). */
  ativo?: boolean;
  papel?: string | null;
}

/** Quem pode escolher convidados da equipe. Piso `agent`, o da agenda. */
export function podeConvidarDaEquipe(papel: string | null | undefined): boolean {
  return roleAtLeast(papel, PAPEL_MINIMO_DO_CONVIDADO);
}

/**
 * A lista de ids que vale a pena gravar: sem repetido, sem o dono, dentro do
 * teto, na ordem em que a pessoa escolheu.
 */
export function normalizarIdsDeConvidados(
  ids: readonly string[] | null | undefined,
  donoId: string | null | undefined,
): string[] {
  const vistos = new Set<string>();
  const out: string[] = [];
  const dono = donoId?.trim() ?? "";
  for (const bruto of ids ?? []) {
    const id = typeof bruto === "string" ? bruto.trim() : "";
    if (!id || id === dono || vistos.has(id)) continue;
    vistos.add(id);
    out.push(id);
    if (out.length >= MAXIMO_DE_CONVIDADOS) break;
  }
  return out;
}

/**
 * O e-mail que recebe o convite: o da conta Google saudável, senão o de login.
 *
 * `emailGoogle` de conexão CAÍDA não serve: o evento iria para uma conta que a
 * pessoa não está lendo mais (e o Google pode devolver o convite como
 * `needsAction` eterno). É melhor o login.
 */
export function emailDoConvidado(membro: MembroConvidavel): string | null {
  const google = membro.googleSaudavel ? membro.emailGoogle?.trim() : "";
  if (google) return google;
  const login = membro.emailDeLogin?.trim();
  return login || null;
}

/**
 * Resolve os ids escolhidos nos participantes do evento.
 *
 * Membro INATIVO (ou desconhecido) simplesmente não entra: quem saiu da empresa
 * não recebe convite de reunião. Deduplicação de e-mail entre convidados da
 * equipe é feita aqui; a deduplicação contra o e-mail da ficha e o "e-mail do
 * convidado" acontece em `participantesDoAgendamento`, no mesmo ponto em que o
 * Google reprovaria o evento inteiro.
 */
export function convidadosDaEquipe(
  membros: readonly MembroConvidavel[],
  ids: readonly string[] | null | undefined,
): { email: string; nome: string | null }[] {
  const porId = new Map<string, MembroConvidavel>();
  for (const m of membros) porId.set(m.user_id, m);

  const vistos = new Set<string>();
  const out: { email: string; nome: string | null }[] = [];
  for (const id of ids ?? []) {
    const membro = porId.get(id);
    if (!membro || membro.ativo === false) continue;
    const email = emailDoConvidado(membro);
    if (!email) continue;
    const chave = email.toLowerCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push({ email, nome: membro.nome?.trim() || null });
  }
  return out;
}

/**
 * Os convidados PADRÃO do tipo de agendamento (#4006, item 2).
 *
 * A tela pré-marca e a pessoa pode tirar alguém. Quando o agendamento vem da
 * IA, da automação ou do MCP, entram SÓ estes: a IA nunca escolhe pessoas —
 * escolher quem participa de uma reunião é decisão de gente.
 */
export function convidadosDaEquipeQuandoAutomatico(
  padrao: readonly string[] | null | undefined,
): string[] {
  return normalizarIdsDeConvidados(padrao, null);
}
