/**
 * TURNO MUDO — o turno de resposta que terminou sem mensagem ao cliente.
 *
 * A resposta ao cliente só sai por `send_message`/`send_template`; o texto que o
 * modelo escreve fora delas não chega a ninguém. Medido numa instalação real
 * (06/10/2026): o cliente mandou os dados de entrega, o agente gravou o pedido,
 * perguntou o sobrenome em TEXTO SOLTO e encerrou — `messages_sent: 0`, sem
 * veto, sem descarte, e o cliente ficou sem resposta logo depois de passar os
 * dados. Nada no motor percebia.
 *
 * O silêncio às vezes é decisão, e aí não há o que corrigir:
 * - o modelo TENTOU enviar (a cadeia vetou, o teto barrou — o veto já ensinou);
 * - o turno foi DESCARTADO como obsoleto (o cliente escreveu de novo; o turno
 *   da mensagem nova responde a tudo);
 * - a conversa foi passada à equipe (o aviso da escalação é do sistema);
 * - o cap de envio do número barrou (o turno é reagendado mais abaixo).
 *
 * Fora disso, o motor pede UMA correção, com a mesma conversa e as mesmas
 * ferramentas — o mesmo desenho de `fecharOTurno` para o JSON de fechamento. O
 * modelo ainda pode decidir não responder; o que muda é que ele decide sabendo
 * que nada saiu.
 */
export const CORRECAO_DO_TURNO_MUDO =
  'Este turno terminou SEM nenhuma mensagem ao cliente: texto escrito fora de send_message não chega a ele. ' +
  'Se você tem algo a dizer ao cliente (resposta, pergunta, resumo do pedido), chame send_message agora, ' +
  'no idioma da conversa, com o texto final. Se decidiu de propósito não responder, encerre sem chamar nada.';

export function turnoMudoPedeCorrecao(t: {
  tentativasDeEnvio: number;
  enviadas: number;
  turnoDescartado: boolean;
  passouParaAEquipe: boolean;
  capDeEnvio: boolean;
}): boolean {
  return (
    t.tentativasDeEnvio === 0 &&
    t.enviadas === 0 &&
    !t.turnoDescartado &&
    !t.passouParaAEquipe &&
    !t.capDeEnvio
  );
}
