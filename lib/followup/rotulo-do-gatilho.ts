/**
 * O NOME DE CADA TIPO DE GATILHO, como a tela de edição do fluxo o mostra.
 *
 * Morava dentro de `TriggerConfigControl.tsx` (o seletor do gatilho). Desceu
 * para cá quando a BUSCA da lista de Follow-ups passou a casar com o gatilho
 * (#4593): a pessoa procura pela palavra que leu no seletor, e duas cópias do
 * rótulo divergiriam no primeiro ajuste.
 *
 * São textos em português porque são a CHAVE do dicionário — quem traduz é o
 * `t()` de cada tela, nunca este módulo.
 */

/** Os tipos de gatilho que a tela sabe editar (`triggerConfigSchema` tem também o `conversation_end`, sem tela). */
export type TipoDeGatilhoDaTela =
  | "appointment_no_show"
  | "manual"
  | "silence"
  | "stage_change"
  | "case_opened"
  | "webhook"
  | "inbound_after_silence"
  | "lead_created";

export const ROTULO_DO_GATILHO: Record<TipoDeGatilhoDaTela, string> = {
  appointment_no_show: "Falta confirmada pela equipe",
  manual: "Manual",
  silence: "Silêncio",
  stage_change: "Etapa do funil",
  // "Agente pediu ajuda", e não "Pedido de ajuda": numa lista ao lado de
  // "Manual", "Silêncio" e "Etapa do funil", o rótulo sem sujeito não diz
  // QUEM pediu. O resumo do botão (`resumoDoGatilho`) e o vocabulário
  // (`lib/followup/vocabulario.ts`) já falam de "o agente pede ajuda" —
  // esta era a única das três grafias sem sujeito, e as duas specs que
  // cercam o gatilho procuram por ela com `exact: true`.
  case_opened: "Agente pediu ajuda",
  webhook: "Automação (Webhooks)",
  inbound_after_silence: "Cliente voltou",
  lead_created: "Lead criado",
};

/**
 * O rótulo do tipo gravado em `trigger_config.kind`, ou `null` quando o tipo é
 * desconhecido ou ausente — nunca inventa um nome (nem «Manual») para dado que
 * a tela não sabe ler.
 */
export function rotuloDoGatilho(kind: string | null | undefined): string | null {
  const tipo = tipoDaTela(kind);
  return tipo ? ROTULO_DO_GATILHO[tipo] : null;
}

function tipoDaTela(kind: string | null | undefined): TipoDeGatilhoDaTela | null {
  if (!kind || !Object.hasOwn(ROTULO_DO_GATILHO, kind)) return null;
  return kind as TipoDeGatilhoDaTela;
}

/**
 * O tipo de gatilho que a BUSCA da lista de Follow-ups usa para o `trigger_kind`
 * da linha (#4593), na mesma leitura do editor:
 *
 * - `null` — a configuração não tem `kind`; o editor mostra «Manual».
 * - ausente (`undefined`) — a linha veio de uma escrita e a lista ainda não foi
 *   relida: não se sabe o gatilho, e chutar «Manual» rotularia errado uma cópia.
 * - tipo desconhecido — sem rótulo (o editor diz «indisponível»).
 */
export function tipoDoGatilhoNaLista(kind: string | null | undefined): TipoDeGatilhoDaTela | null {
  if (kind === null) return "manual";
  return tipoDaTela(kind);
}

/** O rótulo (chave do dicionário) de `tipoDoGatilhoNaLista`. */
export function rotuloDoGatilhoNaLista(kind: string | null | undefined): string | null {
  const tipo = tipoDoGatilhoNaLista(kind);
  return tipo ? ROTULO_DO_GATILHO[tipo] : null;
}
