import { transportaMensagem } from "@/lib/channels/capabilities";

/** O mínimo de `channel_sessions` que a regra lê — o que a listagem já devolve. */
export interface SessaoDeNumero {
  id: string;
  provider?: string;
  status: string;
  phone_number: string | null;
  display_name: string | null;
}

export type OutroNumero<S extends SessaoDeNumero = SessaoDeNumero> = S & { conectado: boolean };

/** O único estado em que o número entrega agora. O resto é conectando, caído ou parado. */
const CONECTADO = "WORKING";

/**
 * Números por onde o MESMO contato pode ser atendido, fora o da conversa.
 *
 * "Número" é sessão com telefone e transporte de mensagem: rede social não tem
 * telefone (o contato de lá é outro endereço) e linha de voz não manda texto.
 * Testar o telefone em vez de perguntar QUAL canal é mantém a regra de pé para
 * um canal novo, e é o que a doutrina de restrição de canal pede.
 *
 * Números fora do ar ficam NA lista, desabilitados na tela: sumir com eles
 * esconderia do atendente por que a opção que ele esperava não está lá.
 */
export function outrosNumerosDoContato<S extends SessaoDeNumero>(
  sessoes: readonly S[] | undefined,
  sessaoAtualId: string,
): OutroNumero<S>[] {
  return (sessoes ?? [])
    .filter((s) => s.id !== sessaoAtualId && !!s.phone_number && transportaMensagem(s.provider))
    .map((s) => ({ ...s, conectado: s.status === CONECTADO }));
}

/**
 * A faixa "responder por outro número" aparece quando as duas coisas valem: o
 * número desta conversa não entrega agora, e existe outro que entrega.
 *
 * Sessão ausente da lista (`undefined`) NÃO é queda — é lista que ainda não
 * chegou, ou canal arquivado. Afirmar queda sem ter lido o status mandaria o
 * atendente trocar de número à toa.
 */
export function numeroForaDoArComSaida(
  sessoes: readonly SessaoDeNumero[] | undefined,
  sessaoAtualId: string,
): boolean {
  const atual = sessoes?.find((s) => s.id === sessaoAtualId);
  if (!atual || !atual.phone_number || atual.status === CONECTADO) return false;
  return outrosNumerosDoContato(sessoes, sessaoAtualId).some((n) => n.conectado);
}
