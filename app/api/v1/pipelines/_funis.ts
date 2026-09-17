/**
 * Leitura compartilhada pelas rotas de funil (criar, editar, arquivar/excluir).
 *
 * Existe como arquivo único porque as três precisam do MESMO recorte: os funis
 * da organização INTEIROS, arquivados incluídos. As regras de
 * `lib/pipelines/pipeline-editing.ts` dependem disso — nenhum dos três índices
 * únicos de funil é parcial em `is_archived`: nem `uniq_crm_pipelines_org_slug`
 * (funil arquivado continua ocupando o slug), nem `uniq_crm_pipelines_org_default`,
 * nem `uniq_crm_pipelines_org_client`. Cada rota montando o próprio `select`
 * divergiria no primeiro ajuste.
 *
 * ⚠️ ESTE PARÁGRAFO AFIRMAVA QUE O DE PADRÃO É PARCIAL, e era falso: medido em
 * `supabase/baseline.sql`, ele é `where (is_default = true)` e mais nada. A
 * afirmação aparecia em três lugares e fazia `updatesDePadrao` pular o funil
 * arquivado — um update a menos, e um 23505 para quem arquivou o funil antigo
 * antes de trocar o padrão. Para conferir sem acreditar nesta linha:
 *
 *   grep -n "uniq_crm_pipelines_org_" supabase/baseline.sql
 */
import { fail } from "@/lib/api/wrappers";
import {
  regrasQueApontamPara,
  type DependenciasDoFunil,
  type FunilEditavel,
  type RegraDeAutomacao,
} from "@/lib/pipelines/pipeline-editing";
import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** `position` entra: a reordenação calcula em cima dela. */
const COLUNAS =
  "id, name, slug, description, position, is_default, is_client_pipeline, is_archived";

/**
 * Os funis da organização, na ordem da lista, arquivados inclusive.
 *
 * O filtro explícito de `organization_id` é a convenção do repo e a rede que
 * sobra se a policy mudar — a RLS já vale porque o client é o do usuário.
 */
export async function lerFunis(supabase: Supabase, orgId: string): Promise<FunilEditavel[]> {
  const { data, error } = await supabase
    .from("crm_pipelines")
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .order("position", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as FunilEditavel[];
}

/**
 * O que amarra o funil ao resto do sistema.
 *
 * ⚠️ AS FONTES DE WEBHOOK ENTRAM ATIVAS OU NÃO, e é a régua conservadora de
 * propósito: `webhook_sources.default_pipeline_id` é `ON DELETE CASCADE`, então
 * a exclusão levaria junto até a fonte desativada — configuração do cliente
 * apagada em silêncio. Uma régua só para arquivar e excluir também evita a
 * armadilha de recusar por um motivo na primeira operação e outro na segunda.
 *
 * ⚠️ AS AUTOMAÇÕES SÃO FILTRADAS EM JS, e não por `contains` no jsonb. O
 * `pipeline_id` mora dentro de `actions` sem FK nem schema: a forma varia entre
 * versões, e um operador de contenção erraria calado (devolvendo lista vazia)
 * justamente no caso que precisa barrar. A org tem dezenas de regras, não
 * milhares — ler e filtrar é honesto e testável sem Postgres.
 */
export async function lerDependencias(
  supabase: Supabase,
  orgId: string,
  pipelineId: string,
): Promise<DependenciasDoFunil> {
  const { count, error: leadsErr } = await supabase
    .from("crm_leads")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId);
  if (leadsErr) throw new Error(leadsErr.message);

  const { data: fontes, error: fontesErr } = await supabase
    .from("webhook_sources")
    .select("name")
    .eq("organization_id", orgId)
    .eq("default_pipeline_id", pipelineId);
  if (fontesErr) throw new Error(fontesErr.message);

  const { data: regras, error: regrasErr } = await supabase
    .from("automation_rules")
    .select("name, is_active, actions")
    .eq("organization_id", orgId);
  if (regrasErr) throw new Error(regrasErr.message);

  return {
    negocios: count ?? 0,
    fontesDeWebhook: ((fontes ?? []) as Array<{ name: string }>).map((f) => f.name),
    regrasAtivas: regrasQueApontamPara((regras ?? []) as RegraDeAutomacao[], pipelineId),
  };
}

/** O que a tela recebe de volta: os funis vivos, na ordem da lista. */
export function corpo(funis: FunilEditavel[]): {
  pipelines: Array<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    position: number;
    is_default: boolean;
    is_client_pipeline: boolean;
  }>;
} {
  return {
    pipelines: funis
      .filter((f) => !f.is_archived)
      .map((f) => ({
        id: f.id,
        name: f.name,
        slug: f.slug,
        description: f.description ?? null,
        position: f.position,
        is_default: f.is_default,
        // `?? false` e não `!` — um clone que ainda não aplicou a 0262 devolve
        // `undefined` aqui, e a tela precisa de um booleano para decidir se
        // mostra o badge. Ausente é "não é o funil de clientes", que é a
        // verdade nesse banco.
        is_client_pipeline: f.is_client_pipeline ?? false,
      })),
  };
}

/**
 * Recusa do banco traduzida — ou `null` se o erro não é de conflito.
 *
 * Cobre `23505`, o conflito que dois funis editados em duas abas produzem (slug
 * repetido, ou dois padrões ao mesmo tempo). Vira texto de tela em português
 * porque "duplicate key value violates unique constraint
 * uniq_crm_pipelines_org_default" não ensina nada a quem só queria trocar o
 * funil padrão. Qualquer outro erro sai como `internal_error`, com o texto do
 * Postgres em `details` e nunca colado numa frase escrita para leigo.
 */
export function conflitoDoBanco(
  erro: { code?: string } | null | undefined,
  nomeDoFunil: string,
  requestId: string,
) {
  if (erro?.code !== "23505") return null;
  return fail(
    "state_conflict",
    `«${nomeDoFunil}» mudou enquanto você editava — outro funil já ocupa esse nome ou o lugar de padrão. ` +
      `Recarregue a página e tente de novo.`,
    409,
    { requestId },
  );
}
