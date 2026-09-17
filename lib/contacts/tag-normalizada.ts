/**
 * A MESMA regra de normalização nos dois lados do editor de tags do contato.
 *
 * O editor normalizava ao GRAVAR (`raw.trim().toLowerCase().slice(0, 40)`) e a
 * rota de sugestões devolvia a tag CRUA. Para toda tag armazenada fora dessa
 * forma o chip mentia sobre si mesmo: clicar em "+ VIP" gravava "vip", o chip
 * continuava na tela porque o filtro comparava com sensibilidade a caixa, e do
 * segundo clique em diante não fazia nada — controle decorativo, e a duplicação
 * que a sugestão veio impedir.
 *
 * Tag de contato em caixa mista é alcançável pelo caminho NORMAL do produto, e
 * a razão é uma assimetria: a tag de CONVERSA é normalizada pelo próprio schema
 * (`conversationTagSchema`, lib/schemas/messaging.ts:147, com `.trim()
 * .toLowerCase()`), enquanto a de CONTATO é `z.array(z.string())`
 * (lib/schemas/contacts.ts:61) e o handler grava verbatim — o diálogo de novo
 * contato, o de edição e a importação por CSV só fazem `.trim()`.
 *
 * ⚠️ ESCOPO: esta função conserta o LADO DA LEITURA — o rótulo do chip passa a
 * dizer exatamente o que o clique grava. A causa raiz é a escrita não
 * normalizar, e ela segue de pé: um "VIP" antigo continua no banco. Fechá-la é
 * mudar `contactCreateSchema`/`contactPatchSchema`, o que alcança importação de
 * CSV, MCP e clientes da API — decisão maior que este conserto, e que precisa
 * de migração dos dados existentes.
 */
export const TAMANHO_MAXIMO_DA_TAG = 40;

export function normalizarTag(cru: string): string {
  return cru.trim().toLowerCase().slice(0, TAMANHO_MAXIMO_DA_TAG);
}
