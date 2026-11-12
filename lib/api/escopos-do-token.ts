/**
 * ESCOPOS PRÓPRIOS DAS PORTAS DE ESCRITA POR TOKEN.
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
 * integração de ligações o recebe junto de tudo o mais. Registrar comparecimento
 * e mexer em tarefa são poderes com efeito fora do registro (o `no_show`
 * devolve horário ao pool; a exclusão de tarefa some da rotina da equipe), e
 * quem emite o token decide se a integração os tem — a mesma decisão de produto
 * que abriu `config:read`/`config:write` no #2052 e `messages:on_behalf` no
 * #1613.
 *
 * Os nomes são os DA ISSUE (#4515, #4516): `agenda:attendance`, `tasks:read` e
 * `tasks:write`. Trocar por outro vocabulário quebraria a promessa feita ao
 * cliente que pediu a porta.
 */
export const ESCOPO_DESFECHO_DA_AGENDA = "agenda:attendance";
export const ESCOPO_TAREFAS_LEITURA = "tasks:read";
export const ESCOPO_TAREFAS_ESCRITA = "tasks:write";
/**
 * A EDIÇÃO DIRETA DA FICHA (#4517). `contacts:write` já existia na TELA
 * (`ApiTokensClient.tsx`) e no token; o que faltava era uma porta que a
 * cobrasse — até aqui a edição por token parava em `crm_propose_contact_field`,
 * que cria uma proposta e espera alguém abrir o CRM.
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
