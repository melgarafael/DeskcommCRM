/**
 * Bloco de ESTADO DO ATENDIMENTO — continuidade determinística entre turnos.
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * Medido ao vivo (2026-09-21): o agente reperguntava dados já coletados (CPF,
 * nascimento) porque os `custom_fields` do contato são gravados mas não voltam de
 * forma explícita ao contexto; e voltava a oferecer motos depois de o cliente já
 * ter escolhido uma. A causa é o modelo ter que "lembrar" sozinho no meio do
 * histórico. Este bloco é DADO, montado pelo motor a cada turno: o que já sabemos,
 * o que já foi respondido no fluxo e a moto escolhida (TRAVA de decisão).
 *
 * É aditivo e conservador: só entra a linha que tem conteúdo. Sem escolha e sem
 * dados, devolve '' (zero token) — nada muda para conversas vazias.
 *
 * NÃO traz instrução de coleta (PENDENTES): quem manda nas perguntas é o bloco do
 * FLUXO ou o bloco "Dados essenciais". Aqui só se diz o que JÁ sabemos, para não
 * reperguntar — nunca o que falta.
 */
import type { MotoDoCatalogo } from './fotos-do-catalogo';

export interface EstadoDoAtendimentoInput {
  contact: { name?: string | null; custom_fields?: unknown } | null | undefined;
  escolhida: MotoDoCatalogo | null;
  /** Campos já respondidos no fluxo de atendimento (contact_flow_data). */
  valoresDoFluxo?: Record<string, string>;
}

function texto(valor: unknown): string | null {
  if (typeof valor === 'string' && valor.trim() !== '') return valor.trim();
  if (typeof valor === 'boolean') return valor ? 'sim' : 'não';
  if (typeof valor === 'number' && Number.isFinite(valor)) return String(valor);
  return null;
}

/** Bloco de estado; '' quando não há nada a declarar (economia de tokens). */
export function renderBlocoDeEstado(input: EstadoDoAtendimentoInput): string {
  const cf = (input.contact?.custom_fields ?? {}) as Record<string, unknown>;
  const nome = texto(input.contact?.name) ?? texto(cf.nome);
  const cidade = texto(cf.cidade);
  const cnh = texto(cf.cnh);
  const cpf = texto(cf.cpf);
  const nascimento = texto(cf.data_nascimento);

  const linhas: string[] = [];

  if (input.escolhida !== null) {
    const detalhe = [input.escolhida.ano, input.escolhida.cor].filter(Boolean).join(', ');
    linhas.push(
      `- Moto escolhida pelo cliente: ${input.escolhida.nome}${detalhe ? ` (${detalhe})` : ''}. ` +
        'NÃO ofereça outras motos nem reabra a escolha — conduza ao fechamento (forma de pagamento e o que falta).',
    );
  }

  const dados = [
    nome !== null ? `Nome: ${nome}` : null,
    cidade !== null ? `Cidade: ${cidade}` : null,
    cnh !== null ? `CNH: ${cnh}` : null,
    cpf !== null ? `CPF: ${cpf}` : null,
    nascimento !== null ? `Nascimento: ${nascimento}` : null,
  ].filter((l): l is string => l !== null);
  if (dados.length > 0) {
    linhas.push(`- Dados já coletados (NÃO pergunte de novo): ${dados.join(' | ')}`);
  }

  const fluxo = Object.entries(input.valoresDoFluxo ?? {}).filter(([, v]) => v.trim() !== '');
  if (fluxo.length > 0) {
    linhas.push(
      `- Já respondido no fluxo (NÃO pergunte de novo): ${fluxo.map(([k, v]) => `${k}: ${v}`).join(' | ')}`,
    );
  }

  if (linhas.length === 0) return '';
  return ['## Estado do atendimento (continue daqui — NÃO reinicie a conversa)', ...linhas].join('\n');
}
