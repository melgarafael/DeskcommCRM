/**
 * O IDIOMA DO TURNO — a única porta por onde a prosa do motor muda de língua.
 *
 * ─── O defeito que este módulo existe para fechar (#4260, item 1) ───────────
 *
 * O motor do agente injeta, a cada turno, prosa FIXA em português: a persona
 * neutra, o bloco da consulta interna do caso, as regras residentes de
 * transparência/autoria/casos, o bloco da prévia, a instrução de fechamento, o
 * system do Operador e a descrição de `update_lead_state`. Nada disso passava
 * pelo dicionário de i18n, e o idioma da organização nem chegava ao motor. Com
 * o cliente escrevendo em espanhol, o modelo lia um prompt inteiro em português
 * e derivava para o português no meio da conversa — sem ninguém trocar de
 * idioma.
 *
 * ─── A regra, e por que ela mora num módulo só ─────────────────────────────
 *
 * Quem decide a língua é `organizations.locale` (`idiomaDoMotor`), e quem
 * TRADUZ é `traduzir` — o dicionário de `lib/i18n`, onde a chave é o próprio
 * texto em português e `pt-BR` devolve a chave intacta. Nenhum bloco pergunta
 * `locale === "es"`: os pontos de injeção chamam `falaDoMotor(textoPt, idioma)`
 * e o dicionário responde. Um `if` por idioma espalhado pelo motor é o
 * anti-padrão que este arquivo existe para impedir — cada frase nova voltaria a
 * nascer só em português no dia em que alguém esquecesse o ramo.
 *
 * ─── De onde vem o idioma, e por que não custa consulta nova ───────────────
 *
 * O turno já lê a linha da organização para o fuso (`fuso-da-org.ts`), uma vez
 * por turno. A leitura passou a trazer `locale` na MESMA query
 * (`fatosDaOrganizacao`), então o idioma chega à montagem sem uma segunda ida
 * ao banco. Falha de leitura degrada para `pt-BR`, nunca derruba o atendimento:
 * idioma é acessório perto de uma resposta que não sai.
 *
 * ─── O que este módulo NÃO traduz, e por quê (exceção declarada) ───────────
 *
 *  1. `inputSchema` / `.describe()` / nomes de campo das ferramentas. É
 *     contrato executado: o handler lê `body`, `stage`, `motivo_codigo`, e os
 *     valores (`requested_human`, `critical_stage`) são enumerados pelo código.
 *     Traduzir a chave muda comportamento, não idioma. As descrições das
 *     ferramentas seguem o mesmo vocabulário das mensagens de ENSINO que o
 *     handler devolve ao modelo em português ("encerre o turno agora"), e
 *     `scripts/ops-count-prefix.ts` mede esse prefixo — por isso a descrição de
 *     `update_lead_state` (a que carrega a regra do item 1) é traduzida e as
 *     demais ficam registradas aqui como pendência declarada, não como
 *     esquecimento.
 *  2. `agendaSystemBlock(toolIds)`: o texto é COMPOSTO por `tem(ferramenta)` —
 *     cada ramo nomeia um conjunto diferente de ferramentas. Traduzir exige um
 *     segundo texto por ramo, e o ganho é nulo hoje (o bloco vizinho, o da
 *     cadeia de dois passos, fala o idioma). Fica registrado.
 *  3. O JSON do fechamento (`commitments`, `objections`, `next_action`,
 *     `rolling_summary`, `declaracao`…) tem chaves que o parser lê: a prosa em
 *     volta muda de língua, as chaves não.
 */
import { traduzir } from '@/lib/i18n/dicionario';
import { normalizarIdioma, type Idioma } from '@/lib/i18n/idiomas';

export type { Idioma };

/**
 * As frases em português medidas no item 1 da #4260 — o inventário que o teste
 * usa como régua. Elas são o que o modelo lia TODO turno, em qualquer idioma.
 */
export const FRASES_PT_DO_ITEM_1: readonly string[] = [
  'Você é o assistente interno desta equipe de atendimento.',
  'Nunca invente: sem trecho que sustente, não declare.',
  'Nunca invente avanço sem evidência na conversa.',
  'Nunca invente um `slug`',
  'Você é o operador do sistema.',
];

/** O idioma gravado na organização, degradando para o padrão do produto. */
export function idiomaDoMotor(bruto: string | null | undefined): Idioma {
  return normalizarIdioma(bruto);
}

/**
 * A prosa do motor no idioma pedido — a ÚNICA função de resolução.
 *
 * `pt-BR` devolve o texto de hoje, byte a byte (é o contrato de `traduzir`: a
 * chave é o português). Idioma sem tradução também degrada para o português em
 * vez de mostrar chave crua: uma tradução parcial não pode deixar o prompt pior
 * do que estava.
 *
 * ⚠️ Corpo em expressão, e não em bloco: é a forma que
 * `tests/unit/i18n-espanhol-cobre-a-tela` reconhece como PASSA-ADIRETO. Aqui o
 * parâmetro é a própria chave de quem chama (os blocos são constantes em
 * português), e não dado de operador escolhido na tela.
 */
export const falaDoMotor = (texto: string, idioma: Idioma): string => traduzir(texto, idioma);

/**
 * As ferramentas com a descrição no idioma do turno.
 *
 * Nome, schema e `execute` passam intactos: só a prosa muda. Ferramenta sem
 * tradução no dicionário volta igual — e é assim que a exceção declarada no
 * cabeçalho se comporta na prática, sem lista paralela para envelhecer.
 *
 * ⚠️ `description` do AI SDK pode ser FUNÇÃO (descrição dinâmica, resolvida a
 * cada chamada). Ela não é prosa do motor: não tem texto para traduzir e
 * continua intacta. Só a descrição em string passa pelo dicionário.
 */
export function ferramentasNoIdioma<T extends object>(
  tools: Record<string, T>,
  idioma: Idioma,
): Record<string, T> {
  const saida: Record<string, T> = {};
  for (const [nome, tool] of Object.entries(tools)) {
    const descricao = (tool as { description?: unknown }).description;
    if (typeof descricao !== 'string') {
      saida[nome] = tool;
      continue;
    }
    saida[nome] = { ...tool, description: falaDoMotor(descricao, idioma) } as T;
  }
  return saida;
}

/** O bloco do prompt que nomeia a língua do atendimento — em português, a chave. */
export const DIRETIVA_DE_IDIOMA_PT =
  '## Idioma da conversa\n' +
  'Esta organização atende em português (Brasil). Responda ao lead nesse idioma e no idioma em que ele ' +
  'escrever — siga a pessoa, não imponha o seu. O texto das suas instruções internas não é a língua do ' +
  'atendimento: se o lead escreve em espanhol ou em inglês, a resposta sai em espanhol ou em inglês, ' +
  'mesmo que as regras acima estejam em português.';

/**
 * A diretiva de idioma do turno.
 *
 * É a parte que conserta o comportamento mesmo quando algum bloco vizinho ainda
 * está em português (ver as exceções no cabeçalho): sem ela, o modelo infere a
 * língua da resposta do prompt, não da conversa.
 */
export function diretivaDeIdioma(idioma: Idioma): string {
  return falaDoMotor(DIRETIVA_DE_IDIOMA_PT, idioma);
}
