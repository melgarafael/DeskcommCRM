/**
 * VALIDADOR DA RESPOSTA DO FLUXO — um agente dedicado, chamado SÓ quando o
 * fluxo de atendimento está esperando uma resposta.
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * O modelo principal do turno é ótimo para conversar e ruim para uma tarefa
 * estreita: no teste ao vivo de 2026-09-18 ele gravou "ok" em `troca_estado`,
 * `2019` em `troca_documentacao` e a frase de abertura em `troca_ano`. Cada
 * gravação errada é dado errado no cadastro do cliente.
 *
 * A captura determinística (regex por tipo) resolve o caso inequívoco, mas não
 * texto livre. Aqui entra a peça que faltava: quando há UMA pergunta pendente e
 * o cliente respondeu, uma chamada de modelo BARATA e com UMA tarefa —
 * "esta mensagem responde a esta pergunta? se sim, qual o dado sucinto?" —
 * decide o que vai para o banco. O modelo principal continua cuidando da
 * conversa; a ESCRITA do fluxo passa a ter um especialista.
 *
 * ─── Por que não usar o roteador de intenção ────────────────────────────────
 *
 * O roteador decide "qual agente atende esta conversa" — é um ponto de ENTRADA,
 * disparado no começo, não por turno. Este validador é por RESPOSTA: só roda
 * quando há pergunta de fluxo pendente, com o contexto certo (a pergunta + as
 * últimas mensagens). Reusar o roteador exigiria torcer o propósito dele; o
 * painel de pontos de IA é o mecanismo certo — o operador escolhe o modelo
 * deste ponto como escolhe os outros.
 *
 * ─── Segurança ──────────────────────────────────────────────────────────────
 *
 * Saída é JSON com `respondeu` (bool) e `valor` (string). `valor` só é aceito
 * quando passa na mesma validação de tipo da captura (`valorBateComTipo`);
 * fora disso, `null` — o motor mantém a pergunta pendente. Falha de modelo NÃO
 * derruba o turno: devolve `indefinido` e o fluxo segue como antes.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import type { ProviderRegistry } from '../edge/llm/providers';
import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import { valorBateComTipo } from '@/lib/followup/captura-do-fluxo';

/** O que o validador enxerga da pergunta pendente. */
export interface PerguntaDoFluxo {
  key: string;
  label: string;
  question?: string | undefined;
  type: 'text' | 'number' | 'date' | 'boolean' | 'select';
  options?: string[] | undefined;
}

/** Uma linha da conversa que vai no prompt (poucas, recentes). */
export interface MensagemDoContexto {
  de: 'cliente' | 'loja';
  texto: string;
}

export type LeituraDaResposta =
  | { resultado: 'respondeu'; valor: string }
  | { resultado: 'nao_respondeu' }
  /** O validador não pôde ser usado (modelo/chave ausente, saída ilegível). */
  | { resultado: 'indefinido' };

const INSTRUCAO =
  'Você é um validador auxiliar de um sistema de vendas (NÃO fala com o cliente). ' +
  'Recebe a PERGUNTA que o sistema fez e as ÚLTIMAS mensagens da conversa. ' +
  'Sua única tarefa: decidir se a mensagem mais recente do CLIENTE responde à pergunta e, ' +
  'se responder, extrair o dado EXATO que deve ser guardado — sem inventar, sem completar. ' +
  'Responda SOMENTE com JSON: {"respondeu": true|false, "valor": "<dado>"}. ' +
  'Regras do campo `valor`: para sim/não use "true"/"false"; para número, só os dígitos (sem "km", "ano", "R$"); ' +
  'para data, "AAAA-MM-DD"; para escolha, exatamente uma das opções informadas; para texto livre, o trecho ' +
  'sucinto que responde. Se o cliente NÃO respondeu (falou de outro assunto, mandou "ok"/emoji, ou a mensagem ' +
  'não contém o dado), use {"respondeu": false, "valor": ""}.';

/** Monta a mensagem do modelo. Puro — coberto por teste. */
export function montarMensagemDoValidador(
  pergunta: PerguntaDoFluxo,
  mensagens: readonly MensagemDoContexto[],
): string {
  const opcoes =
    pergunta.type === 'select' && (pergunta.options?.length ?? 0) > 0
      ? ` (uma de: ${pergunta.options!.join(', ')})`
      : '';
  const conversa = mensagens
    .slice(-6)
    .map((m) => `- ${m.de === 'cliente' ? 'CLIENTE' : 'LOJA'}: ${m.texto}`)
    .join('\n');
  return [
    INSTRUCAO,
    '',
    '## Pergunta feita',
    `${pergunta.question?.trim() || pergunta.label} (campo: ${pergunta.label}, tipo: ${pergunta.type}${opcoes})`,
    '',
    '## Últimas mensagens (a mais recente é a que importa)',
    conversa,
  ].join('\n');
}

/** Extrai o JSON do modelo (tolerante a prosa/cerca em volta). */
export function parseLeituraDoValidador(texto: string): { respondeu: boolean; valor: string } | null {
  const m = /\{[\s\S]*\}/.exec(texto);
  if (m === null) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj.respondeu !== 'boolean') return null;
  const valor = typeof obj.valor === 'string' ? obj.valor.trim() : '';
  return { respondeu: obj.respondeu, valor };
}

/**
 * Valida a resposta contra a pergunta pendente. Chama o modelo (ponto
 * `flow_validate`); falha de qualquer natureza devolve `indefinido` — quem
 * chama decide o fallback (hoje: deixa o modelo principal tentar).
 */
export async function validarRespostaDoFluxo(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string; jobId: string },
  args: { pergunta: PerguntaDoFluxo; mensagens: readonly MensagemDoContexto[] },
  deps: { registry?: ProviderRegistry; log: Logger },
): Promise<LeituraDaResposta> {
  let texto: string;
  try {
    const call = await runModelCall(
      db,
      cfg,
      {
        tenantId: ids.tenantId,
        leadId: ids.leadId,
        jobId: ids.jobId,
        purpose: 'flow_validate',
        messages: [{ role: 'user', content: montarMensagemDoValidador(args.pergunta, args.mensagens) }],
      },
      { registry: deps.registry, log: deps.log },
    );
    texto = call.result.text;
  } catch {
    return { resultado: 'indefinido' };
  }

  const leitura = parseLeituraDoValidador(texto);
  if (leitura === null) return { resultado: 'indefinido' };
  if (!leitura.respondeu) return { resultado: 'nao_respondeu' };
  // A saída passa pela MESMA régua de tipo da captura determinística: o
  // validador não é autoridade sobre o formato, só sobre o conteúdo.
  const campo = {
    key: args.pergunta.key,
    label: args.pergunta.label,
    type: args.pergunta.type,
    ...(args.pergunta.options !== undefined ? { options: args.pergunta.options } : {}),
    ...(args.pergunta.question !== undefined ? { question: args.pergunta.question } : {}),
  };
  if (!valorBateComTipo(campo, leitura.valor)) return { resultado: 'nao_respondeu' };
  return { resultado: 'respondeu', valor: leitura.valor };
}
