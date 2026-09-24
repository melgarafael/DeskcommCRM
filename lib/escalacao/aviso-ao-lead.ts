/**
 * A FRASE QUE O CLIENTE LÊ QUANDO A IA SAI DE CAMPO.
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * O sistema tem duas passagens para humano, escritas por times diferentes e em
 * mundos diferentes — `performHumanHandoff` (motor, `pg`) e `triggerHandoff`
 * (CRM, `supabase-js`). As duas fazem a mesma coisa bem: silenciam o automático,
 * devolvem a conversa à fila e abrem o aviso na Central. E as duas fazem a mesma
 * coisa errada: **não dizem nada a quem está do outro lado**.
 *
 * Medido em produção em 2026-08-26, duas conversas reais na mesma hora:
 *
 *   - conversa `b934ba2d` — o cliente disse que não conseguia acessar um curso; o
 *     agente respondeu e PERGUNTOU o e-mail dele. Entre a pergunta e a resposta,
 *     o worker de sentimento disparou `triggerHandoff('low_sentiment')`. O cliente
 *     mandou o e-mail às 14:51:2x e o turno foi pulado ("lead em handoff humano").
 *     Ele respondeu uma pergunta da própria IA para o vazio.
 *   - conversa `cdd9cbd8` — o cliente escreveu "preciso de falar com atendente".
 *     A detecção determinística casou, `performHumanHandoff` rodou e o turno deu
 *     `return` com o comentário "bot silencia: sem modelo, sem envio neste turno".
 *     Silêncio absoluto.
 *
 * Do lado de fora as duas são a mesma coisa: a pessoa falou e ninguém respondeu.
 * O invariante 4 da doutrina do Sistema Vivo — nenhuma demanda sem próximo passo —
 * vale para o SISTEMA e valia; o que faltava era ele valer para a PESSOA.
 *
 * ## Por que o texto mora aqui, e sozinho
 *
 * Porque são dois emissores e um texto. Deixar cada mundo escrever a própria
 * frase é como as sete leituras de "quem manda na conversa" divergiram
 * (`lib/inbox/comando-da-conversa.ts`): dois lugares, duas redações, e a segunda
 * envelhece calada. Aqui a função é PURA — comparar frase é barato, comparar
 * linha de banco é caro — e cada mundo só a chama.
 *
 * ## Por que o texto muda com o MOTIVO
 *
 * "Vou chamar um atendente" está certo para quem pediu atendente e está ERRADO
 * para quem pediu para parar de receber mensagem. O motivo já viaja até aqui
 * (`conversations.last_handoff_reason`), então a frase o respeita em vez de
 * escolher um genérico que serve mal aos dois.
 *
 * ## Por que o texto NÃO conta o estado da equipe
 *
 * A leitura de disponibilidade (`expectativaDeAtendimento`) continua existindo e
 * alimenta a INSTRUÇÃO ao modelo (`./disponibilidade.ts`), mas NÃO vai para a
 * fala do cliente: falar de "fila", "ninguém disponível" ou prazo ao cliente é
 * deselegante e revela a operação. A frase é sempre acolhedora — "vou passar seu
 * atendimento para o responsável; ele entra em contato logo menos por aqui
 * mesmo" — variando só a redação (gate anti-spinning). O parâmetro `quem` ainda
 * escolhe o CONJUNTO de redações, mas nenhuma delas revela o estado real.
 */

import { createHash } from "node:crypto";

import type { QuemPodeAssumir } from "./disponibilidade";

/**
 * Por que a IA está saindo de campo. É o mesmo vocabulário de
 * `conversations.last_handoff_reason` — `HandoffReason` do orquestrador do CRM e
 * o `reason` que o motor grava —, reduzido ao que MUDA A FRASE.
 *
 * `outro` não é preguiça: os motivos são vocabulário aberto (o atendente escreve
 * texto livre ao escalar um caso), e um mapa exaustivo obrigaria este arquivo a
 * conhecer cada motivo novo para não quebrar. O default é a frase honesta e
 * genérica — nunca o silêncio.
 */
export type MotivoDoAviso =
  /** O cliente pediu uma pessoa, com todas as letras. */
  | "pediu_humano"
  /** Suspeita de que o cliente pediu para parar de receber mensagens. */
  | "suspeita_de_opt_out"
  /** O teto de gasto com IA parou o atendimento automático. */
  | "orcamento_de_ia"
  /** O sistema decidiu escalar (sentimento, baixa confiança, etapa, termo jurídico…). */
  | "outro";

/**
 * Traduz o `last_handoff_reason` gravado no banco para o motivo que muda a frase.
 * Aceita `string` porque a coluna é vocabulário ABERTO — ver `MotivoDoAviso`.
 */
export function motivoDoAviso(reason: string): MotivoDoAviso {
  if (reason === "requested_human") return "pediu_humano";
  if (reason === "suspected_optout") return "suspeita_de_opt_out";
  if (reason === "orcamento_de_ia") return "orcamento_de_ia";
  return "outro";
}

/**
 * ═══ POR QUE HÁ VARIANTES, E POR QUE ELAS SÃO SORTEADAS PELO LEAD ═══
 *
 * Porque um texto FIXO se veta sozinho. O `spinningGate` da cadeia de envio
 * (`lib/agent-engine/spinning/engine.ts`) conta quantas das últimas 20 mensagens
 * DAQUELE NÚMERO são idênticas ou quase (Jaccard ≥ 0,8) à candidata, e veta a
 * partir da terceira (`SPINNING_DEFAULTS.repetitionThreshold = 2`). A janela é
 * por `(organization_id, channel_session_id)` — ou seja, CRUZA leads. Numa
 * central com movimento, o terceiro cliente a pedir um atendente receberia
 * exatamente o silêncio que este arquivo existe para acabar, e pelo guardrail
 * que existe para proteger o número.
 *
 * A saída é a mesma que a re-entrada determinística já usa
 * (`pickReentryVariant`): variante escolhida por hash do lead. Mesmo lead ⇒
 * sempre a mesma frase (nada de o cliente ver a redação mudar entre tentativas
 * do mesmo job); leads diferentes ⇒ frases diferentes. Sem estado, sem relógio.
 *
 * As variantes NÃO são a mesma frase com sinônimos: um "spin" superficial não
 * baixa o Jaccard, e o gate o pega igual. `tests/unit/aviso-ao-lead.test.ts`
 * mede a similaridade entre TODOS os pares com a função REAL do gate — é ela
 * que diz se as variantes são de verdade, não a nossa impressão ao lê-las.
 */

/** Aberturas por motivo. O índice sai do hash do lead — ver o bloco acima. */
const ABERTURAS: Record<MotivoDoAviso, readonly string[]> = {
  // Quem pediu para parar não quer ouvir sobre atendente. Confirma o que ele
  // pediu, diz que uma pessoa vai conferir, e para. Responder ao pedido de
  // parada é padrão de mensageria (a confirmação de opt-out), não insistência.
  suspeita_de_opt_out: [
    "Entendi. Vou parar de te enviar mensagens automáticas por aqui.",
    "Certo, anotado: não mando mais nada automático para este número.",
    "Ok! Encerro os envios automáticos deste canal agora mesmo.",
  ],
  pediu_humano: [
    "Claro! Vou passar seu atendimento para o responsável.",
    "Sem problema — já vou passar seu atendimento para o responsável.",
    "Perfeito. Vou passar seu atendimento para o responsável agora.",
  ],
  orcamento_de_ia: [
    "Vou passar seu atendimento para o responsável.",
    "A partir daqui quem continua com você é o responsável.",
    "Estou passando seu atendimento para o responsável.",
  ],
  outro: [
    "Esse caso é melhor resolvido pelo responsável, e já vou passar seu atendimento.",
    "Vou passar seu atendimento para o responsável, que cuida disso com você.",
    "Deixa comigo: vou passar seu atendimento para o responsável.",
  ],
};

/**
 * Fechos por estado da equipe. Mesmo sorteio, mesma razão.
 *
 * REGRA (decisão do dono): o cliente NUNCA ouve falar de fila, indisponibilidade
 * ou prazo — a frase é sempre acolhedora: o responsável entra em contato por aqui
 * mesmo. Os três estados seguem variando SÓ a redação (o gate anti-spinning
 * cruza leads); nenhum deles revela o estado real do time.
 */
const FECHOS = {
  sem_equipe: [
    "Ele vai entrar em contato logo menos por aqui mesmo.",
    "O responsável te chama por aqui mesmo daqui a pouco.",
    "Fique tranquilo que o responsável entra em contato por aqui mesmo.",
  ],
  fora_de_expediente: [
    "Ele vai entrar em contato por aqui mesmo, logo menos.",
    "O responsável te responde por aqui mesmo em breve.",
    "Pode ficar tranquilo: o responsável entra em contato por aqui mesmo.",
  ],
  com_equipe: [
    "Ele entra em contato por aqui mesmo, logo menos.",
    "O responsável fala com você por aqui mesmo daqui a pouco.",
    "Fique de olho aqui no WhatsApp, que o responsável te chama.",
  ],
} as const;

/**
 * Variante DETERMINÍSTICA por lead: sha256(lead_id) → uint32 → módulo.
 *
 * É a MESMA regra de `pickReentryVariant` (`lib/agent-engine/agent/reentry-template.ts`),
 * reescrita aqui em vez de importada porque aquela vive no motor (`agent-engine`)
 * e este módulo é dos DOIS mundos — o do CRM não pode importar do motor sem
 * arrastar `pg` para dentro de uma rota Next.
 */
function variante<T>(leadId: string, opcoes: readonly T[]): T {
  const digest = createHash("sha256").update(leadId).digest();
  return opcoes[digest.readUInt32BE(0) % opcoes.length]!;
}

/**
 * O que o cliente lê. Uma frase, sem jargão, sem prometer o que não se cumpre.
 *
 * `quem` é `null` quando a leitura de disponibilidade falhou — e aí a frase é a
 * conservadora, pelo mesmo motivo de `expectativaDeAtendimento`: errar para o
 * lado de prometer menos é recuperável; prometer o que não se cumpre, não.
 *
 * `leadId` entra SÓ como semente do sorteio — nada dele aparece no texto. O nome
 * do contato também não: o aviso sai por um caminho determinístico, sem modelo, e
 * uma saudação montada em código ("Oi, {nome}!") em cima de uma conversa já em
 * andamento soa a robô — que é exatamente o que ele é, mas não precisa parecer
 * duas vezes.
 */
export function textoDoAviso(
  motivo: MotivoDoAviso,
  quem: QuemPodeAssumir | null,
  leadId: string,
): string {
  const abertura = variante(leadId, ABERTURAS[motivo]);

  if (motivo === "suspeita_de_opt_out") {
    // Sem fecho de expediente: quem pediu para parar não está esperando
    // atendimento, então "aguarde um instante" seria a resposta errada à
    // pergunta que ele fez.
    return `${abertura} Encaminhei seu pedido para uma pessoa da equipe confirmar.`;
  }

  const fecho =
    quem === null || quem.total === 0
      ? variante(leadId, FECHOS.sem_equipe)
      : quem.disponiveis === 0
        ? variante(leadId, FECHOS.fora_de_expediente)
        : variante(leadId, FECHOS.com_equipe);

  return `${abertura} ${fecho}`;
}
