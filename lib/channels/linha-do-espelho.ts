/**
 * A linha de `meta_templates` que define um modelo PARA UMA CONEXÃO.
 *
 * O espelho tem dois donos, e eles gravam a conexão de jeitos diferentes:
 *
 *   - os parceiros (Datafy, Zernio — `app/api/v1/channels/{partner,graph-partner}/templates`)
 *     gravam `channel_session_id`: a definição é DAQUELE número;
 *   - o sync do canal oficial (`lib/channels/meta/template-sync.ts`) grava por
 *     `waba_id` e deixa `channel_session_id` nulo — a definição é da conta, e o
 *     webhook de status da Meta também chaveia por `waba_id`.
 *
 * Filtrar só por `channel_session_id = <conexão>` (como fazia o envio desde a
 * v1.45.0) não acha NENHUMA linha do canal oficial: o envio de modelo lançava
 * `template_missing` e a conferência deixava passar sem conferir — logo o modelo,
 * que é o único jeito de falar com o lead depois de 24 h.
 *
 * Por isso a busca tem duas etapas: a linha da própria conexão e, só se não
 * houver, a linha sem conexão DA CONTA OFICIAL DESTA SESSÃO — e só quando a
 * sessão É do canal oficial. Sem essas duas travas, o segundo passo serviria a
 * um número de parceiro a definição do canal oficial (ou a linha órfã de um
 * parceiro apagado, que o `on delete set null` deixa sem conexão), que é o
 * defeito que a v1.45.0 fechou. A `waba_id` é a MESMA que o sync grava
 * (`channel_sessions.meta_waba_id`, via `metaSessionForOrg`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHANNEL_PROVIDER_META } from "./capabilities";

export interface ChaveDaDefinicao {
  organizationId: string;
  name: string;
  language: string;
  /** Conexão da conversa. Ausente/`null` = base anterior à 0144: busca sem ela. */
  channelSessionId?: string | null;
}

export async function linhaDoEspelho<T>(
  db: SupabaseClient,
  colunas: string,
  chave: ChaveDaDefinicao,
): Promise<{ data: T | null; error: { message: string } | null }> {
  const base = () =>
    db
      .from("meta_templates")
      .select(colunas)
      .eq("organization_id", chave.organizationId)
      .eq("name", chave.name)
      .eq("language", chave.language);

  if (!chave.channelSessionId) {
    const { data, error } = await base().maybeSingle();
    return { data: (data as T | null) ?? null, error };
  }

  const daConexao = await base().eq("channel_session_id", chave.channelSessionId).maybeSingle();
  if (daConexao.error || daConexao.data) {
    return { data: (daConexao.data as T | null) ?? null, error: daConexao.error };
  }

  // Só o canal oficial tem linha sem conexão, e só a da conta dele serve.
  const { data: sessao, error: erroDaSessao } = await db
    .from("channel_sessions")
    .select("provider, meta_waba_id")
    .eq("organization_id", chave.organizationId)
    .eq("id", chave.channelSessionId)
    .maybeSingle();
  if (erroDaSessao) return { data: null, error: erroDaSessao };
  const oficial = sessao as { provider?: string; meta_waba_id?: string | null } | null;
  if (oficial?.provider !== CHANNEL_PROVIDER_META || !oficial.meta_waba_id) {
    return { data: null, error: null };
  }

  const semConexao = await base()
    .is("channel_session_id", null)
    .eq("waba_id", oficial.meta_waba_id)
    .maybeSingle();
  return { data: (semConexao.data as T | null) ?? null, error: semConexao.error };
}

/** O mínimo de um cliente `pg` que esta consulta usa (o `Pool` do agent-engine encaixa). */
export interface ConsultaSql {
  query<R>(sql: string, params: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * A MESMA regra de `linhaDoEspelho`, para quem fala SQL direto (a ferramenta
 * `send_template` do agente, que roda com o `pg` do agent-engine): a linha da
 * conexão tem precedência; na falta dela, a linha sem conexão do canal oficial,
 * só se a sessão é do canal oficial e só da WABA dela. Uma consulta, `limit 1`,
 * com a precedência no `order by`.
 *
 * `colunas` é uma lista de colunas de `meta_templates` (sem prefixo).
 */
export async function definicaoNaConexao<R>(
  db: ConsultaSql,
  colunas: readonly string[],
  chave: ChaveDaDefinicao & { channelSessionId: string },
): Promise<R | null> {
  const lista = colunas.map((c) => `t.${c}`).join(", ");
  const { rows } = await db.query<R>(
    `select ${lista} from meta_templates t
      where t.organization_id = $1 and t.name = $2 and t.language = $3
        and (
          t.channel_session_id = $4
          or (
            t.channel_session_id is null
            and exists (
              select 1 from channel_sessions s
               where s.organization_id = $1 and s.id = $4
                 and s.provider = $5 and s.meta_waba_id = t.waba_id
            )
          )
        )
      order by (t.channel_session_id is not null) desc
      limit 1`,
    [chave.organizationId, chave.name, chave.language, chave.channelSessionId, CHANNEL_PROVIDER_META],
  );
  return rows[0] ?? null;
}
