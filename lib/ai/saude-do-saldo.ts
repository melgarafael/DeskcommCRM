import type { Pool } from "pg";

import { FRASES_DE_SEM_SALDO } from "@/lib/agent-engine/queue/espera-de-saldo";

// O status 429 também representa limites temporários. Só sinais explícitos
// de crédito insuficiente contam, inclusive quando o SDK registra só a frase.
// As frases da fila de espera por saldo entram daqui, para a faixa e a fila não
// divergirem: enquanto eram duas listas, o "exceeded your current quota" da
// OpenAI segurava a resposta na fila e não acendia a faixa (triagem do #5312).
const ERRO_DE_SALDO = [
  "credit_balance_exhausted|no (prepaid )?credits remaining|insufficient (prepaid )?(credit balance|credits|balance)",
  ...FRASES_DE_SEM_SALDO.map((f) => f.padrao.source),
].join("|");

export interface AvisoDeSaldoDaIa {
  provider: string;
  atendimento: boolean;
}

export async function avisosDeSaldoDaIa(
  db: Pick<Pool, "query">,
  orgId: string,
): Promise<AvisoDeSaldoDaIa[]> {
  const { rows } = await db.query<AvisoDeSaldoDaIa>(
    `with credenciais as materialized (
       select ch.id, ch.provider, ch.created_at, rot.data as rotacionada_em,
              count(*) over (partition by ch.provider) = 1 as unica
       from ai_provider_credentials ch
       left join (
         select al.resource_id, max(al.created_at) as data
         from api_audit_log al
         where al.organization_id = $1
           and al.created_at >= now() - interval '7 days'
           and al.action = 'ai.credential_updated' and al.metadata->>'trocou_chave' = 'true'
         group by al.resource_id
       ) rot on rot.resource_id = ch.id
       where ch.organization_id = $1 and ch.is_active and ch.validated_at is not null
     ), eventos as (
       select l.provider, l.purpose, l.job_id, l.created_at, l.status,
              l.purpose = 'agent_turn' and j.kind = 'inbound_turn' as atendimento,
              coalesce(c.id::text, concat('ponto:', l.purpose, ':', l.agent_id, ':', l.origem_da_escolha)) as conta
       from llm_calls l
       join organizations o on o.id = l.organization_id
       left join job_queue j on j.organization_id = l.organization_id and j.id = l.job_id
       left join ai_agents a on a.organization_id = l.organization_id and a.id = l.agent_id
         and a.is_active and a.archived_at is null and a.paused_at is null
       left join ai_agent_versions v on v.organization_id = a.organization_id
         and v.id = a.published_version_id and v.provider = l.provider
         and l.origem_da_escolha in ('agente_publicado', 'herdado_de_quem_chamou')
       left join ai_purpose_bindings b on b.organization_id = l.organization_id
         and b.purpose = l.purpose and b.is_enabled
         and (l.origem_da_escolha in ('binding', 'padrao_da_organizacao', 'variavel_de_ambiente')
           or (l.origem_da_escolha = 'reserva_do_jev' and b.provider = l.provider))
       left join credenciais c on c.provider = l.provider
         and (c.id = coalesce(v.credential_id, b.credential_id)
           or (c.unica and coalesce(v.credential_id, b.credential_id) is null))
       where l.organization_id = $1 and l.created_at >= now() - interval '7 days'
         and l.purpose <> 'agent_preview'
         and (l.agent_id is null or a.id is not null)
         and (l.purpose <> 'agent_turn' or j.kind is distinct from 'inbound_turn'
           or a.operation_mode is distinct from 'assisted')
         and (l.provider <> 'typesafe' or o.settings #> '{jev,ligado}' = 'true'::jsonb)
         and (coalesce(v.credential_id, b.credential_id) is null or c.id is not null)
         and (c.id is null or l.created_at >= greatest(c.created_at, c.rotacionada_em))
         and (j.kind is not null or l.purpose in (
           'transcricao_de_audio', 'visao_de_imagem', 'sentiment_classify',
           'afirmacao_de_fato', 'jev_pedidos'
         ))
         -- Falha antiga continua no histórico, mas deixa de avisar se aquele ponto trocou de provedor.
         and case
           when l.origem_da_escolha = 'agente_publicado' then v.id is not null
           when l.origem_da_escolha = 'herdado_de_quem_chamou' and l.agent_id is not null then v.id is not null
           when l.origem_da_escolha = 'binding' then b.provider = l.provider
           when l.origem_da_escolha in ('padrao_da_organizacao', 'variavel_de_ambiente') then
             b.purpose is null and l.provider = coalesce(nullif(o.settings->'llm'->>'provider', ''), 'anthropic')
           else true
         end
         and (v.published_at is null or l.created_at >= v.published_at)
         and (b.updated_at is null or l.created_at >= b.updated_at)
         and (l.status = 'ok' or (l.status = 'erro' and (
           l.error_code = 'jev_sem_credito' or l.error_message ~* $2
         )))
     ), recuperados as (
       select job_id, max(created_at) as recuperado_em
       from eventos
       where purpose = 'agent_turn' and status = 'ok' and job_id is not null
       group by job_id
     ), estado as (
       select *, max(created_at) filter (where status = 'ok')
         over (partition by provider, conta) as ultimo_sucesso
       from eventos
     )
     select provider, bool_or(coalesce(atendimento, false)
       and (recuperado_em is null or recuperado_em < created_at)) as atendimento
     from estado
     left join recuperados using (job_id)
     where status = 'erro' and (ultimo_sucesso is null or created_at > ultimo_sucesso)
     group by provider
     order by provider`,
    [orgId, ERRO_DE_SALDO],
  );
  return rows;
}
