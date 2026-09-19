/**
 * VALIDADOR DA RESPOSTA DO FLUXO — um agente dedicado, chamado SÓ quando o
 * fluxo de atendimento está esperando resposta ou o cliente pode estar
 * corrigindo um dado.
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * O modelo principal do turno é ótimo para conversar e ruim para uma tarefa
 * estreita: no teste ao vivo de 2026-09-18 ele gravou "ok" em `troca_estado`,
 * `2019` em `troca_documentacao` e a frase de abertura em `troca_ano`. Cada
 * gravação errada é dado errado no cadastro do cliente.
 *
 * A captura determinística (regex por tipo) resolve o caso inequívoco, mas não
 * texto livre nem correção. Aqui entra a peça que faltava: uma chamada de modelo
 * BARATA e com UMA tarefa — "o cliente respondeu a esta pergunta? se sim, qual o
 * dado exato?" — decide o que vai para o banco. O modelo principal continua
 * cuidando da conversa; a ESCRITA do fluxo passa a ter um especialista.
 *
 * ─── Correção ───────────────────────────────────────────────────────────────
 *
 * O validador também recebe os campos JÁ PREENCHIDOS que permitem correção. Se
 * a mensagem do cliente corrige um deles ("na verdade o ano é 2020"), ele
 * devolve `campo` = a chave corrigida — e o motor sobrescreve. Sem isso, só o
 * `flow_collect` do modelo corrigia, e ele é justamente o elo frágil.
 *
 * ─── Segurança ──────────────────────────────────────────────────────────────
 *
 * Saída é JSON com `campo`, `respondeu` (bool) e `valor` (string). `valor` só é
 * aceito quando passa na validação de tipo (`valorBateComTipo`); fora disso,
 * `nao_respondeu`. O `campo` só é aceito se for a pendente ou um corrigível.
 * Falha de modelo NÃO derruba o turno: devolve `indefinido`.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import type { ProviderRegistry } from '../edge/llm/providers';
import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import { valorBateComTipo } from '@/lib/followup/captura-do-fluxo';

/** O que o validador enxerga de uma pergunta do fluxo. */
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
  | { resultado: 'respondeu'; valor: string; campo: string }
  | { resultado: 'nao_respondeu' }
  /** O validador não pôde ser usado (modelo/chave ausente, saída ilegível). */
  | { resultado: 'indefinido' };

const INSTRUCAO =
  'Você é um validador auxiliar de um sistema de vendas (NÃO fala com o cliente). ' +
  'Recebe a PERGUNTA pendente, os DADOS já preenchidos (que podem ser corrigidos) e as ÚLTIMAS ' +
  'mensagens da conversa. Sua única tarefa: decidir se a mensagem mais recente do CLIENTE responde ' +
  'à pergunta pendente, CORRIGE um dado já preenchido, ou nenhuma das duas. ' +
  'Responda SOMENTE com JSON: {"campo": "<chave>", "respondeu": true|false, "valor": "<dado>"}. ' +
  'Use a CHAVE do campo em `campo`. Para responder a pergunta pendente, `campo` = a chave pendente. ' +
  'Para corrigir, `campo` = a chave do dado corrigido. Se não respondeu nem corrigiu, ' +
  'use {"campo": "", "respondeu": false, "valor": ""}. ' +
  'Regras do `valor`: sim/não → "true"/"false"; número → só os dígitos (sem "km", "ano", "R$"); ' +
  'data → "AAAA-MM-DD"; escolha → exatamente uma das opções; texto livre → o trecho sucinto. ' +
  'NÃO invente, NÃO complete e NÃO responda por conta própria.';

/** Monta a mensagem do modelo. Puro — coberto por teste. */
export function montarMensagemDoValidador(
  pergunta: PerguntaDoFluxo | null,
  preenchidos: readonly { key: string; label: string; valor: string }[],
  mensagens: readonly MensagemDoContexto[],
): string {
  const campos = (p: PerguntaDoFluxo): string => {
    const opcoes =
      p.type === 'select' && (p.options?.length ?? 0) > 0 ? ` (uma de: ${p.options!.join(', ')})` : '';
    return `${p.question?.trim() || p.label} (chave: ${p.key}, tipo: ${p.type}${opcoes})`;
  };
  const conversa = mensagens
    .slice(-6)
    .map((m) => `- ${m.de === 'cliente' ? 'CLIENTE' : 'LOJA'}: ${m.texto}`)
    .join('\n');
  return [
    INSTRUCAO,
    '',
    '## Pergunta pendente (a que foi feita por último)',
    pergunta === null ? '(nenhuma — o fluxo só pode estar corrigindo dado já preenchido)' : campos(pergunta),
    '',
    '## Dados já preenchidos (corrigíveis)',
    preenchidos.length === 0
      ? '(nenhum)'
      : preenchidos.map((p) => `- ${p.label} (chave: ${p.key}): ${p.valor}`).join('\n'),
    '',
    '## Últimas mensagens (a mais recente é a que importa)',
    conversa,
  ].join('\n');
}

/** Extrai o JSON do modelo (tolerante a prosa/cerca em volta). */
export function parseLeituraDoValidador(
  texto: string,
): { campo: string; respondeu: boolean; valor: string } | null {
  const m = /\{[\s\S]*\}/.exec(texto);
  if (m === null) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj.respondeu !== 'boolean') return null;
  const campo = typeof obj.campo === 'string' ? obj.campo.trim() : '';
  const valor = typeof obj.valor === 'string' ? obj.valor.trim() : '';
  return { campo, respondeu: obj.respondeu, valor };
}

/**
 * Valida a resposta contra a pergunta pendente e os campos corrigíveis. Chama o
 * modelo (ponto `flow_validate`); falha de qualquer natureza devolve
 * `indefinido` — quem chama decide o fallback.
 */
export async function validarRespostaDoFluxo(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string; jobId: string },
  args: {
    pergunta: PerguntaDoFluxo | null;
    /** Campos já preenchidos que ACEITAM correção (o cliente pode mudar). */
    preenchidos: readonly { key: string; label: string; valor: string }[];
    mensagens: readonly MensagemDoContexto[];
  },
  deps: { registry?: ProviderRegistry; log: Logger },
): Promise<LeituraDaResposta> {
  // Sem pergunta pendente e sem corrigível, não há o que validar.
  if (args.pergunta === null && args.preenchidos.length === 0) {
    return { resultado: 'nao_respondeu' };
  }
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
        messages: [
          {
            role: 'user',
            content: montarMensagemDoValidador(args.pergunta, args.preenchidos, args.mensagens),
          },
        ],
      },
      { registry: deps.registry, log: deps.log },
    );
    texto = call.result.text;
  } catch {
    return { resultado: 'indefinido' };
  }

  const leitura = parseLeituraDoValidador(texto);
  if (leitura === null) return { resultado: 'indefinido' };
  if (!leitura.respondeu || leitura.campo === '') return { resultado: 'nao_respondeu' };

  // O `campo` só é aceito se for a pendente OU um corrigível declarado.
  const alvo =
    args.pergunta !== null && leitura.campo === args.pergunta.key
      ? args.pergunta
      : args.preenchidos.find((p) => p.key === leitura.campo);
  if (alvo === undefined) return { resultado: 'nao_respondeu' };

  // O valor passa pela MESMA régua de tipo da captura determinística.
  const campo = {
    key: alvo.key,
    label: alvo.label,
    type: 'type' in alvo ? alvo.type : ('text' as const),
    ...('options' in alvo && alvo.options !== undefined ? { options: alvo.options } : {}),
    ...('question' in alvo && alvo.question !== undefined ? { question: alvo.question } : {}),
  };
  if (!valorBateComTipo(campo, leitura.valor)) return { resultado: 'nao_respondeu' };
  return { resultado: 'respondeu', valor: leitura.valor, campo: alvo.key };
}
