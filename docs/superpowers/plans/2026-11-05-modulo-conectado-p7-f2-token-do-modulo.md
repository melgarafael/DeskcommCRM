# Módulo conectado (Spec 33) — F2: token do módulo — plano de implementação

> **Para quem executa:** um agente por tarefa, na ordem. Quem escreve o código NÃO valida o próprio trabalho: o Claude lê o diff, o CI julga. Leia antes: `CLAUDE.md` da `origin/main` (seções Multi-tenancy, Migrations, API v1, Definition of Done), a skill `deskcomm-doutrina`, `docs/doctrine/extensoes.md`, a Spec 33 (seção F2 e "Decisões onde a ADR não decide"), e o plano da F1 (`…p5-f1-perfil-connected.md`) que é o molde.

**Meta:** um módulo `connected` instalado e ativado numa organização consegue **buscar** um token curto (`dsk_…`) provando que tem o segredo da instalação; o host revoga esse token ao desativar, remover, desligar ou revogar na tela de tokens.

**Base:** a branch nasce de `feat/modulo-conectado-f1` (precisa de `disabled_at` e do recibo `switch`). Branch: `feat/modulo-conectado-f2`, worktree próprio. PR interno contra a F1 até a F1 entrar.

**Spec:** `docs/specs/33-spec-modulo-conectado.md`, F2 e decisões 1, 3 e 4.

## Medido em 05/11/2026 (o que a spec não diz ou diz diferente)

| Fato | Onde | Consequência |
|---|---|---|
| O banco só guarda o hash do token; o texto aparece uma vez | `lib/mcp/auth.ts` `resolveApiToken` (hash SHA256 → `token_hash`) | A spec diz "ativar cria o token" **e** "cada busca gera um token novo". Os dois só fecham assim: **a ativação reserva a vaga** (linha com hash de preimagem desconhecida) e a **busca troca o hash** por um novo. Assim o teto de 50 e a revogação transacional valem na ativação, e ninguém precisa do texto na ativação. **Emenda 1.** |
| `api_tokens.created_by` é `NOT NULL`, FK `ON DELETE RESTRICT` | baseline 1294, 3428 | Decisão 3 da spec: `created_by` passa a aceitar nulo, com CHECK `created_by is not null or extension_installation_id is not null`. |
| `(organization_id, prefix)` é único; o prefixo tem 8 hex | baseline 2110 | A vaga reservada usa prefixo aleatório de 8 hex derivado de `gen_random_uuid()`. |
| `expires_at` já existe e `resolveApiToken` o respeita | `lib/mcp/auth.ts:177` | A validade de 1 h é `expires_at`; sem código novo de expiração. |
| Organização suspensa: `validateBearerToken` recusa com 403 `org_suspended` sem revogar | `lib/mcp/auth.ts:240` | A spec diz "suspender revoga". **Emenda 2:** não revoga; a recusa já existe e a reativação retoma. Revogar numa suspensão apagaria o que o cliente configurou. |
| Nenhuma função SQL cria token; só o app | `app/api/v1/settings/api-tokens/route.ts` | A rotação do token de módulo é função SQL nova, só `service_role`. |
| `Actor` não tem variante de módulo | `lib/api/handlers/types.ts:17-77` | Tarefa 5. |
| Não existe tabela de nonce para assinatura de entrada | busca por `nonce` no baseline | Tabela nova, com limpeza oportunista na própria busca. |
| Cifra pronta | `lib/crypto/aes_gcm.ts`, env `AI_CRED_AES_KEY` | O segredo da instalação é cifrado por ela. Chave ausente ⇒ a instalação **falha antes** de gravar, com mensagem na tela. |
| `fn_extensions_configure` e `fn_extensions_remove_installation` não tocam `api_tokens` | baseline 28479, 28603 | Tarefa 2 as redefine (a ÚLTIMA definição do baseline é a base: `rfind` ou `pg_get_functiondef`). |

## Global Constraints

- Tripla de migration por mudança de schema: `supabase/migrations/<timestamp>_<NNNN>_<slug>.sql` (NNNN por `pnpm checar:colisao-de-migration`, **não** pelo último arquivo), apêndice idempotente no `supabase/baseline.sql` (antes do bloco "VARREDURA anon (0116)"), linha `-- manifest:` no cabeçalho. Nunca editar migration aplicada.
- Função nova em `public`: `revoke execute … from public, anon, authenticated` e `grant … to service_role`.
- Tabela nova com `organization_id`: RLS ligada, policy `tenant_isolation_<tabela>_all` via `fn_user_org_ids()`. Tabela só de servidor (segredo, nonce): RLS ligada **sem** policy para `authenticated`.
- O segredo nunca é registrado em log, audit, recibo (`extension_operations.result`) nem resposta que não seja a única exibição.
- Rota nova sob `app/api/v1`: `ok()`/`fail()`, `X-Request-Id`, Zod, rate limit se pública, entrada em `lib/auth/public-paths.ts` se aceita não-sessão, audit de toda mutação bem-sucedida, `requireSupportWrite(` antes do efeito.
- Zero módulos continua sendo estado completo. Nada de F3 aqui: o token da F2 nasce com escopo mínimo `mcp:read` e papel `viewer`; a autoridade por área é da F3.
- Definition of Done: item 13 (Sistema Vivo, 10 respostas), 14, 16, 17 (fragmento `.changes/`, `exige_acao` não se aplica), 18 (destino: infraestrutura de plataforma de extensões).

## Review Focus (entradas que ninguém testa por padrão)

1. Duas buscas simultâneas do mesmo par: só uma token vale; a outra recebe 409 ou o mesmo resultado idempotente, nunca dois tokens vivos.
2. Relógio do módulo adiantado/atrasado exatamente 5 min: borda inclusiva e exclusiva testadas.
3. Nonce repetido com carimbo válido: recusa; nonce igual em instalação **diferente**: aceita.
4. Segredo girado no meio de uma busca: a busca com o segredo velho recusa; a nova passa.
5. Organização com 50 tokens vivos ativa módulo: a ativação falha inteira (nada fica pela metade).
6. Usuário que instalou é apagado: o token do módulo e o segredo continuam (`created_by` nulo).
7. Instalação desligada (`disabled_at`) ou ativação desativada: a busca recusa e **não** troca o hash.
8. Uma organização A nunca obtém token da instalação ativada só na B (mesma instalação, orgs diferentes).

## Tarefa 1 — Schema (migration + baseline + invariantes)

**Arquivos:** migration `…_NNNN_modulo_conectado_token_schema.sql`, apêndice em `supabase/baseline.sql`, `tests/invariants/extensoes-token-modulo.test.ts`.

**Faz:**
- `api_tokens`: `alter … add column if not exists extension_installation_id uuid references public.extension_installations(id)`, `module_slug text`; `created_by drop not null`; CHECK `api_tokens_dono_check` (`created_by is not null or extension_installation_id is not null`); índice único parcial `(organization_id, extension_installation_id) where revoked_at is null and extension_installation_id is not null`.
- `public.extension_installation_secrets(installation_id uuid primary key references extension_installations(id) on delete cascade, ciphertext text not null, rotated_at timestamptz not null default now(), rotated_by uuid references auth.users(id) on delete set null)`; RLS ligada, sem policy.
- `public.extension_token_nonces(installation_id uuid references extension_installations(id) on delete cascade, nonce text not null, seen_at timestamptz not null default now(), primary key (installation_id, nonce))`; RLS ligada, sem policy; índice em `seen_at`.
- Testes de invariante (banco real): CHECK recusa token sem dono; índice único recusa segundo token vivo do par; apagar usuário não apaga token de módulo; tabelas sem policy para `authenticated` (leitura recusada).

**Verificação:** CI `invariants` (15 e 17) verdes.

## Tarefa 2 — Funções do banco

**Arquivos:** migration `…_NNNN_modulo_conectado_token_funcoes.sql` (+ apêndice), mesmo arquivo de teste de invariantes.

**Faz (assinaturas fixas):**
- `fn_extensions_module_token_reserve(p_organization uuid, p_installation uuid) returns uuid` — insere a vaga (nome `Módulo <publisher>/<name>`, prefixo aleatório, `token_hash = sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text,'utf8'))`, escopo `["mcp:read","role:viewer","actor:module:<publisher>/<name>"]`, `expires_at = now() + interval '100 years'`). **Medido em 05/11:** o gatilho `fn_teto_de_tokens_ativos` (baseline ~39212) só conta tokens sem `revoked_at` E não expirados, e só roda no INSERT; uma vaga "vencida" não contaria no teto. A vaga fica então com validade longa e é inofensiva por construção (ninguém conhece a preimagem do hash). Dispara o gatilho do teto de 50 (a exceção `PT409` sobe e a ativação inteira falha). Idempotente pelo índice único.
- `fn_extensions_module_token_rotate(p_organization uuid, p_installation uuid, p_prefix text, p_hash bytea, p_expires_at timestamptz) returns uuid` — recusa (`PT409`) se a ativação não existe, `enabled = false` ou a instalação tem `disabled_at`; `update` da linha viva do par (novo prefixo, hash, `expires_at`, `revoked_at = null`). Como o `update` não passa pelo gatilho do INSERT, a função **reconfere o teto** quando a linha do par já estava expirada (conta os outros tokens ativos da organização; `>= 50` ⇒ `PT409`), para que o token expirado de um módulo não deixe a organização passar de 50 ao voltar. **Atenção à FK:** `api_tokens.extension_installation_id` não tem `on delete`; se `fn_extensions_remove_installation` apagar a linha da instalação, ela precisa apagar antes os `api_tokens` dela (o audit usa `on delete set null`, então a trilha fica). Confirme no baseline o que a função faz hoje (apaga ou marca).
- `fn_extensions_module_token_revoke(p_organization uuid, p_installation uuid, p_by uuid)`: `revoked_at = now()`; sem erro se já revogado.
- **Redefinir** `fn_extensions_configure` (ativar chama `reserve`; desativar chama `revoke`), `fn_extensions_remove_installation` e `fn_extensions_set_switch` (desligar revoga os tokens de todas as organizações da instalação). Base: a ÚLTIMA definição no baseline (`pg_get_functiondef` no banco de teste). Manter as respostas existentes.
- Grants: as quatro funções novas/redefinidas `revoke … from public, anon, authenticated` + `grant … to service_role`.

**Testes (invariantes):** ativar cria vaga vencida e conta no teto; teto cheio ⇒ ativar falha e `organization_extensions` não muda; rotate em ativação desativada ⇒ `PT409`; desativar/remover/desligar revoga; duas rotações em paralelo deixam **um** token vivo; token de org A não existe para org B.

## Tarefa 3 — Segredo da instalação e assinatura (TypeScript)

**Arquivos:** `lib/extensions/segredo-do-modulo.ts` (+ `.test.ts`), `lib/extensions/service.ts` (instalar `connected` gera o segredo), `lib/extensions/erros-do-banco.ts`.

**Interfaces produzidas:**
- `gerarSegredo(): string` (32 bytes base64url), `cifrarSegredo(s): string`, `decifrarSegredo(c): string` (usam `lib/crypto/aes_gcm.ts`; lançam `extension_secret_key_missing` se `AI_CRED_AES_KEY` faltar).
- `assinar(segredo, { organizationId, timestamp, nonce }): string` — HMAC-SHA256 hex sobre `${organizationId}.${timestamp}.${nonce}`.
- `verificarAssinatura(segredo, entrada, assinatura): boolean` com `crypto.timingSafeEqual`, comprimentos iguais conferidos antes.
- `JANELA_DO_CARIMBO_MS = 5 * 60 * 1000`.

**Testes:** assinatura correta passa; qualquer campo alterado reprova; comprimento diferente reprova sem lançar; carimbo a ±5 min (borda) e fora; `AI_CRED_AES_KEY` ausente ⇒ instalar `connected` falha **antes** de `fn_extensions_finish_install`, com mensagem em português.

## Tarefa 4 — Girar o segredo (rota + tela)

**Arquivos:** `app/api/v1/extensions/[id]/segredo/route.ts` (+ teste), `lib/extensions/requests.ts`, `lib/audit/actions.ts` (`extension.secret_rotated`), `ExtensionOperations`/`InstalledExtensionCard` (botão "Gerar novo segredo" só para `connected`), recibo `rotate_secret` em `vocabulario.ts`/CHECK de `kind` (tripla: coluna `kind` já tem CHECK editado em 9116, ver como o `switch` entrou).

**Emenda 3 (05/11):** sem recibo `rotate_secret` e sem `Idempotency-Key`. Um recibo (ou o corpo guardado de uma chave de idempotência) reproduziria o segredo em claro numa repetição, e o segredo só pode viver cifrado em `extension_installation_secrets`. Girar não é repetível: quem repete o pedido gera outro segredo; a tela desabilita o botão durante o pedido e mostra o segredo uma vez. Logo, esta tarefa não tem migration e não mexe no CHECK de `kind`.

**Faz:** `POST` mesmo portão da rota `switch` (menos o `operationKey`) (sessão de quem administra a instalação, `requireSupportWrite`, `operationKey` idempotente, plataforma). Gera, cifra, grava em `extension_installation_secrets` (upsert), responde **uma vez** com o segredo em claro; o recibo e o audit **não** levam o segredo. Girar revoga os tokens vivos da instalação (chama `revoke` por organização) — o módulo busca de novo com o novo segredo.

**Testes:** o corpo de resposta traz o segredo uma vez; o audit e o `extension_operations.result` não contêm o texto (teste procura o valor em toda linha gravada); girar invalida assinatura antiga; viewer/manager recebem 403; módulo `declarative` recebe 409.

## Tarefa 5 — A busca do token (rota do módulo)

**Arquivos:** `app/api/v1/extensions/token/route.ts` (+ teste), `lib/auth/public-paths.ts`, `lib/extensions/token-do-modulo.ts`.

**Faz:** `POST /api/v1/extensions/token`, cabeçalhos `X-Module-Installation`, `X-Module-Organization`, `X-Module-Timestamp`, `X-Module-Nonce`, `X-Module-Signature` (Zod). Ordem: rate limit por IP+instalação → carimbo dentro da janela → carregar segredo (admin client, filtros explícitos) → `verificarAssinatura` → inserir nonce (`23505` ⇒ recusa) e apagar nonces com mais de 10 min da mesma instalação → `fn_extensions_module_token_rotate` com token novo `dsk_<prefix>_<segredo>` e `expires_at = now()+1h` → `{ token, expires_at }`. Toda recusa devolve a mesma mensagem genérica (não diz se a instalação existe). Sucesso audita `extension.token_issued` (ator: instalação, sem texto do token). Entrada em `public-paths` só para esse caminho exato.

**Testes:** o caminho feliz devolve token que passa em `validateBearerToken` e tem o escopo mínimo; nonce repetido ⇒ recusa; carimbo velho ⇒ recusa; instalação desligada, ativação desativada, org errada ⇒ recusa sem trocar o hash; duas buscas concorrentes ⇒ um token vivo; a resposta de erro é idêntica para "instalação inexistente" e "assinatura errada"; cerca `rotas-bearer-tem-porta-no-proxy` e a de teto continuam verdes.

## Tarefa 6 — Ator `module`, tela de tokens, revogação

**Arquivos:** `lib/api/handlers/types.ts` (`Actor` ganha `{ type: "module"; id: string; slug: string }`), `lib/mcp/auth.ts` (`deriveActor` lê `actor:module:<slug>`), todos os `switch` exaustivos de `Actor` que o typecheck apontar, `lib/audit` (grava o slug em `metadata.module`), `app/app/settings/api-tokens` (linha identificada "Módulo <slug>", sem copiar nem editar, botão revogar), `app/api/v1/settings/api-tokens/[id]/revoke/route.ts` (token de módulo revogado ⇒ desativa a ativação daquele par, mesma transação via função).

**Testes:** `deriveActor` devolve `module` só com o escopo certo; nenhum `…_by_user_id` recebe id de token (teste varre as rotas que gravam `created_by_user_id`/`owner_user_id` a partir de `actor.id` e confirma o `actor.type === "user"`); revogar na tela desativa a ativação; a tela lista o token do módulo sem botão de copiar.

## Tarefa 7 — Fecho (documentos e prova)

**Faz:** `.changes/modulo-conectado-token.md` (`capacidade_nova`); `docs/testing/user-journey-map.md` (J69: instalar `connected`, girar segredo, ativar, buscar token — escrita como especificação enquanto o laboratório não suporta `connected`); mapa `docs/architecture/extensoes-declarativas.architecture.json` (nós: segredo, nonce, rota de busca; arestas); Living System Checklist com as 10 respostas nomeando o artefato; destino declarado; "afirmações de estado" viram comando; `pnpm skills:sync` se tocar o guia; `evidence/modulo-conectado-f2/` com a saída do pré-voo.

**Fora desta fase (de propósito):** autoridade por área (F3); o token só-leitura de 30 dias após revogação (decisão 4, F5); tela do módulo (F4).

## Ordem e executores

1 → 2 (Sonnet, banco e segurança) → 3 → 4 → 5 (Sonnet) → 6 (Sonnet, atinge muitos arquivos) → 7 (Haiku). Uma tarefa por vez, um commit por tarefa. O Claude lê o diff de cada uma; nada roda localmente; o veredito é o CI do PR interno.
