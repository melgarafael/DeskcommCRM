/**
 * A DECLARAÇÃO DO TURNO — a fronteira entre FALAR e OPERAR (spec 16 §5).
 *
 * O Conversador termina o turno declarando, em linguagem de NEGÓCIO, o que
 * aconteceu: o que a pessoa quer, e o que foi prometido a ela. Quem traduz isso
 * em operação é outra camada — nunca ele. É por isso que a declaração não tem
 * nome de ferramenta, id de nada, nem estágio de funil: se tivesse, o vocabulário
 * já estaria no contexto de quem fala, que é exatamente o defeito medido
 * (30% de vazamento com prompt de operador — ver RELATORIO da medição).
 *
 * ═══ POR QUE ELA VIAJA NO FECHAMENTO, e não numa tool ═══
 *
 * O mesmo motivo que o próprio `inbound-turn.ts` já dá para o checkpoint:
 *
 *   > "tool `update_checkpoint` dependeria de o modelo lembrar de chamá-la; a
 *   >  chamada de fechamento sempre acontece"
 *
 * Uma tool `declarar_intencao` seria esquecida no turno em que mais importa, e um
 * turno sem declaração é um lead parado em silêncio. Pendurar a declaração na
 * chamada de fechamento a torna **imposta pelo runtime** — e de graça: é a mesma
 * chamada de modelo que já roda hoje, sem custo adicional.
 *
 * ═══ AUSENTE ≠ VAZIA (a distinção que justifica o campo) ═══
 *
 * `declaracao: undefined`  → o modelo NÃO declarou. Não sabemos se avaliou.
 * `{ nada_a_declarar: true }` → o modelo avaliou e não havia nada.
 *
 * São estados diferentes e a diferença é operacional: o primeiro é um turno a
 * investigar (o fechamento veio incompleto), o segundo é uma decisão registrada.
 * Colapsá-los num default otimista faria "o modelo esqueceu" parecer "não havia
 * nada" — e o esquecimento sumiria da vista justamente onde o sistema vivo exige
 * que apareça (invariante 4: nada morre sem próximo passo).
 *
 * Por isso o campo é OPCIONAL no Zod e a coluna é NULLABLE: o "não sei" tem
 * representação própria, em vez de pegar carona no valor vazio.
 */
import { z } from 'zod';

import { falaDoMotor, type Idioma } from './idioma-do-turno';

/**
 * Uma intenção lida da conversa. `evidencia` não é burocracia: sem ela o campo
 * aceita invenção, e a mesma disciplina já vale para `update_lead_state`
 * ("nunca invente avanço sem evidência na conversa").
 */
export const intencaoSchema = z.object({
  o_que: z.string().min(1).describe('em linguagem de negócio: "quer remarcar", "desistiu por preço"'),
  evidencia: z.string().min(1).describe('o trecho da conversa que sustenta'),
});

/**
 * Uma promessa feita ao lead. É o campo com consequência: promessa declarada é
 * OBRIGAÇÃO — alguém tem de quitá-la ou registrar por que não deu. Promessa sem
 * quitação e sem registro é o defeito que a spec 16 existe para matar.
 *
 * `prazo` é nullable de propósito: "te retorno assim que souber" é promessa real
 * sem data, e forçar uma data faria o modelo inventar uma.
 */
export const promessaSchema = z.object({
  o_que: z.string().min(1).describe('o que foi prometido, como o lead entendeu'),
  prazo: z.string().nullable().default(null).describe('data/hora ISO 8601 quando houver, senão null'),
});

/**
 * O contrato. `.strict()` de propósito — campo extra aqui é sinal de que o modelo
 * inventou estrutura, e o padrão desta base é que isso vire ERRO DE ENSINO, nunca
 * strip silencioso (mesma escolha de `applyLeadStateUpdate`).
 */
export const declaracaoDoTurnoSchema = z
  .object({
    intencoes: z.array(intencaoSchema).default([]),
    promessas: z.array(promessaSchema).default([]),
    nada_a_declarar: z
      .boolean()
      .default(false)
      .describe('true = avaliei o turno e não havia intenção nem promessa'),
  })
  .strict();

export type Intencao = z.infer<typeof intencaoSchema>;
export type Promessa = z.infer<typeof promessaSchema>;
export type DeclaracaoDoTurno = z.infer<typeof declaracaoDoTurnoSchema>;

/**
 * O pedaço da instrução de fechamento que cobre a declaração.
 *
 * Vive aqui, e não colado dentro de `CHECKPOINT_INSTRUCTION`, porque o texto e o
 * schema que o valida têm de mudar JUNTOS — separá-los em dois arquivos é como
 * uma instrução passa a pedir um formato que o parser não aceita mais.
 *
 * Note o que este texto NÃO diz: não menciona ferramenta, CRM, funil, etapa ou
 * qualquer coisa que o Conversador não deva saber que existe. Ele descreve o que
 * a PESSOA quer e o que foi prometido a ela — vocabulário de quem atende.
 */
export const DECLARACAO_INSTRUCTION =
  'Inclua também o campo "declaracao", com o que você entendeu deste turno: ' +
  '{"intencoes": [{"o_que": "…", "evidencia": "…"}], "promessas": [{"o_que": "…", "prazo": "…"|null}], ' +
  '"nada_a_declarar": false}. ' +
  'Em "intencoes", o que a pessoa quer, em linguagem simples ("quer remarcar", "desistiu por causa do preço"), ' +
  'com o trecho da conversa que mostra isso. Em "promessas", tudo que você prometeu a ela — ' +
  'inclusive "vou verificar e te aviso" — com o prazo quando houver combinado um. ' +
  'Se o turno não teve nem intenção nem promessa, mande "nada_a_declarar": true e as duas listas vazias. ' +
  'Nunca invente: sem trecho que sustente, não declare.';

/**
 * A mesma instrução no idioma da organização (#4260, item 1).
 *
 * As CHAVES do JSON não mudam de língua: `intencoes`, `promessas` e
 * `nada_a_declarar` são lidas por `declaracaoDoTurnoSchema` — traduzir a chave
 * mudaria o contrato, não o idioma. `pt-BR` devolve a constante acima.
 */
export function instrucaoDeDeclaracao(idioma: Idioma = 'pt-BR'): string {
  return falaDoMotor(DECLARACAO_INSTRUCTION, idioma);
}

/**
 * A declaração vista por um HUMANO que vai assumir a conversa.
 *
 * Existe porque o contrato tem **dois leitores** (invariante 2 do sistema vivo):
 * a camada que opera, e a pessoa que recebe o handoff. Um artefato, duas leituras
 * — e é o que separa "entregar a conversa crua" de "entregar contexto".
 *
 * Devolve string vazia quando não há nada a dizer, para o chamador decidir se
 * omite a seção. Um bloco com cabeçalho e nada embaixo é ruído na tela de quem
 * está no meio de um atendimento.
 */
export function renderDeclaracaoParaHumano(declaracao: DeclaracaoDoTurno | null): string {
  if (declaracao === null) return '';
  const linhas: string[] = [];
  if (declaracao.intencoes.length > 0) {
    linhas.push(`O que a pessoa quer: ${declaracao.intencoes.map((i) => i.o_que).join('; ')}`);
  }
  if (declaracao.promessas.length > 0) {
    // O prazo entra colado na promessa, não numa lista à parte: quem assume
    // precisa ver "o quê" e "até quando" na mesma linha para agir.
    linhas.push(
      `Prometido a ela: ${declaracao.promessas
        .map((p) => (p.prazo === null ? p.o_que : `${p.o_que} (até ${p.prazo})`))
        .join('; ')}`,
    );
  }
  return linhas.join('\n');
}

/**
 * As promessas ainda EM ABERTO — a lista que alguém tem de quitar.
 *
 * Hoje devolve todas as declaradas no turno. Quando o Operador existir (spec 16,
 * passo 4) é aqui que entra o cruzamento com o que já foi quitado; deixar a função
 * como o ponto único desse cálculo evita que a regra nasça espalhada por dois
 * chamadores e divirja.
 */
export function promessasEmAberto(declaracao: DeclaracaoDoTurno | null): Promessa[] {
  return declaracao === null ? [] : declaracao.promessas;
}
