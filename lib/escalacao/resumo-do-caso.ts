/**
 * O RESUMO DO CASO — escrito a partir da CONVERSA, não da última fala da IA.
 *
 * ## O defeito que este módulo existe para consertar (issue #3725)
 *
 * Quando o fail-safe do `case_promise_without_case` abria o caso, o `summary`
 * gravado era `body` — a mensagem que o MODELO acabou de tentar enviar. Para
 * quem abre a Central, o caso aparecia com uma frase solta da IA ("Sem
 * problema! Nossa equipe te responde outro dia.") e sem o que o cliente havia
 * dito. O resumo não resumia: repetia a última fala de um dos lados.
 *
 * ## O que ele é
 *
 * Um extrato DETERMINÍSTICO das últimas mensagens da conversa, alternando os
 * papéis, com o motivo do caso no fim. Sem modelo: o fail-safe roda no caminho
 * de erro do turno, e pagar uma chamada de LLM para escrever o resumo de um
 * caso que o próprio sistema abriu seria trocar um defeito por outro (o resumo
 * poderia vir vazio exatamente quando o modelo está falhando).
 *
 * Determinístico também significa testável: o formato é o contrato.
 *
 * ## As decisões
 *
 * **Janela curta (6 por padrão).** O atendente precisa do FIO da conversa, não
 * do histórico inteiro; e `agent_cases.summary` é texto de tela, não arquivo.
 *
 * **Cada fala truncada.** Uma mensagem de 2 KB do cliente não pode empurrar o
 * resto do resumo para fora da tela nem para fora do teto da coluna.
 *
 * **Papel explícito em cada linha.** "Cliente:" / "Atendimento:" — sem rótulo,
 * seis linhas de fala alternada são indistinguíveis para quem lê.
 *
 * **O motivo entra no fim.** É o que a IA não sabe dizer: por que o caso
 * existe (a promessa sem caso, a intervenção do guardrail).
 *
 * **Vazio é vazio.** Sem mensagens e sem motivo, devolve string vazia — quem
 * chama decide o fallback. Inventar "Conversa sem histórico" faria o campo
 * parecer preenchido na tela.
 */

/** O que o resumo precisa de cada mensagem — estrutural, sem arrastar o tipo do contexto. */
export interface MensagemParaResumo {
  direction: string;
  body: string;
}

/** Quantas mensagens entram por padrão. Curto de propósito (ver o cabeçalho). */
export const MENSAGENS_NO_RESUMO = 6;

/** Teto de cada fala, em caracteres. */
export const TETO_DA_FALA_NO_RESUMO = 160;

/** Rótulo do lado na conversa. `direction` é `inbound` (cliente) / `outbound` (nós). */
function rotulo(direction: string): string {
  return direction === "inbound" ? "Cliente" : "Atendimento";
}

/**
 * Uma fala pronta para o resumo: rótulo, corpo sem quebras de linha, cortado no
 * teto. Fala vazia (ou só espaço) vira `null` e simplesmente não aparece —
 * linha em branco no meio do extrato parece dado faltando.
 */
function linha(mensagem: MensagemParaResumo): string | null {
  const texto = mensagem.body.replace(/\s+/g, " ").trim();
  if (texto === "") return null;
  const cortado =
    texto.length > TETO_DA_FALA_NO_RESUMO
      ? `${texto.slice(0, TETO_DA_FALA_NO_RESUMO - 1).trimEnd()}…`
      : texto;
  return `${rotulo(mensagem.direction)}: ${cortado}`;
}

/**
 * Monta o resumo do caso. `mensagens` na ORDEM da conversa (mais antiga
 * primeiro); só as últimas `limite` entram. `motivo` é a razão do caso escrita
 * pelo sistema — vai no fim, e é opcional porque há chamador que só quer o
 * extrato.
 */
export function montarResumoDoCaso(
  mensagens: readonly MensagemParaResumo[],
  motivo: string | null = null,
  limite: number = MENSAGENS_NO_RESUMO,
): string {
  const janela = mensagens.slice(-Math.max(1, limite));
  const falas = janela.map(linha).filter((l): l is string => l !== null);
  const razao = (motivo ?? "").replace(/\s+/g, " ").trim();
  if (falas.length === 0) return razao;
  return razao === "" ? falas.join("\n") : `${falas.join("\n")}\n\nMotivo: ${razao}`;
}
