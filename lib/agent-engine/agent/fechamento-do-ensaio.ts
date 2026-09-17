/**
 * Fechamento do turno no ensaio isolado (aba Teste).
 *
 * O checkpoint existe para o TURNO SEGUINTE de um lead real: `lead_checkpoints`
 * alimenta a abertura (`latestCheckpoint`), o Operador (`checkpointDoJob`),
 * handoff, score e a timeline. O dry-run da aba Teste monta um cenário fresco
 * a cada clique, com `contactId: null` e sem `previous` — o JSON gerado iria
 * só para `preview.result.checkpoint`, que a tela não mostra e o próximo
 * ensaio não relê. Persistência (`insertCheckpoint`) já era pulada no preview.
 *
 * Por isso o ensaio isolado NÃO chama `purpose=checkpoint`. Atendimento real
 * e preview assistido (rascunho de conversa viva) continuam fechando.
 */
import type { PreviewResult, TurnPreview } from "./preview";

export const MOTIVO_CHECKPOINT_OMITIDO_ENSAIO = "isolated_run" as const;

export const AVISO_CHECKPOINT_OMITIDO_ENSAIO =
  "Checkpoint não gerado: ensaio isolado.";

export function deveGerarCheckpointDoFechamento(
  preview: Pick<TurnPreview, "isolated"> | null | undefined,
): boolean {
  if (preview == null) return true;
  return preview.isolated !== true;
}

export function omitirCheckpointDoEnsaio(result: PreviewResult): void {
  result.checkpoint = undefined;
  result.checkpoint_omitted = true;
  result.checkpoint_omitted_reason = MOTIVO_CHECKPOINT_OMITIDO_ENSAIO;
  if (result.candidates.length === 0 && result.impediments.length === 0) {
    result.impediments.push({
      code: "no_candidate",
      message: "O agente não propôs uma resposta. Revise o cenário ou a configuração.",
    });
  }
}
