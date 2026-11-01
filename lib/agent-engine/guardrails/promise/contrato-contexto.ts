/** Projeção factual local; não classifica respostas nem chama provedores de IA. */
import { scrubMessage } from '@/lib/sentry/scrub';
import type { ContextoDoAtendimento } from '../../agent/contexto-do-atendimento';
import { projetarContextoDoAtendimento } from './projecao-atendimento';

export interface PacoteFactual {
  candidate: string;
  serviceContext?: ContextoDoAtendimento;
}

export function pacoteFactualDaRevisao(p: PacoteFactual): Record<string, unknown> {
  const pacote: Record<string, unknown> = {
    mensagem: p.candidate,
    ...(p.serviceContext ? { contexto_atendimento: projetarContextoDoAtendimento(p.serviceContext) } : {}),
  };
  if (JSON.stringify({ ...pacote, mensagem: undefined }).length > 64000) {
    pacote.contexto_atendimento = { versao: 1, cobertura: 'excluded_by_limit', perfil: [], decisoes: [], operacoes: [], continuidade: [] };
    pacote.limite_contexto = true;
  }
  return JSON.parse(scrubMessage(JSON.stringify(pacote))) as Record<string, unknown>;
}
