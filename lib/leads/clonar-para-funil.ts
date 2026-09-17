/**
 * LEVAR UM NEGÓCIO PARA OUTRO FUNIL — o caminho que a P-01 manda usar e que não
 * existia.
 *
 * A P-01 diz que `crm_leads.pipeline_id` é imutável e que "mover entre funis" se
 * resolve clonando: cria-se o negócio no funil destino e encerra-se a origem. O
 * `/move` devolve 422 `pipeline_immutable_use_clone` mandando "clonar o lead para
 * o pipeline alvo" — e nenhuma rota, tool MCP ou tela materializava esse clone.
 * A instrução apontava para o vazio: quem recebia o 422 não tinha para onde ir.
 *
 * ⚠️ O clone da P-01 também trazia uma instrução IMPOSSÍVEL. Ela mandava fechar a
 * origem com `lost_reason='moved_to_pipeline_X'`, mas o trigger
 * `fn_validate_lost_reason_required` (baseline.sql:851) recusa qualquer motivo
 * fora da lista canônica do produto ou de `crm_pipelines.settings.lost_reasons`:
 * a origem morreria com `lost_reason_invalid` e o negócio ficaria aberto em DOIS
 * funis — o defeito que a troca de funil deveria evitar. Aqui a origem fecha com
 * um motivo canônico (default `other`) e o destino REAL fica registrado em
 * `source_metadata.movido_para`, que é onde a informação sobrevive.
 *
 * Este módulo é a parte DECIDÍVEL da troca (o que se copia, o que não se copia,
 * qual etapa recebe o clone, quando recusar). Quem fala com o banco é a rota
 * `app/api/v1/leads/[id]/clone/route.ts`.
 */
import type { CreateLeadInput } from "@/lib/schemas";

/** O negócio de origem, como a rota o lê do banco. */
export interface OrigemParaClonar {
  id: string;
  pipeline_id: string;
  status: string;
  title: string;
  description?: string | null;
  contact_id?: string | null;
  value_cents?: number | null;
  currency?: string | null;
  owner_user_id?: string | null;
  owner_agent_id?: string | null;
  expected_close_date?: string | null;
  tags?: string[] | null;
  source?: string | null;
  custom_fields?: Record<string, unknown> | null;
  source_metadata?: Record<string, unknown> | null;
}

/** As colunas de `crm_stages` que a escolha da etapa destino precisa. */
export interface EtapaDoFunil {
  id: string;
  pipeline_id: string;
  /** `numeric` no Postgres chega como string pelo PostgREST. */
  position: number | string;
  is_won: boolean;
  is_lost: boolean;
  is_archived: boolean;
}

/**
 * A recusa de fronteira de funil (P-01), UMA string para os DOIS call sites: a
 * rota `/move` (o quadro) e o `moveLeadHandler` (IA, lote e automações).
 *
 * ⚠️ Constante, e não literal repetido, porque o texto é CHAVE do dicionário: o
 * PR que a reescreveu mudou os dois lugares e deixou as duas entradas de espanhol
 * órfãs, então quem usa o produto em espanhol voltou a ler português. O gate de
 * i18n não pega isso — `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` varre
 * `app` e `components`, e ignora `api`. Com uma fonte só, mudar a frase e
 * esquecer a tradução deixa `tests/unit/recusa-de-funil-fala-espanhol.test.ts`
 * vermelho.
 */
export const RECUSA_DE_TROCA_DE_FUNIL =
  "Move cross-pipeline não é permitido. Use POST /api/v1/leads/[id]/clone para levar o negócio a outro funil.";

/** Recusa da rota quando o funil de destino não existe na organização. */
export const FUNIL_DE_DESTINO_NAO_ENCONTRADO = "Funil de destino não encontrado.";

/** Recusa da rota quando a origem não tem onde fechar (antes de criar o clone). */
export const ORIGEM_SEM_ETAPA_DE_PERDA =
  "O funil de origem não tem etapa de perda para encerrar o negócio.";

export interface Recusa {
  status: number;
  code: string;
  /** Texto em pt-BR — a rota traduz com `traduzir`. */
  texto: string;
}

export type ResultadoDaEtapa =
  | { ok: true; etapa: EtapaDoFunil }
  | { ok: false; status: number; code: string; texto: string };

/**
 * As duas trocas que ESTA rota não faz.
 *
 * Mesmo funil não é troca — é `/move`, que preserva a posição no quadro e não
 * encerra nada; passar por aqui fecharia o negócio como perdido para reabri-lo ao
 * lado. E negócio já encerrado não é clonado: a origem seria reescrita de `won`
 * para `lost` (perda de dado, não conveniência), e reabrir um negócio fechado é
 * decisão de produto que esta correção não toma.
 */
export function recusaTrocaDeFunil(
  origem: { pipeline_id: string; status: string },
  pipelineDestinoId: string,
): Recusa | null {
  if (origem.pipeline_id === pipelineDestinoId) {
    return {
      status: 422,
      code: "pipeline_unchanged",
      texto: "O negócio já está neste funil. Para trocar de etapa use /api/v1/leads/[id]/move.",
    };
  }
  if (origem.status !== "open") {
    return {
      status: 422,
      code: "lead_not_open",
      texto: "Só um negócio aberto pode ser levado para outro funil.",
    };
  }
  return null;
}

/**
 * Qual etapa recebe o clone.
 *
 * Com `stage_id` informado, ele precisa ser uma etapa do funil destino — a rota
 * só carrega as etapas daquele funil, então "não está na lista" é exatamente
 * "é de outro funil". Sem `stage_id`, a primeira etapa aberta (menor `position`):
 * `is_won`/`is_lost` não entram, porque nascer dentro de uma etapa de desfecho
 * fecharia o clone no mesmo instante em que ele foi criado.
 */
export function escolheEtapaDeDestino(
  etapas: EtapaDoFunil[],
  etapaInformadaId?: string | null,
): ResultadoDaEtapa {
  const abertas = etapas.filter((etapa) => !etapa.is_archived);

  if (etapaInformadaId) {
    const encontrada = abertas.find((etapa) => etapa.id === etapaInformadaId);
    if (!encontrada) {
      return {
        ok: false,
        status: 422,
        code: "stage_pipeline_mismatch",
        texto: "A etapa não pertence ao funil de destino.",
      };
    }
    if (encontrada.is_won || encontrada.is_lost) {
      return {
        ok: false,
        status: 422,
        code: "stage_destino_terminal",
        texto: "A etapa de destino é de fechamento: escolha uma etapa aberta do funil.",
      };
    }
    return { ok: true, etapa: encontrada };
  }

  const inicial = abertas
    .filter((etapa) => !etapa.is_won && !etapa.is_lost)
    .sort((a, b) => Number(a.position) - Number(b.position))[0];

  if (!inicial) {
    return {
      ok: false,
      status: 422,
      code: "pipeline_without_initial_stage",
      texto: "O funil de destino não tem etapa aberta para receber o negócio.",
    };
  }
  return { ok: true, etapa: inicial };
}

/**
 * O que o clone herda da origem — e o que ele NÃO herda.
 *
 * Herda o conteúdo do negócio (título, descrição, contato, valor, moeda, dono,
 * previsão, tags, campos personalizados) e registra de onde veio em
 * `source_metadata.clonado_de`. Não herda:
 *
 * - `external_id` — é a chave do pedido na origem; repetir o valor colide com
 *   `uniq_crm_leads_org_source_external` (org + source + external_id) e o clone
 *   nem nasceria;
 * - `status`/`lost_reason`/`closed_at` — o clone NASCE aberto (o banco fecha pelo
 *   trigger da etapa, que aqui é sempre uma etapa aberta);
 * - `position_in_stage` — quem posiciona é o handler de criação (MAX + 1000), que
 *   é quem conhece o fim da fila da etapa escolhida.
 *
 * ⚠️ `custom_fields` vem INTEIRO, inclusive chaves que o funil de destino não
 * declara em `settings.fields` — e já foi filtrado, por uma rodada que tratou a
 * declaração do funil como o único leitor do campo. Não é: a automação entrega o
 * jsonb cru à IA (`lib/automation/dados-do-formulario.ts`) e ao webhook de saída
 * (`lib/automation/actions/call-webhook.ts`), e resposta de formulário gravada em
 * chave nunca declarada é o caso comum. Filtrar apagava do negócio novo o que o
 * assistente sabia do cliente — e, com o destino sem campo declarado nenhum (o
 * outro caso comum), apagava TUDO. A chave que o destino não declara fica na
 * linha e só não aparece na tela do funil até alguém declará-la lá; é o mesmo
 * estado de quando um funil deixa de declarar um campo que já tinha valor.
 */
export function montaPayloadDoClone(
  origem: OrigemParaClonar,
  etapa: EtapaDoFunil,
): CreateLeadInput & {
  custom_fields: Record<string, unknown>;
  source_metadata: Record<string, unknown>;
} {
  const dono: { owner_user_id?: string; owner_agent_id?: string } = {};
  if (origem.owner_user_id) dono.owner_user_id = origem.owner_user_id;
  if (origem.owner_agent_id) dono.owner_agent_id = origem.owner_agent_id;

  return {
    pipeline_id: etapa.pipeline_id,
    stage_id: etapa.id,
    title: origem.title,
    description: origem.description ?? null,
    contact_id: origem.contact_id ?? null,
    value_cents: origem.value_cents ?? null,
    currency: origem.currency ?? "BRL",
    ...dono,
    expected_close_date: origem.expected_close_date ?? null,
    tags: origem.tags ?? [],
    source: origem.source ?? "manual",
    custom_fields: origem.custom_fields ?? {},
    source_metadata: {
      ...(origem.source_metadata ?? {}),
      clonado_de: {
        lead_id: origem.id,
        pipeline_id: origem.pipeline_id,
      },
    },
  };
}

/** O registro que fica na origem: para onde o negócio foi. */
export function registroDoDestino(
  clone: { id?: unknown; pipeline_id?: unknown; stage_id?: unknown },
): Record<string, unknown> {
  return {
    lead_id: clone.id ?? null,
    pipeline_id: clone.pipeline_id ?? null,
    stage_id: clone.stage_id ?? null,
  };
}
