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
 * - algo SAIU (`enviadas > 0`) — a conversa foi respondida;
 * - o turno foi DESCARTADO como obsoleto (o cliente escreveu de novo; o turno
 *   da mensagem nova responde a tudo);
 * - a conversa foi passada à equipe (o aviso da escalação é do sistema);
 * - o cap de envio do número barrou (o turno é reagendado mais abaixo);
 * - a cadeia vetou com um código que manda PARAR (opt-out, contato interno,
 *   conversa com a equipe, LGPD): reescrever não muda o veredito.
 *
 * ⚠️ Tentativa de envio que levou VETO não é razão legítima — e já foi. A
 * regra antiga exigia `tentativasDeEnvio === 0` com o argumento "o veto já
 * ensinou". Medido no teste 10 do aceite (2026-10-25, job 217c6925): o modelo
 * chamou `send_message` 2×, o `agenda_stall` vetou as duas (o erro de ensino
 * voltou DENTRO do loop) e ele encerrou o turno com texto solto — a correção
 * era o único caminho de recuperação e a regra a suprimiu. Resultado: cliente
 * sem resposta e agenda intacta. Veto não entregou nada; quem mede silêncio
 * defeito é `enviadas`, não tentativas.
 *
 * Fora disso, o motor pede UMA correção, com a mesma conversa e as mesmas
 * ferramentas — o mesmo desenho de `fecharOTurno` para o JSON de fechamento. O
 * modelo ainda pode decidir não responder; o que muda é que ele decide sabendo
 * que nada saiu.
 */
export const CORRECAO_DO_TURNO_MUDO =
  'Este turno terminou SEM nenhuma mensagem ao cliente: texto escrito fora de send_message não chega a ele. ' +
  'Se você tem algo a dizer ao cliente (resposta, pergunta, resumo do pedido), chame send_message agora, ' +
  'no idioma da conversa, com o texto final. Se decidiu de propósito não responder, encerre sem chamar nada. ' +
  // AGENDA — a receita do caso que a correção JÁ recebeu e errou (medido no
  // teste 10 do aceite, 2026-10-26, job 5ca40cb3): o diálogo trazia o veto
  // `agenda_stall` ("você afirmou confirmado sem a ferramenta") e a correção
  // resolveu isso como NOVO agendamento — chamou crm_find_and_book_appointment,
  // criou uma SEGUNDA consulta (30/10 09:00) e a original (29/10) ficou intacta.
  // O ensino do veto só lista ferramentas sem dizer qual serve para REMARCAR;
  // este bloco diz o caminho (localizar SEM `dia` — o dia chutado devolve lista
  // vazia, medido nos turnos 1 e 2 — e MOVER com crm_reschedule_appointment) e
  // a ordem (mudar a agenda ANTES de responder). Só vale quando o erro de ensino
  // no diálogo é de agenda; noutras conversas a condição não casa e o modelo
  // segue o parágrafo de cima.
  'Se o erro de ensino neste diálogo é de AGENDA (você afirmou um horário confirmado sem ferramenta) ' +
  'e o cliente está mudando um compromisso já marcado: localize-o com crm_list_appointments usando SÓ ' +
  'o contact_id — sem `dia`, porque o dia que você chutar devolve lista vazia e você não acha o ' +
  'compromisso — e MOVA o mesmo compromisso com crm_reschedule_appointment. Nunca use ' +
  'crm_book_appointment nem crm_find_and_book_appointment para remarcar: eles criam um SEGUNDO ' +
  'compromisso e deixam o antigo no lugar. Só depois de a agenda ter mudado de fato (a resposta ' +
  'trouxe "remarcado: true"), mande a confirmação por send_message com o resultado real; se a ' +
  'agenda não mudou, avise por send_message em vez de confirmar.';

/**
 * Teto de passos da correção. Folgado, não arbitrário: com 3 a correção do teste 10
 * (2026-10-26, job 5ca40cb3) gastou os três em ferramentas de agenda e parou antes do
 * send_message (`messages_sent: 0`). A receita de remarcar são 4 saídas de modelo
 * (localizar → slot → mover → enviar); 6 deixa folga sem deixar de ser limite — a
 * correção continua UMA chamada. Quem mede se a correção bateu no teto usa o MESMO número.
 */
export const PASSOS_DA_CORRECAO = 6;

export function turnoMudoPedeCorrecao(t: {
  /**
   * `send_message`/`send_template` chamados (vetados inclusive). Informativo —
   * NÃO gateia: tentativa vetada não entregou nada ao cliente (ver a nota
   * "VETO não é razão legítima" no cabeçalho deste arquivo).
   */
  tentativasDeEnvio: number;
  /**
   * A cadeia vetou um envio com um código que manda PARAR (stop/LGPD —
   * `VETOS_IRREVOGAVEIS`). Diferente do veto de ensino, aqui a correção pediria
   * ao modelo que tentasse de novo o que o veto proíbe: o silêncio é a decisão.
   */
  vetoIrrevogavel: boolean;
  enviadas: number;
  turnoDescartado: boolean;
  passouParaAEquipe: boolean;
  capDeEnvio: boolean;
}): boolean {
  return (
    t.enviadas === 0 &&
    !t.vetoIrrevogavel &&
    !t.turnoDescartado &&
    !t.passouParaAEquipe &&
    !t.capDeEnvio
  );
}
