import type { Queryable } from "@/lib/agent-engine/queue/queue";

/**
 * Uma sugestão de resposta já gravada em `ai_reply_drafts`, com o estado que
 * o painel de revisão deve realmente mostrar.
 */
export type SugestaoDaConversa = {
  id: string;
  revision: string;
  original_body: string | null;
  edited_body: string | null;
  approved_body: string | null;
  proposals: unknown;
  feedback: unknown;
  error_code: string | null;
  created_at: Date;
  status: string;
};

/**
 * As cinco sugestões mais recentes de uma conversa, da mais recente para a
 * mais antiga, com o estado **recalculado** no momento da leitura.
 *
 * ## Por que este arquivo existe
 *
 * O painel "Assistência do agente" mostrava a sugestão mais recente e nunca
 * olhava o estado dela. Quando o botão "Sugerir resposta" terminava sem texto,
 * a sugestão ficava gravada como `failed` (código `no_candidate`) e o aviso
 * "Não foi possível concluir a sugestão ou o envio" nunca saía da tela, mesmo
 * depois de a pessoa responder à mão ou o cliente escrever de novo.
 *
 * Esta consulta é a mesma da rota `GET /api/v1/conversations/[id]/draft-reply`,
 * com o estado calculado da seguinte forma:
 *
 * - `generating`/`pending`/`approved` viram `stale` quando o contexto da
 *   conversa deixou de ser atual (`fn_reply_context_current`) — regra antiga,
 *   mantida intocada.
 * - `failed` vira `stale` só quando a conversa ANDOU depois da falha:
 *   (1) a revisão do contexto da conversa mudou em relação à gravação da
 *   sugestão, ou (2) apareceu uma mensagem `outbound` criada depois da sugestão
 *   e com status diferente de `failed` (ou seja, algo que de fato saiu).
 *
 * ## Por que `failed` NÃO usa `fn_reply_context_current`
 *
 * Essa função devolve `false` também quando o contato está bloqueado ou
 * anonimizado (`is_blocked` / `is_anonymized`). Se a usássemos para `failed`,
 * o aviso do veto (`contato_bloqueado` / `lgpd_anonymized`, que explica por que
 * a sugestão não veio) sumiria justamente no momento em que mais precisa ser
 * lido. Para `failed` usamos apenas as duas condições acima, então o veto do
 * contato continua visível.
 *
 * ## Por que `d.approved_body is null`
 *
 * `failed` também cobre "a resposta já aprovada falhou no ENVIO"; esse aviso
 * continua visível para quem aprovou e não viu a mensagem sair. A aposentadoria
 * vale só para falha de GERAÇÃO (sugestão nunca aprovada, `approved_body` nulo).
 *
 * ## Por que `m.status <> 'failed'`
 *
 * Uma mensagem de saída com status `failed` não é "a conversa andou": ela não
 * chegou ao cliente. Só uma saída que não falhou conta como movimento que
 * aposenta a sugestão falhada.
 */
export async function listarSugestoesDaConversa(
  db: Queryable,
  organizationId: string,
  conversationId: string,
): Promise<SugestaoDaConversa[]> {
  const { rows } = await db.query<SugestaoDaConversa>(
    `select d.id, d.revision::text, d.original_body, d.edited_body, d.approved_body, d.proposals, d.feedback, d.error_code, d.created_at,
  case
    when d.status in ('generating','pending','approved')
         and not fn_reply_context_current(d.organization_id, d.id) then 'stale'
    when d.status = 'failed' and d.approved_body is null and (
           exists (select 1 from conversations c
                    where c.organization_id = d.organization_id and c.id = d.conversation_id
                      and c.reply_context_revision <> d.context_revision)
        or exists (select 1 from messages m
                    where m.organization_id = d.organization_id and m.conversation_id = d.conversation_id
                      and m.direction = 'outbound' and m.status <> 'failed'
                      and m.created_at > d.created_at)
         ) then 'stale'
    else d.status
  end as status
from ai_reply_drafts d
where d.organization_id = $1 and d.conversation_id = $2
order by d.created_at desc limit 5`,
    [organizationId, conversationId],
  );
  return rows;
}
