/**
 * O MOTIVO DA PAUSA DA PROSPECÇÃO EM PORTUGUÊS DE GENTE (#4170).
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 * Quando o pré-go-live recusa a abordagem, `worker.ts` gravava em
 * `prospecting_campaigns.error` a frase `O canal ainda não permite esta
 * abordagem: fora_da_lista_de_teste.` — e o cartão da campanha mostrava esse
 * texto ao operador. Todo canal nasce em **modo de teste com a lista vazia**
 * (`lib/ai/elegibilidade/aviso-do-modo-de-teste.ts`), então o primeiro contato
 * de uma instalação nova pausa a campanha com um CÓDIGO interno na tela: não
 * diz que o número está em modo de teste, nem que a IA só fala com a lista de
 * teste, nem onde liberar.
 *
 * ─── Por que um mapa, e não um `if` no ponto da pausa ──────────────────────
 *
 * A recusa do canal devolve um vocabulário (`AiGateMotivo`, `./gate.ts`) que
 * existe para a constraint e para o código — não para alguém ler. Traduzir no
 * `throw` com um `if/else` espalharia a régua por qualquer ponto novo que
 * pause a campanha; aqui os motivos ficam numa tabela só, e o texto de um
 * motivo novo entra numa linha. O ponto que pausa chama SEMPRE a mesma função.
 *
 * ─── O que NÃO se faz com motivo desconhecido ──────────────────────────────
 *
 * `fora_da_lista_de_teste` tem frase própria porque o caminho de liberação é
 * CONHECIDO (Conexões → cartão do número → "Configurar acesso da IA" →
 * "Liberar atendimento ao público", `components/connections/ChannelAiAccess.tsx`).
 * Para qualquer outro motivo — um veto de contato, uma autorização expirada,
 * um motivo que ainda não existe — o fallback devolve a frase antiga COM o
 * código cru. Inventar uma explicação para um motivo que ninguém mediu é pior
 * do que mostrar o código: manda a pessoa mexer no que não está quebrado.
 *
 * ─── Por que o texto aqui é português e a tradução fica na tela ────────────
 *
 * A frase é gravada no banco (`prospecting_campaigns.error`) e é o texto que o
 * cartão da campanha mostra; o cartão passa o valor por `t()` e o dicionário
 * (`lib/i18n/dicionario.ts`) devolve o espanhol. A chave do dicionário é esta
 * mesma frase em português — o mesmo texto que fica no histórico de quem usa
 * a instalação em português.
 */

/**
 * Motivo do gate → frase que o operador lê.
 *
 * A chave é o `motivo` CRU devolvido pelo preflight (`AiGateMotivo`); a frase
 * é a chave do dicionário (`lib/i18n/dicionario.ts`). Só entra aqui o motivo
 * cujo CAMINHO de liberação é medido — os demais caem no fallback.
 */
export const MOTIVO_DA_PAUSA_EM_TEXTO: Readonly<Record<string, string>> = {
  fora_da_lista_de_teste:
    "Este número está em modo de teste: a IA só fala com os números da lista de teste. " +
    'Para liberar o atendimento ao público, abra Conexões, toque em "Configurar acesso da IA" ' +
    'no cartão do número e escolha "Liberar atendimento ao público".',
};

/**
 * A mensagem da pausa da Prospecção para um motivo do preflight.
 *
 * Motivo conhecido: a frase humana (sem o código). Desconhecido: a frase
 * antiga com o motivo cru — o comportamento de antes, nunca uma invenção.
 */
export function mensagemDaRecusaDoCanal(motivo: string): string {
  return (
    MOTIVO_DA_PAUSA_EM_TEXTO[motivo] ?? `O canal ainda não permite esta abordagem: ${motivo}.`
  );
}
