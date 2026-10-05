/**
 * Recorte 1 do #636 — o checkpoint do turno, fora do arquivo do turno.
 *
 * Saiu de `inbound-turn.ts` byte a byte (a única linha nova é o `export` de
 * `insertCheckpoint`, que era privado lá): mesmas strings, mesmo Zod, mesma
 * instrução de fechamento — portanto mesmo comportamento.
 *
 * O que mora aqui é o DADO do checkpoint: o schema que o Zod valida na chamada
 * de fechamento, a ROW do `lead_checkpoints`, a instrução fixa (com o
 * `rolling_summary` que ela pede), a gravação e o parse. O fechamento EM SI — a
 * chamada de modelo, o veto e a emissão da atividade — continua em
 * `inbound-turn.ts`: este recorte não toca no laço.
 *
 * `inbound-turn.ts` reexporta estes símbolos, e é por lá que os testes e os
 * irmãos (follow-up, resposta de caso, retomada) continuam os buscando.
 */

import { z } from "zod";

import {
  currentExecutionBoundary,
  guardServiceEffect,
} from "@/lib/atendimento/fronteira-server";
import { extrairJsonDoTexto } from "@/lib/agent-engine/texto/extrair-json-do-texto";

import type { Queryable } from "../../queue/queue";
import {
  DECLARACAO_INSTRUCTION,
  declaracaoDoTurnoSchema,
  intencaoSchema,
  promessaSchema,
  type DeclaracaoDoTurno,
} from "../declaracao";

/** Conteúdo do checkpoint — o modelo devolve, o Zod valida, o Postgres guarda. */
export const checkpointContentSchema = z.object({
  commitments: z.array(z.string()).default([]),
  objections: z.array(z.string()).default([]),
  next_action: z.string().nullable().default(null),
  rolling_summary: z.string().default(''),
  /**
   * A declaração do turno (spec 16 §5) — a fronteira entre FALAR e OPERAR.
   *
   * `.optional()` SEM default, e a diferença importa: `undefined` significa que o
   * modelo não declarou nada (fechamento incompleto — turno a investigar), e é
   * estado distinto de `{nada_a_declarar: true}`, que é uma avaliação registrada.
   * Um `.default({})` aqui apagaria essa distinção e faria "o modelo esqueceu"
   * parecer "não havia nada" — ver o cabeçalho de `declaracao.ts`.
   *
   * Opcional também é o que mantém a retrocompatibilidade: checkpoint gravado
   * antes desta versão, e clone self-host cujo modelo ainda não conhece o campo,
   * seguem validando.
   */
  declaracao: declaracaoDoTurnoSchema.optional(),
});
export type CheckpointContent = z.infer<typeof checkpointContentSchema>;

/**
 * A ROW como o Postgres a devolve. `declaracao` é `Omit`-ada e redeclarada porque
 * o "não sei" tem representação DIFERENTE nas duas pontas: o modelo omite o campo
 * (`undefined`), o banco guarda `null`. Herdar o `?:` do schema faria o tipo
 * prometer `undefined` onde `select *` entrega `null` — e o `=== undefined` de
 * quem lesse a row seria falso justamente no caso que ele quer pegar.
 */
export interface LeadCheckpointRow extends Omit<CheckpointContent, 'declaracao'> {
  id: string;
  seq: string;
  organization_id: string;
  contact_id: string;
  job_id: string | null;
  created_at: Date;
  declaracao: DeclaracaoDoTurno | null;
}

/**
 * Instrução FIXA do fechamento — o runtime a impõe; o teste a usa como marcador.
 *
 * A declaração (spec 16 §5) viaja AQUI, na chamada que já acontece, e não numa
 * tool: uma `declarar_intencao` dependeria de o modelo lembrar de chamá-la, e o
 * turno em que ele esquecesse seria um lead parado em silêncio. É o mesmo
 * argumento que este arquivo já usa para o checkpoint — e sai de graça, porque
 * é a mesma chamada de modelo.
 */
export const CHECKPOINT_INSTRUCTION =
  'Feche o turno AGORA. Responda SOMENTE com um JSON válido no formato ' +
  '{"commitments": string[], "objections": string[], "next_action": string|null, "rolling_summary": string} ' +
  '— compromissos assumidos, objeções do lead, próxima ação e o resumo acumulado ' +
  'da conversa até aqui (inclua o que o resumo anterior já dizia). ' +
  // ⚠️ O REFERENCIAL DE `next_action`, e ele não é zelo de redação.
  //
  // Este JSON é escrito no FECHO do turno: a pergunta já saiu, a resposta ainda
  // não chegou. Sem dizer QUANDO, "próxima ação" é ambígua entre "o que acabei
  // de fazer" e "o que farei depois" — e o modelo gravava a primeira. No turno
  // seguinte o texto volta como o PRIMEIRO bloco do prompt, acima do histórico,
  // e manda repetir a pergunta que o histórico logo abaixo já responde. Medido
  // numa conversa real: o agente pediu o e-mail QUATRO vezes, com o cliente
  // respondendo três. (issue #510)
  //
  // A negação explícita está aqui porque dizer o que É não basta quando o erro
  // tem um atrator forte: a pergunta recém-feita é o texto mais fresco no
  // contexto do modelo.
  'Em `next_action`, escreva a ação que vem DEPOIS da resposta que você está ' +
  'esperando — nunca a pergunta que você acabou de fazer. Se o turno terminou ' +
  'perguntando, a próxima ação é o que fazer COM a resposta quando ela chegar. ' +
  DECLARACAO_INSTRUCTION +
  ' Sem texto fora do JSON.';

export async function insertCheckpoint(
  db: Queryable,
  input: { tenantId: string; leadId: string; jobId: string; content: CheckpointContent },
): Promise<void> {
  await guardServiceEffect();
  const boundary = currentExecutionBoundary();
  await db.query(
    `insert into lead_checkpoints (organization_id, contact_id, job_id, commitments, objections, next_action, rolling_summary, declaracao, conversation_id, service_revision, demanda_id, demanda_revision)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.tenantId,
      input.leadId,
      input.jobId,
      JSON.stringify(input.content.commitments),
      JSON.stringify(input.content.objections),
      input.content.next_action,
      input.content.rolling_summary,
      // NULL (não `'{}'`) quando o modelo não declarou: a coluna preserva a
      // distinção "não declarou" × "declarou que não havia nada" que o schema
      // sustenta em memória. Gravar um objeto vazio aqui jogaria fora, no
      // Postgres, a informação que o Zod tomou o cuidado de manter.
      input.content.declaracao === undefined ? null : JSON.stringify(input.content.declaracao),
      boundary?.conversation_id ?? null,
      boundary?.service_revision ?? null,
      boundary?.demanda_id ?? null,
      boundary?.demanda_revision ?? null,
    ],
  );
}

/**
 * O fechamento veio fora do contrato. `problemas` diz O QUE falhou — caminho e
 * código de cada problema do Zod, ou a ausência de JSON —, nunca o texto do
 * modelo, que pode carregar PII da conversa: é o que vai para o log.
 * `paraOModelo` acrescenta os nomes dos campos que não existem e só volta ao
 * próprio modelo, na correção (`fecharOTurno`).
 */
export class FechamentoRecusado extends Error {
  constructor(
    message: string,
    readonly problemas: string,
    readonly paraOModelo: string = problemas,
  ) {
    super(message);
    this.name = 'FechamentoRecusado';
  }
}

/**
 * Extrai e valida o JSON do fechamento. Tolerante a cerca de código, prosa em
 * volta e repetição (`extrairJsonDoTexto`); inválido → erro SEM o texto do
 * modelo na mensagem (pode carregar PII da conversa) — o job re-tenta.
 */
export function parseCheckpointText(text: string): CheckpointContent {
  const bruto = extrairJsonDoTexto(text);
  if (bruto === null) {
    throw new FechamentoRecusado(
      'fechamento do turno sem JSON de checkpoint — run re-tentado pela fila',
      'a resposta não tinha um objeto JSON válido',
    );
  }
  const parsed = checkpointContentSchema.safeParse(bruto);
  if (!parsed.success) {
    const onde = (i: (typeof parsed.error.issues)[number]) => `${i.path.join('.') || '(raiz)'}: ${i.code}`;
    const issues = parsed.error.issues.map(onde).join('; ');
    const paraOModelo = parsed.error.issues
      .map((i) =>
        i.code === 'unrecognized_keys' ? `${onde(i)} (campos que não existem: ${i.keys.join(', ')})` : onde(i),
      )
      .join('; ');
    throw new FechamentoRecusado(
      `checkpoint do fechamento com shape inválido (${issues}) — run re-tentado pela fila`,
      issues,
      paraOModelo,
    );
  }
  return parsed.data;
}

/**
 * A correção pedida ao modelo quando o fechamento volta fora do contrato. Diz o
 * problema — com os campos que não existem — e os nomes CERTOS; o `.strict()`
 * da declaração continua valendo: campo a mais é ERRO DE ENSINO, e ensinar é
 * dizer ao modelo o que ele errou, nunca apagar o campo em silêncio
 * (`../declaracao.ts`).
 *
 * ⚠️ Medido com GPT-5.6 Luna (29/09/2026, 20–30 fechamentos por variante,
 * conversa em espanhol): o erro é TRADUZIR os nomes — "intenciones" no lugar de
 * `intencoes`, "promesas" no lugar de `promessas` —, em 25–47% dos fechamentos.
 * - Correção genérica ("sem nenhum campo a mais"): corrigiu 1 de 5.
 * - Esta, que nomeia os campos errados e lista os certos: corrigiu 14 de 14.
 * - Uma frase na instrução do fechamento pedindo "nunca os traduza" PIOROU a
 *   primeira tentativa (9 de 20 contra 15 de 20 sem ela). Por isso o aviso vive
 *   só aqui, depois do erro, e não em `CHECKPOINT_INSTRUCTION`.
 *
 * Os nomes saem dos schemas, para o texto e o parser mudarem juntos.
 */
export function correcaoDoFechamento(problemas: string): string {
  const campos = (schema: { shape: object }) => Object.keys(schema.shape);
  const lista = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs.at(-1)}`);
  const declaracao = campos(declaracaoDoTurnoSchema);
  const itens: Record<string, string[]> = {
    intencoes: campos(intencaoSchema),
    promessas: campos(promessaSchema),
  };
  const dentro = declaracao
    .map((c) => (itens[c] ? `${c} (cada item com ${lista(itens[c])})` : c));
  return (
    `O JSON do fechamento foi recusado: ${problemas}. ` +
    'Os nomes dos campos são fixos e ficam em português, exatamente assim: ' +
    `${lista(campos(checkpointContentSchema))}; dentro de declaracao: ${lista(dentro)}. ` +
    'Responda de novo SOMENTE com o JSON, com estes nomes e nenhum outro. Sem texto fora do JSON.'
  );
}

/**
 * O fechamento do turno, com UMA correção antes de desistir.
 *
 * ⚠️ POR QUE EXISTE, medido em produção (27/09/2026): com um modelo barato no
 * ponto `checkpoint`, a declaração às vezes vinha com uma chave a mais
 * (`declaracao: unrecognized_keys`). O parse recusava, o job falhava e a fila
 * re-tentava o TURNO INTEIRO — a chamada principal do agente incluída, que é a
 * cara: 2 de 10 turnos com 3 tentativas, até 30¢ numa mensagem, para economizar
 * ~1¢ no fechamento. A resposta ao cliente já tinha saído; o que faltava era só
 * o JSON.
 *
 * Agora a recusa vira uma segunda chamada de FECHAMENTO (barata), com a resposta
 * recusada e o problema. Só se ela também vier fora do contrato o erro sobe como
 * antes, e a fila re-tenta o turno. Falha do fornecedor (rede, 5xx, teto) não é
 * recusa: sobe na hora, sem segunda chamada, como sempre subiu.
 */
export async function fecharOTurno<R extends { text: string; callId?: string | null }>(opcoes: {
  pedir: (extra: Array<{ role: 'assistant' | 'user'; content: string }>) => Promise<R>;
  /** Ajuste do texto antes do parse (hoje: tirar o link da reunião). */
  ajustar?: (text: string) => string;
  log?: { warn(msg: string, fields?: Record<string, unknown>): void };
}): Promise<{ content: CheckpointContent; resposta: R; corrigido: boolean }> {
  const ajustar = opcoes.ajustar ?? ((t: string) => t);
  const primeira = await opcoes.pedir([]);
  try {
    return { content: parseCheckpointText(ajustar(primeira.text)), resposta: primeira, corrigido: false };
  } catch (err) {
    if (!(err instanceof FechamentoRecusado)) throw err;
    opcoes.log?.warn('fechamento do turno recusado — pedindo uma correção antes de re-tentar o turno', {
      problemas: err.problemas,
    });
    const segunda = await opcoes.pedir([
      { role: 'assistant', content: primeira.text },
      { role: 'user', content: correcaoDoFechamento(err.paraOModelo) },
    ]);
    return { content: parseCheckpointText(ajustar(segunda.text)), resposta: segunda, corrigido: true };
  }
}
