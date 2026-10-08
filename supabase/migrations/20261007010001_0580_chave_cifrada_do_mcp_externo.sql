-- manifest: **A chave do servidor MCP externo sai de `organizations.settings` para colunas cifradas na própria linha da organização (#2147, item 3).** O jsonb `settings` é entregue pela RLS a TODO membro da organização (`orgs_select`, `fn_user_org_ids` sem filtro de papel): um `viewer` lia `settings.mcp_externo.chave` em claro com a própria sessão. Agora ela é AES-256-GCM pelo mesmo caminho das chaves de IA (`encryptKey`, `lib/crypto/aes_gcm.ts`, chave de instalação `AI_CRED_AES_KEY`), nas colunas `*_encrypted`/`*_iv`/`*_tag` + `last4` — o `last4` é a única parte que o cadastro devolve. As colunas seguem na linha que todo membro lê: o que protege a chave é a cifra, não a RLS. Endpoint continua no jsonb (merge em dois níveis); o registro continua UMA LINHA por organização, lida pelo `organization_id` do run (itens 2 e 5). Idempotente: `add column if not exists`. Nenhuma função nova em `public`, portanto nenhum `revoke execute` a fazer. Apêndice espelhado no fim do `baseline.sql`; `MANIFEST.md` é histórico e não recebe linha.

-- 0580 — a chave do servidor MCP externo vira coluna cifrada.
--
-- Por que coluna e não o jsonb: `settings.mcp_externo` ficava em claro para
-- qualquer membro da organização, inclusive o papel mais baixo (medido no
-- baseline: `orgs_select` entrega a linha inteira, `GRANT ALL` em
-- `organizations` e `fn_user_org_ids()` sem filtro de papel).
--
-- O que estas colunas NÃO fazem: esconder a si mesmas. Elas moram na mesma
-- linha, e `orgs_select` entrega a linha inteira a todo membro — o ciphertext,
-- o iv, a tag e o `last4` são legíveis por qualquer membro, como o resto da
-- linha. O que protege a chave é a cifra: `AI_CRED_AES_KEY` nunca sai do
-- servidor. Tirar estas colunas do alcance do PostgREST (como
-- `ai_provider_credentials` faz com grant por coluna) pediria tabela própria
-- ou revogar o SELECT da tabela `organizations` inteira, e fica para depois.
--
-- Por que essas quatro colunas: é o padrão de `lib/ai/credenciais/guardar.ts`
-- (`colunasCifradas`), que já é o caminho das chaves de provedor de IA. Mesma
-- cifragem, mesma forma de `bytea`, mesmo `last4`. Reimplementar o formato aqui
-- faria os dois caminhos divergirem no primeiro ajuste — e o ajuste que
-- divergiria seria o de segurança.
--
-- O que NÃO nasce aqui: função, trigger, índice, policy. A tabela `organizations`
-- já tem RLS e grants; as colunas novas entram na cobertura deles.
alter table public.organizations
  add column if not exists mcp_externo_chave_encrypted bytea,
  add column if not exists mcp_externo_chave_iv bytea,
  add column if not exists mcp_externo_chave_tag bytea,
  add column if not exists mcp_externo_chave_last4 text;

comment on column public.organizations.mcp_externo_chave_encrypted is
  'Chave do servidor MCP externo (#2147), cifrada com AES-256-GCM pela chave de instalação AI_CRED_AES_KEY. NULL = sem servidor registrado. Nunca em claro, nunca no jsonb settings.';

comment on column public.organizations.mcp_externo_chave_iv is
  'IV de 12 bytes da chave do servidor MCP externo (#2147) — anda sempre junto com o ciphertext e a tag.';

comment on column public.organizations.mcp_externo_chave_tag is
  'Tag de autenticação de 16 bytes da chave do servidor MCP externo (#2147); sem ela o decrypt é recusado.';

comment on column public.organizations.mcp_externo_chave_last4 is
  'Últimos 4 caracteres da chave do servidor MCP externo (#2147) — é o que se mostra para identificar, nunca a chave inteira.';

notify pgrst, 'reload schema';
