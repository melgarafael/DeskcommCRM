import { INSTRUCAO_ALCANCE_RECIBO_AGENDA } from '@/lib/agenda/pedido';
import { falhaTecnicaDaRevisaoDeAgenda } from '@/lib/agenda/falha-revisao';

/** Estado de UMA execução, alimentado somente pelo veto e pelo recibo do canal. */
export function criarRecuperacaoDeEnvioDaAgenda() {
  let pendente: { candidate: string; code: string } | undefined;
  let corrigindo = false;
  let tentou = false;
  let ultimaRecusa: string | undefined;
  let aguardandoCanal = false;
  let cauda: Promise<void> = Promise.resolve();
  return {
    emOrdem: <T>(executar: () => Promise<T>): Promise<T> => {
      const atual = cauda.then(executar);
      cauda = atual.then(() => undefined, () => undefined);
      return atual;
    },
    contexto: () => pendente,
    falhaTecnica: () => Boolean(pendente) && falhaTecnicaDaRevisaoDeAgenda(ultimaRecusa),
    interromper: () => pendente !== undefined || aguardandoCanal,
    /** Mesmo lote de tool calls pode continuar após o veto; não deixe passar a próxima mensagem. */
    permitirTentativa: () => {
      if (aguardandoCanal) return false;
      if (!pendente) return true;
      if (!corrigindo || tentou) return false;
      tentou = true;
      return true;
    },
    recusar: (candidate: string, code: string) => {
      if (code === 'agenda_request_mismatch' || code === 'human_decision_unfaithful' || falhaTecnicaDaRevisaoDeAgenda(code)) {
        ultimaRecusa = code;
        if (!pendente) pendente = { candidate, code };
      }
    },
    iniciarCorrecao: () => {
      if (!pendente || corrigindo || tentou) return false;
      corrigindo = true;
      return true;
    },
    encerrarCorrecao: () => { corrigindo = false; },
    registrarCanal: (kind: string) => {
      if (!corrigindo || !pendente) return;
      if (kind === 'sent' || kind === 'already_sent') pendente = undefined;
      // Aceite em fila não é entrega: não reenvie e não libere as orientações seguintes.
      if (kind === 'queued') { aguardandoCanal = true; pendente = undefined; }
    },
  };
}

export const CORRECAO_DO_ENVIO_DE_AGENDA = `A resposta de agenda NÃO chegou ao cliente.
Um código agenda_review_* indica falha técnica/inconclusiva da revisão, não afirmação falsa comprovada.
Não atribua essa falha à pergunta do cliente nem diga que a reserva foi executada.
Se não há prova suficiente para informar disponibilidade, uma explicação honesta ou pergunta de preferência
pode ser proposta, sem inventar horário, e ainda precisa passar pela revisão com as fontes disponíveis.
Há UMA tentativa de recuperação, somente com send_message. Releia o pedido canônico e os recibos
atuais abaixo. Se resultado_agenda_do_turno estiver presente, use a ação e o recibo
relido da MESMA reserva/revisão como ponto de partida; confronte-os com o pedido canônico atual.
Cancelar comunica a reserva que deixou de estar ativa; remarcar comunica o destino atual.
Não recupere uma resposta de reserva ativa ou de Caso antigo quando a operação atual foi cancelar.
Reescreva a resposta sobre a ação pedida, fiel ao que foi comprovado; se não foi
executada, explique honestamente o estado/impedimento. A tentativa recusada não é prova de execução
nem autorização humana. Não repita reserva/remarcação/cancelamento nem chame ferramentas de escrita.
Use a reserva e a revisão pertinentes ao pedido atual; uma reserva anterior cancelada não anula
uma nova reserva publicada. Não atribua aprovação à equipe sem fonte humana elegível.
Comece por essa resposta: não a substitua por saudação, formulário, link ou instruções posteriores.
Somente depois de send_message devolver envio aceito, retome as orientações previstas para o
resultado atual, sem repetir o que já foi enviado nem inventar novas condições.
Todas as proteções continuam valendo. Se o envio não passar, encerre sem fingir que foi entregue.
${INSTRUCAO_ALCANCE_RECIBO_AGENDA}`;
