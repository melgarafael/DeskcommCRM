/**
 * NEGÓCIO ABERTO DUPLICADO — a MESMA regra, duas portas (issue #1751).
 *
 * ─── A régua ────────────────────────────────────────────────────────────────
 *
 * Duplicidade é uma tríade: mesmo CONTATO, mesmo FUNIL e negócio ABERTO. Um
 * contato com dois negócios em funis diferentes é o fluxo normal de vendas
 * (prospecção e pós-venda convivem), e um negócio encerrado nunca é duplicado
 * — perder e tentar de novo é o caminho da retomada (#1538). Filtar só o
 * contato avisaria errado; filtrar sem o status ensinaria quem recebe o aviso a
 * ignorá-lo.
 *
 * ─── Por que AVISA e não BLOQUEIA ───────────────────────────────────────────
 *
 * A migration 0256 decidiu que um cliente PODE ter dois negócios abertos: "a
 * regra 'um aberto por contato' é do INGEST, não do CRM — e prendê-la no
 * schema a imporia a todos os caminhos". Esta peça, portanto, NÃO recusa nada:
 * a rota `POST /api/v1/leads` cria e devolve `meta.avisos`, e a tela mostra o
 * aviso com link para o que já existe antes de perguntar "abrir mesmo assim?".
 *
 * ─── As duas portas ─────────────────────────────────────────────────────────
 *
 * Duas reimplementações da mesma regra seria como o defeito nasce: quem muda o
 * filtro numa esquece a outra. Por isso as duas moram aqui —
 * `negocioAbertoExistente` lê o banco (a rota, que não tem quadro na mão) e
 * `negocioAbertoNoQuadro` filtra a lista que a tela já carregou (sem pedido de
 * rede, sem atraso no clique).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * O código que vai em `meta.avisos` — literal, porque é contrato da API: um
 * cliente não deve precisar de dicionário para saber o que a resposta quer
 * dizer.
 */
export const AVISO_NEGOCIO_ABERTO_EXISTENTE = "negocio_aberto_existente";

/** O que a tela linka: id para a URL, título para o texto do link. */
export interface NegocioAbertoExistente {
  id: string;
  title: string;
}

/** Forma mínima que as DUAS portas leem — o quadro tem bem mais campos. */
export interface NegocioLegivel {
  id: string;
  title: string;
  pipeline_id?: string | null;
  contact_id?: string | null;
  status?: string | null;
}

type AlvoDoQuadro = {
  pipelineId: string;
  contactId: string | null | undefined;
};

/**
 * A porta da TELA: filtra a lista de negócios que o diálogo já recebeu.
 *
 * Sem contato não há o que perguntar (o lead órfão é legítimo — #852), e sem
 * contato escolhido a resposta é `null`, nunca um "duplicado" sem pessoa.
 */
export function negocioAbertoNoQuadro(
  leads: ReadonlyArray<NegocioLegivel>,
  alvo: AlvoDoQuadro,
): NegocioAbertoExistente | null {
  if (!alvo.contactId) return null;
  const achado = leads.find(
    (l) =>
      l.pipeline_id === alvo.pipelineId && l.contact_id === alvo.contactId && l.status === "open",
  );
  return achado ? { id: achado.id, title: achado.title } : null;
}

type AlvoDaRota = {
  organizationId: string;
  contactId: string;
  pipelineId: string;
};

/**
 * A porta da API: a MESMA pergunta, feita ao banco antes do INSERT.
 *
 * Antes e não depois — o aviso descreve o mundo em que a pessoa pediu a
 * criação; consultado depois, o próprio negócio novo entraria na contagem.
 *
 * Falha de leitura devolve `null`, nunca lança: um aviso não pode ser o motivo
 * de um negócio legítimo não nascer (mesmo degrau de `moedaDaOrganizacao`), e
 * o `console.error` é o rastro de quem quiser investigar.
 */
export async function negocioAbertoExistente(
  supabase: SupabaseClient,
  alvo: AlvoDaRota,
): Promise<NegocioAbertoExistente | null> {
  const { data, error } = await supabase
    .from("crm_leads")
    .select("id, title")
    .eq("organization_id", alvo.organizationId)
    .eq("contact_id", alvo.contactId)
    .eq("pipeline_id", alvo.pipelineId)
    .eq("status", "open")
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[leads.duplicado] falha ao procurar negócio aberto", error.message);
    return null;
  }
  if (!data) return null;
  return { id: String(data.id), title: String(data.title) };
}
