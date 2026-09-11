/**
 * O que o botão "Testar" consegue dizer sobre uma resposta — e o que ele NÃO
 * consegue.
 *
 * ═══ O DEFEITO (medido em 2026-08-05) ═══
 *
 * `/api/v1/ai/agents/[id]/versions/[vid]/test` chama `runAgent` de
 * `lib/ai/runtime/agent.ts`, marcado `@deprecated`, que **não importa
 * `runBeforeSend`**. A cadeia inteira de guardrails vive no processo do worker e
 * está ausente do build do app Next — provado por três medições com controle
 * positivo (RELATORIO da medição de vazamento, seção "O gate estava ARMADO?").
 *
 * Consequência para o produto: o self-hoster testa na tela, vê uma resposta
 * limpa, publica, e produção se comporta diferente. É falha-em-verde no caminho
 * de primeira impressão — a categoria mais cara num produto que a pessoa instala
 * sozinha, porque ela não tem como descobrir que está quebrado.
 *
 * ═══ POR QUE ISTO AVALIA SÓ UMA PARTE, E DIZ QUAL ═══
 *
 * A cadeia tem 10 gates. Seis dependem de ESTADO que só existe no turno real:
 * contadores de pacing, janela de cópias do spinning, carimbo da última inbound,
 * ledger de envios, base legal do contato. Fabricar esse estado para o teste
 * produziria um veredito **inventado** — pior que veredito nenhum, porque teria
 * a aparência de prova.
 *
 * Então esta camada avalia o que é decidível **só com o texto**, e devolve a
 * lista explícita do que ficou de fora. A tela mostra as duas coisas. Um "não
 * avaliado" visível é informação; um silêncio que parece aprovação é o defeito
 * que estamos consertando.
 *
 * O gate coberto é justamente o que a medição elegeu como o mais caro: 30% dos
 * turnos com prompt de operador vazavam vocabulário interno para o cliente.
 */
import { detectarVazamentoInterno } from "@/lib/agent-engine/guardrails/vazamento-interno";

/** O que a checagem de texto encontrou na resposta de teste. */
export interface AvaliacaoDaRespostaDeTeste {
  /** `true` quando o texto passaria pelo gate de vocabulário interno. */
  passou: boolean;
  /**
   * Categorias de vazamento detectadas (rótulos nossos, nunca o trecho). O termo
   * em si é parte da resposta e pode conter dado do contato — vai para a tela de
   * quem configura, não para log.
   */
  categorias: string[];
  /** Os termos, para a tela mostrar a quem está configurando o agente. */
  termos: string[];
  /**
   * Os gates que NÃO foram avaliados aqui, com o motivo. Existe para a tela
   * poder dizer isso em voz alta: a diferença entre "passou em tudo" e "passou
   * no que dava para checar sem o turno real" é a diferença entre o defeito
   * antigo e o conserto.
   */
  naoAvaliados: ReadonlyArray<{ gate: string; porque: string }>;
}

/**
 * Gates que dependem de estado do turno real. A lista é DADO, não prosa, para a
 * tela renderizar sem reescrever o motivo — e para que acrescentar um gate à
 * cadeia force alguém a decidir de que lado ele cai.
 */
const NAO_AVALIAVEIS_SEM_TURNO: ReadonlyArray<{ gate: string; porque: string }> = [
  { gate: "stop", porque: "depende de o contato ter pedido para sair — não há contato real no teste" },
  { gate: "lgpd", porque: "depende da base legal registrada para o contato" },
  { gate: "pacing", porque: "depende de quantas mensagens o número já enviou hoje e do horário do envio" },
  { gate: "messaging_window", porque: "depende de quando o contato falou com você pela última vez" },
  { gate: "spinning", porque: "depende das últimas mensagens enviadas por este número" },
  { gate: "promise", porque: "depende da tabela de preços e condições da organização" },
  { gate: "semantic_promise", porque: "usa uma chamada de modelo extra, que o teste não gasta" },
  { gate: "case_promise", porque: "depende de haver um chamado aberto para este contato" },
  {
    gate: "agenda_stall",
    porque: "depende de a ferramenta de agenda ter sido chamada neste turno — não há turno real no teste",
  },
  {
    gate: "academia_grade_stall",
    porque: "depende de a grade ter sido consultada nesta conversa — não há turno real no teste",
  },
  { gate: "disclosure", porque: "depende de esta ser a primeira mensagem ao contato" },
];

/**
 * Avalia o texto que o agente produziria. Puro: não toca em banco, não escreve
 * trace, não gasta modelo — pode rodar dentro da rota do app, que é justamente
 * onde a cadeia real não existe.
 */
export function avaliarRespostaDeTeste(texto: string | undefined): AvaliacaoDaRespostaDeTeste {
  // Sem texto não há o que avaliar, e afirmar "passou" seria o mesmo erro de
  // silêncio-que-parece-aprovação que este módulo existe para corrigir.
  const corpo = texto ?? "";
  const achado = detectarVazamentoInterno(corpo);
  return {
    passou: !achado.achou,
    categorias: [...achado.categorias],
    termos: [...achado.termos],
    naoAvaliados: NAO_AVALIAVEIS_SEM_TURNO,
  };
}
