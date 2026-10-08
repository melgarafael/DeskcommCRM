/**
 * Quem é avisado de uma MENSAGEM RECEBIDA (`message.received`, conversa 1:1).
 *
 * ═══ A regra (proposta em 2026-10-07; o mantenedor decide se entra) ═══
 *
 * - Conversa SEM responsável → o aviso vai para TODOS da organização (o
 *   comportamento de antes: alguém precisa pegar a fila).
 * - Conversa COM responsável → o aviso vai SÓ para o responsável e para os
 *   ADMINISTRADORES da organização (`user_organizations.role = 'admin'`,
 *   vínculo não revogado). O resto do time não é interrompido por cliente
 *   que já tem dono.
 *
 * ═══ Quem é "o responsável" — a precedência ═══
 *
 * 1. `conversations.assigned_to_user_id`, quando preenchido. É quem está
 *    ATENDENDO agora, e vence o dono do negócio: se o gerente passou a
 *    conversa para outra pessoa, é ela quem precisa ver a resposta.
 * 2. Só quando a conversa está sem atendente: o `owner_user_id` dos negócios
 *    ABERTOS (`crm_leads.status = 'open'`) do contato. Havendo mais de um
 *    negócio aberto com donos diferentes, TODOS os donos são avisados — não
 *    há critério honesto para escolher um, e escolher errado esconderia a
 *    mensagem justamente de quem cuida do cliente.
 * 3. Nem atendente nem dono de negócio aberto → todos.
 *
 * Negócio aberto sem dono (`owner_user_id` nulo, ou dono-agente de IA) não
 * conta como "atribuído": é fila, e fila avisa todo mundo.
 *
 * ═══ Onde a regra roda ═══
 *
 * A MESMA função decide o push do servidor (`push.handler.ts`) e o aviso
 * dentro do app (rota `conversations/[id]/aviso-de-mensagem`, lida por
 * `useInboundMessageAlerts`). Grupos (`message.group_received`) e avisos da
 * Central NÃO passam por aqui — continuam indo para a organização inteira.
 */

export type DestinatariosDaMensagem =
  | { tipo: "todos" }
  | { tipo: "restrito"; userIds: string[] };

export interface FatosDaAtribuicao {
  /** `conversations.assigned_to_user_id`. */
  atribuidoA: string | null;
  /** `owner_user_id` de cada negócio ABERTO do contato (nulos permitidos). */
  donosDeNegocioAberto: ReadonlyArray<string | null>;
  /** user_ids dos administradores da organização com vínculo ativo. */
  admins: ReadonlyArray<string>;
}

/** Os responsáveis pela conversa, pela precedência do cabeçalho. Vazio = sem dono. */
export function responsaveisDaConversa(
  fatos: Pick<FatosDaAtribuicao, "atribuidoA" | "donosDeNegocioAberto">,
): string[] {
  if (fatos.atribuidoA) return [fatos.atribuidoA];
  const donos = fatos.donosDeNegocioAberto.filter((d): d is string => typeof d === "string" && d.length > 0);
  return [...new Set(donos)];
}

/** Decisão pura: todos, ou a lista fechada (responsáveis + admins, sem repetição). */
export function destinatariosDaMensagem(fatos: FatosDaAtribuicao): DestinatariosDaMensagem {
  const responsaveis = responsaveisDaConversa(fatos);
  if (responsaveis.length === 0) return { tipo: "todos" };
  return { tipo: "restrito", userIds: [...new Set([...responsaveis, ...fatos.admins])] };
}

/** Esta pessoa deve ser avisada? */
export function usuarioRecebeAviso(destinatarios: DestinatariosDaMensagem, userId: string): boolean {
  return destinatarios.tipo === "todos" || destinatarios.userIds.includes(userId);
}

// ---------------------------------------------------------------------------
// Leitura dos fatos no banco
// ---------------------------------------------------------------------------

type Resultado<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;

/**
 * O pedaço do supabase-js que a leitura usa. Tipado à mão para o teste passar
 * um stub sem montar o client inteiro — mesmo recurso de `web_push.ts`.
 */
export interface LeitorDeAtribuicao {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
}

/**
 * Lê os fatos e decide. Quem chama passa um client que ENXERGA tudo da
 * organização (service role): a regra precisa do dono do negócio mesmo quando
 * a pessoa avisada não poderia abrir esse negócio — um `agent` no modo de
 * visibilidade padrão não vê lead de outro dono, e para ele "não vejo lead"
 * se confundiria com "não há lead". Por isso todo filtro de `organization_id`
 * aqui é explícito.
 *
 * `contactId` vem do evento quando o evento o tem; senão, da própria conversa.
 * Conversa inexistente na organização → `null` (quem chama decide o desfecho).
 * Erro de leitura LANÇA: quem chama escolhe entre avisar todos ou ninguém.
 */
export async function carregarDestinatariosDaMensagem(
  db: LeitorDeAtribuicao,
  organizationId: string,
  conversationId: string,
  contactId: string | null = null,
): Promise<DestinatariosDaMensagem | null> {
  const conv = (await (db
    .from("conversations")
    .select("assigned_to_user_id, contact_id, is_group")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle() as Resultado<{
    assigned_to_user_id: string | null;
    contact_id: string | null;
    is_group: boolean | null;
  }>));
  if (conv.error) throw new Error(conv.error.message);
  if (!conv.data) return null;
  // Grupo nunca é restrito: o aviso de grupo é da organização inteira.
  if (conv.data.is_group) return { tipo: "todos" };

  let donos: Array<string | null> = [];
  const contato = contactId ?? conv.data.contact_id;
  if (!conv.data.assigned_to_user_id && contato) {
    const leads = await (db
      .from("crm_leads")
      .select("owner_user_id")
      .eq("organization_id", organizationId)
      .eq("contact_id", contato)
      .eq("status", "open") as Resultado<Array<{ owner_user_id: string | null }>>);
    if (leads.error) throw new Error(leads.error.message);
    donos = (leads.data ?? []).map((l) => l.owner_user_id);
  }

  // Os admins só são lidos quando a decisão é restrita — no caso "todos" eles
  // já estão incluídos e a consulta seria desperdício.
  if (responsaveisDaConversa({ atribuidoA: conv.data.assigned_to_user_id, donosDeNegocioAberto: donos }).length === 0) {
    return { tipo: "todos" };
  }
  const admins = await (db
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .is("revoked_at", null) as Resultado<Array<{ user_id: string }>>);
  if (admins.error) throw new Error(admins.error.message);

  return destinatariosDaMensagem({
    atribuidoA: conv.data.assigned_to_user_id,
    donosDeNegocioAberto: donos,
    admins: (admins.data ?? []).map((a) => a.user_id),
  });
}
