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
 * integração de ligações o recebe junto de tudo o mais. Mexer na tarefa da
 * equipe tem efeito fora do registro (a exclusão some da rotina de alguém), e
 * quem emite o token decide se a integração tem esse poder — a mesma decisão de
 * produto que abriu `config:read`/`config:write` no #2052 e `messages:on_behalf`
 * no #1613.
 *
 * Os nomes são os DA ISSUE (#4516): `tasks:read` e `tasks:write`. Trocar por
 * outro vocabulário quebraria a promessa feita ao cliente que pediu a porta.
 */
export const ESCOPO_TAREFAS_LEITURA = "tasks:read";
export const ESCOPO_TAREFAS_ESCRITA = "tasks:write";
