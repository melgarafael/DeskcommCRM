import { toast } from "sonner";

/** O `{changed, motivo?}` das rotas suspend/reactivate (funções da migration 0501). */
export interface ResultadoDaTransicao {
  data?: { changed?: boolean; motivo?: string };
}

/**
 * `changed:false` é 200 e NÃO é sucesso: outro admin agiu antes e a tela estava
 * velha. Mostra o motivo e devolve `true`; quem chama só comemora se `false`.
 */
export function avisarSeNadaMudou(resposta: ResultadoDaTransicao | undefined, t: (texto: string) => string): boolean {
  if (resposta?.data?.changed !== false) return false;
  toast.info(t("Nada mudou"), { description: motivoLegivel(resposta.data.motivo, t) });
  return true;
}

function motivoLegivel(motivo: string | undefined, t: (texto: string) => string): string | undefined {
  switch (motivo) {
    case "ja_suspensa":
      return t("Esta empresa já estava suspensa.");
    case "org_encerrada":
      return t("Esta empresa foi encerrada ou anonimizada e já não opera.");
    case "nao_suspensa":
      return t("Esta empresa não estava suspensa.");
    case "suspensao_de_cobranca":
      return t("Esta suspensão é por falta de pagamento. Use Dar prazo ou Tornar isenta.");
    default:
      // ponytail: motivo novo da função sem frase aqui cai no "Nada mudou" puro — não inventa causa.
      return undefined;
  }
}
