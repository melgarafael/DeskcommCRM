/**
 * O defeito de um número que segue DE PÉ (`WORKING`) — a parte pura.
 *
 * Contrato entre três pontas: o adapter que o detecta (`checkHealth` escreve o
 * detalhe), a regra de aviso (`./health.ts`, que o grava em
 * `channel_sessions.status_reason` e abre o aviso na Central) e a tela de
 * Conexões, que o mostra. Mora num módulo sem banco nem dicionário para a tela,
 * que é cliente, ler o mesmo vocabulário sem arrastar a regra de aviso.
 *
 * O porquê de o status continuar `WORKING` está em `./health.ts`.
 */

/** A plataforma informa que as mensagens dos clientes não chegam ao CRM — o número ainda envia. */
export const DETALHE_NAO_RECEBE = "numero_nao_recebe_mensagens";
/** Seguido do código da plataforma (`131042`, `131031`, `368`…) ou de `desconhecido`. */
export const PREFIXO_ENVIO_RESTRITO = "envio_restrito_";

export type DefeitoDoNumero =
  | { tipo: "nao_recebe" }
  | { tipo: "envio_restrito"; codigo: string };

/** O detalhe (ou o `status_reason` gravado) é um destes defeitos? */
export function defeitoDoNumero(detalhe: string | null | undefined): DefeitoDoNumero | null {
  if (detalhe === DETALHE_NAO_RECEBE) return { tipo: "nao_recebe" };
  if (detalhe?.startsWith(PREFIXO_ENVIO_RESTRITO)) {
    const codigo = detalhe.slice(PREFIXO_ENVIO_RESTRITO.length);
    // O código vai para o texto da tela: só o que tem cara de código passa.
    return { tipo: "envio_restrito", codigo: /^[0-9a-z_]{1,24}$/.test(codigo) ? codigo : "desconhecido" };
  }
  return null;
}
