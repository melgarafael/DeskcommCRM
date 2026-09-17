/**
 * No ensaio, geração da resposta e autorização de entrega são perguntas
 * diferentes. No atendimento real, a cadeia `before-send` continua inteira e
 * nesta ordem — este arquivo NÃO é chamado no envio ao vivo.
 *
 * Entrega (operacional): posso mandar AGORA neste número/canal/hora?
 * Segurança (conteúdo/direito): posso falar ISTO a esta pessoa?
 */
import { BEFORE_SEND_GATES, type Gate } from './before-send';

const NOMES_DE_ENTREGA = new Set(['pacing', 'messaging_window', 'spinning']);

const CODIGOS_DE_ENTREGA = new Set([
  'outside_window',
  'warmup_cap',
  'daily_cap',
  'messaging_window_closed',
  'mass_identical',
]);

const MENSAGEM_DE_ENTREGA: Record<string, string> = {
  outside_window: 'Fora da janela de envio 7h–22h',
  warmup_cap: 'Limite de aquecimento do número',
  daily_cap: 'Limite diário de envio do número',
  messaging_window_closed: 'Janela de conversa do canal fechada',
  mass_identical: 'Cópia idêntica demais para este número',
};

const CATEGORIA_DE_SEGURANCA: Record<string, string> = {
  contato_bloqueado: 'O contato pediu para não receber mensagens',
  lgpd_anonymized: 'Contato anonimizado (LGPD)',
  lgpd_missing_legal_basis: 'Sem base legal para o primeiro contato',
  promise_out_of_table: 'Promessa fora das condições cadastradas',
  promise_semantic: 'Promessa não permitida',
  case_promise_without_case: 'Promessa sobre um chamado que não existe',
  internal_vocabulary_leak: 'A resposta usaria palavras internas',
  agenda_stall_sem_ferramenta: 'Horário afirmado sem consultar a agenda',
  disclosure_required: 'Falta a apresentação como assistente virtual',
};

export type ClasseDeImpedimento = 'entrega' | 'seguranca';
export type StatusDeEntregaDoEnsaio = 'allowed' | 'blocked' | 'withheld';

export type ImpedimentoDoEnsaio = {
  classe: ClasseDeImpedimento;
  code: string;
  gate?: string;
  message: string;
};

export const BEFORE_SEND_GATES_DE_ENTREGA: readonly Gate[] = BEFORE_SEND_GATES.filter((g) =>
  NOMES_DE_ENTREGA.has(g.name),
);

export const BEFORE_SEND_GATES_DE_SEGURANCA: readonly Gate[] = BEFORE_SEND_GATES.filter(
  (g) => !NOMES_DE_ENTREGA.has(g.name),
);

export function classeDoImpedimento(code: string, gate?: string): ClasseDeImpedimento {
  if (gate !== undefined && NOMES_DE_ENTREGA.has(gate)) return 'entrega';
  if (CODIGOS_DE_ENTREGA.has(code)) return 'entrega';
  return 'seguranca';
}

export function mensagemSanitizadaDoImpedimento(
  code: string,
  classe: ClasseDeImpedimento,
  janela?: { start: number; end: number },
): string {
  if (classe === 'entrega') {
    if (code === 'outside_window' && janela) {
      return `Fora da janela de envio ${janela.start}h–${janela.end}h`;
    }
    return MENSAGEM_DE_ENTREGA[code] ?? 'Envio bloqueado por regra operacional';
  }
  return CATEGORIA_DE_SEGURANCA[code] ?? 'A resposta não pode ser exibida';
}

export function classificarVeto(veto: {
  gate: string;
  code: string;
  message: string;
}): ImpedimentoDoEnsaio {
  const classe = classeDoImpedimento(veto.code, veto.gate);
  return {
    classe,
    code: veto.code,
    gate: veto.gate,
    message: mensagemSanitizadaDoImpedimento(veto.code, classe),
  };
}
