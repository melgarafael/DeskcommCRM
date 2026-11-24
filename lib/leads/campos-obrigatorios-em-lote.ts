/**
 * OS CAMPOS OBRIGATÓRIOS DE UM LOTE — a régua do quadro e a da transferência em
 * massa, numa função só (#4852 sobre a #1536).
 *
 * ─── Por que este módulo existe ────────────────────────────────────────────
 *
 * `validaCamposExigidos` é a decide-exigência (um card). O que NÃO estava
 * compartilhado é o RECORTE do lote: percorrer N negócios, pedir o `settings`
 * do funil de CADA um, ler os anexos dos campos `file` e devolver a recusa com
 * `details.lead_ids` + `details.faltando` por card. Essa parte vivia inline em
 * `POST /api/v1/leads/bulk` e a transferência de funil (`POST
 * /api/v1/pipelines/[id]/negocios`) não a tinha — o destinatário de um lote
 * podia entrar numa etapa que o funil de destino exige campo sem que ninguém
 * perguntasse.
 *
 * Duas cópias do recorte divergem no primeiro ajuste: uma passa a checar anexo,
 * a outra não; uma lista o card que falta, a outra devolve o primeiro. É o mesmo
 * defeito que a #917/#1536 fecharam para a decisão de UM card.
 *
 * ─── O que ele NÃO decide ──────────────────────────────────────────────────
 *
 * Se a escrita acontece. Quem chama é que responde 422 com `recusa`. E a régua
 * de QUAL funil manda: o do negócio (lote do quadro) ou o do DESTINO (a
 * transferência, em que o negócio vai passar a morar no outro funil) — as duas
 * são a mesma pergunta feita com `settingsDoFunilDe` diferente, e é por isso
 * que ele é uma função, não um valor.
 *
 * `camposComAnexo` custa uma ida ao banco por card, e só em funil com campo
 * `file` exigível — o custo é o de antes, agora nos dois chamadores.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  camposComAnexo,
  recusaDeCamposObrigatorios,
  validaCamposExigidos,
  type CampoFaltando,
  type DestinoDaEscrita,
} from "@/lib/leads/campos-exigidos";
import type { Idioma } from "@/lib/i18n/idiomas";

/**
 * O mínimo que a régua lê de um negócio — o mesmo recorte nos dois chamadores.
 *
 * Sem índice aberto (`[coluna: string]: unknown`), de propósito: com ele, a
 * linha tipada de um chamador (`NegocioDoFunil`, na transferência) NÃO é
 * atribuível — a TypeScript exige que a origem também declare o índice, e o
 * `tsc` reprova o call site que passa o próprio recorte. Sem ele, os dois
 * chamadores entram sem cast: é o contrato que a régua lê, e nada além.
 */
export interface NegocioDoLote {
  id: string;
  /** O funil do NEGÓCIO: é dele que sai o `settings` no lote do quadro. */
  pipeline_id?: string | null;
  custom_fields?: Record<string, unknown> | null;
  won_reason?: string | null;
}

/** A recusa pronta — o MESMO `422 required_fields_missing` nos dois caminhos. */
export interface RecusaDeCamposDoLote {
  codigo: "required_fields_missing";
  mensagem: string;
  /** Os cards que faltam, na ordem em que a leitura os trouxe. */
  lead_ids: string[];
  /** O que falta em cada um — a tela abre o diálogo por card. */
  faltando: Record<string, CampoFaltando[]>;
}

export interface EntradaDeCamposDoLote {
  supabase: SupabaseClient;
  organizationId: string;
  negocios: readonly NegocioDoLote[];
  /**
   * O `settings` do funil que manda nesta escrita. Recebe o `pipeline_id` do
   * CARD (o lote do quadro pode cruzar funis) e devolve o `settings` cru —
   * `null` = funil desconhecido = nada exigido (o fail-open de
   * `settingsDoFunil`). Quem chama cacheia o que já leu.
   */
  settingsDoFunilDe: (pipelineId: string | null) => unknown;
  /** A etapa de destino (e o desfecho, quando a escrita fecha o negócio). */
  destino: DestinoDaEscrita;
  idioma?: Idioma | null;
}

/**
 * Percorre o lote e devolve a recusa (ou `null`, com o mapa vazio por card).
 *
 * `faltandoPorCard` sai junto porque a rota o usa em `details.faltando` — a
 * mesma lista que a recusa carrega. Devolver as duas coisas evita que um
 * chamador reconstrua o mapa por fora e as duas versões andem separadas.
 */
export async function recusaDeCamposDoLote(
  entrada: EntradaDeCamposDoLote,
): Promise<{ recusa: RecusaDeCamposDoLote | null; faltandoPorCard: Record<string, CampoFaltando[]> }> {
  const leadIdsSemCampos: string[] = [];
  const faltandoPorCard: Record<string, CampoFaltando[]> = {};

  for (const negocio of entrada.negocios) {
    const funilId = negocio.pipeline_id ?? null;
    const settingsDaLinha = entrada.settingsDoFunilDe(funilId);
    const veredito = validaCamposExigidos({
      lead: negocio as unknown as Record<string, unknown>,
      settingsDoFunil: settingsDaLinha,
      camposComAnexo: await camposComAnexo(
        entrada.supabase,
        settingsDaLinha,
        entrada.organizationId,
        negocio.id,
      ),
      destino: entrada.destino,
      motivoDeGanho: negocio.won_reason ?? null,
    });
    if (veredito.faltando.length > 0) {
      leadIdsSemCampos.push(negocio.id);
      faltandoPorCard[negocio.id] = veredito.faltando;
    }
  }

  if (leadIdsSemCampos.length === 0) return { recusa: null, faltandoPorCard };

  const recusa = recusaDeCamposObrigatorios(
    Object.values(faltandoPorCard).flat(),
    entrada.idioma,
  );
  return {
    recusa: {
      codigo: recusa.codigo,
      mensagem: recusa.mensagem,
      lead_ids: leadIdsSemCampos,
      faltando: faltandoPorCard,
    },
    faltandoPorCard,
  };
}
