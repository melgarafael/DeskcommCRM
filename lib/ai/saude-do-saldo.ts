import type { Pool } from "pg";

// O status 429 também representa limites temporários. Só sinais explícitos
// de crédito insuficiente contam, inclusive quando o SDK registra só a frase.
const ERRO_DE_SALDO =
  "credit_balance_exhausted|credit balance is too low|no (prepaid )?credits remaining|insufficient (prepaid )?(credit balance|credits|balance)";

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
       select id, provider, created_at,
              count(*) over (partition by provider) = 1 as unica
       from ai_provider_credentials
       where organization_id = $1 and is_active and validated_at is not null
     ), eventos as (
       select l.provider, l.purpose, l.job_id, l.created_at, l.status,
              l.purpose = 'agent_turn' and j.kind = 'inbound_turn' as atendimento,
              coalesce(c.id::text, concat('ponto:', l.purpose, ':', l.agent_id, ':', l.origem_da_escolha)) as conta
       from llm_calls l
       left join job_queue j on j.organization_id = l.organization_id and j.id = l.job_id
       left join ai_agents a on a.organization_id = l.organization_id and a.id = l.agent_id
         and a.is_active and a.archived_at is null
       left join ai_agent_versions v on v.organization_id = a.organization_id
         and v.id = a.published_version_id and v.provider = l.provider
         and l.origem_da_escolha in ('agente_publicado', 'herdado_de_quem_chamou')
       left join ai_purpose_bindings b on b.organization_id = l.organization_id
         and b.purpose = l.purpose and b.provider = l.provider and b.is_enabled
         and l.origem_da_escolha in ('binding', 'reserva_do_jev')
       left join credenciais c on c.provider = l.provider and c.created_at <= l.created_at
         and (c.id = coalesce(v.credential_id, b.credential_id)
           or (c.unica and coalesce(v.credential_id, b.credential_id) is null))
       where l.organization_id = $1 and l.created_at >= now() - interval '7 days'
         and l.purpose <> 'agent_preview'
         and (j.kind is not null or l.purpose in (
           'transcricao_de_audio', 'visao_de_imagem', 'sentiment_classify',
           'afirmacao_de_fato', 'jev_pedidos'
         ))
         and (l.origem_da_escolha is distinct from 'agente_publicado' or v.id is not null)
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
