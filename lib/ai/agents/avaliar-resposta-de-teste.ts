/**
 * O que o botão "Testar" consegue dizer sobre uma resposta — e o que ele NÃO
 * consegue.
 *
 * Esta checagem suplementar é pura e inspeciona apenas vocabulário interno no
 * texto. A rota de teste usa o motor de prévia, que executa verificações próprias
 * com contexto simulado e pode fazer chamadas ao modelo; consultar seu trace
 * separadamente. Nem um resultado textual limpo nem a prévia liberam envio real.
 */
import { detectarVazamentoInterno } from "@/lib/agent-engine/guardrails/vazamento-interno";

/** O que a checagem de texto encontrou na resposta de teste. */
export interface AvaliacaoDaRespostaDeTeste {
  /**
   * `true` quando HAVIA texto e ele passaria pelo gate de vocabulário interno.
   * Sem texto é `false` — ver `avaliado`.
   */
  passou: boolean;
  /**
   * `false` quando não havia resposta para avaliar (teste bloqueado, nenhum
   * candidato). Separa "não passou porque vazou termo" de "não havia o que ler".
   */
  avaliado: boolean;
  /**
   * Categorias de vazamento detectadas (rótulos nossos, nunca o trecho). O termo
   * em si é parte da resposta e pode conter dado do contato — vai para a tela de
   * quem configura, não para log.
   */
  categorias: string[];
  /** Os termos, para a tela mostrar a quem está configurando o agente. */
  termos: string[];
  /**
   * Os gates NÃO reavaliados por esta camada textual, não pelo motor de prévia.
   */
  naoAvaliados: ReadonlyArray<{ gate: string; porque: string }>;
}

/**
 * Gates que esta checagem textual não reavalia. O motor de prévia pode executar
 * alguns deles com dados simulados; isso não equivale a liberar envio real.
 */
const NAO_AVALIAVEIS_SEM_TURNO: ReadonlyArray<{ gate: string; porque: string }> = [
  { gate: "stop", porque: "depende de o contato ter pedido para sair — não há contato real no teste" },
  { gate: "lgpd", porque: "depende da base legal registrada para o contato" },
  { gate: "pacing", porque: "depende de quantas mensagens o número já enviou hoje e do horário do envio" },
  { gate: "messaging_window", porque: "depende de quando o contato falou com você pela última vez" },
  { gate: "spinning", porque: "depende das últimas mensagens enviadas por este número" },
  { gate: "promise", porque: "depende da tabela de preços e condições da organização" },
  { gate: "semantic_promise", porque: "esta checagem textual não chama modelo; a prévia do motor pode chamar um modelo adicional" },
  { gate: "case_promise", porque: "depende de haver um chamado aberto para este contato" },
  {
    gate: "agenda_stall",
    porque: "depende de a ferramenta de agenda ter sido chamada neste turno — não há turno real no teste",
  },
  { gate: "disclosure", porque: "depende de esta ser a primeira mensagem ao contato" },
  {
    gate: "clinical_claim",
    porque:
      "depende de a organização ter ligado \"Não fazer afirmação clínica\" em Segurança; quando ligada, a prévia do motor aplica",
  },
];

/**
 * Avalia o texto que o agente produziria. Puro: não toca em banco, não escreve
 * trace nem gasta modelo por si só. A rota de teste chama o motor de prévia,
 * que pode gravar dados e fazer chamadas ao modelo antes desta função.
 */
export function avaliarRespostaDeTeste(texto: string | undefined): AvaliacaoDaRespostaDeTeste {
  // Sem texto não há o que avaliar, e afirmar "passou" seria o mesmo erro de
  // silêncio-que-parece-aprovação que este módulo existe para corrigir.
  const corpo = texto ?? "";
  const avaliado = corpo.trim() !== "";
  const achado = detectarVazamentoInterno(corpo);
  return {
    passou: avaliado && !achado.achou,
    avaliado,
    categorias: [...achado.categorias],
    termos: [...achado.termos],
    naoAvaliados: NAO_AVALIAVEIS_SEM_TURNO,
  };
}
