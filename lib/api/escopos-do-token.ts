/**
 * ESCOPOS PRÓPRIOS DAS PORTAS DE ESCRITA POR TOKEN (#4517).
 *
 * `api_tokens.scopes` é jsonb (`supabase/baseline.sql`, tabela `api_tokens`) e o
 * gate é `ensureScope` em `lib/mcp/auth.ts`: uma string, comparada por inclusão.
 * Não existe lista fechada no banco — o que existe é a lista que a TELA oferece
 * ao emitir o token (`app/app/settings/api-tokens/_components/ApiTokensClient.tsx`).
 * Escopo que a rota exige e a tela não oferece é escopo que ninguém consegue
 * conceder; é o defeito que o #1613 já custou uma vez em `messages:on_behalf`.
 *
 * ─── Por que escopo PRÓPRIO, e não `mcp:write` outra vez ────────────────────
 *
 * `mcp:write` é o "pode agir no CRM" genérico, e um token emitido para uma
 * integração de atendimento o recebe junto de tudo o mais. Pausar a IA muda QUEM
 * responde o cliente; sobrescrever a ficha muda o cadastro que a equipe usa para
 * decidir. Quem emite o token decide separadamente se a integração tem esses
 * poderes — a mesma decisão de produto que abriu `config:read`/`config:write` no
 * #2052 e `messages:on_behalf` no #1613.
 */
/**
 * A EDIÇÃO DIRETA DA FICHA (#4517). `contacts:write` já existia na TELA
 * (`ApiTokensClient.tsx`) e no vocabulário dos tokens; o que faltava era a
 * ferramenta que o cobrasse — até aqui a edição por token parava em
 * `crm_propose_contact_field`, que cria uma proposta e espera alguém abrir o CRM.
 *
 * ⚠️ Sem este escopo o dado continua virando PROPOSTA. É o comportamento de
 * hoje, e continua sendo o de amanhã: quem emite o token decide se a integração
 * SOBRESCREVE a ficha ou se só pede revisão.
 */
export const ESCOPO_CONTATOS_ESCRITA = "contacts:write";
/**
 * PAUSAR/RETOMAR A IA E FECHAR/REABRIR A CONVERSA (#4517). Escopo próprio, e
 * não `contacts:write`: desligar o atendimento automático de uma conversa muda
 * quem responde o cliente — poder diferente de corrigir um cadastro, decidido
 * separadamente por quem emite o token.
 */
export const ESCOPO_CONVERSAS_ESCRITA = "conversations:write";

/**
 * O token tem o escopo? `undefined` (sessão de navegador, que não tem escopos)
 * devolve `false` de propósito: quem pergunta isto está no ramo de TOKEN, e uma
 * resposta "sim" para quem não é token abriria a porta pelo caminho errado.
 */
export function tokenTemEscopo(
  scopes: readonly string[] | undefined,
  escopo: string,
): boolean {
  return Array.isArray(scopes) && scopes.includes(escopo);
}
