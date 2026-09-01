# Fix: `isServiceRoleConfigured()` inferia validade da chave pelo comprimento

**Branch:** `fix/service-role-key-formato-novo` (worktree `/Users/rafaelmelgaco/SonghaiCRM-svckey`)
**Arquivo alterado:** `lib/audit/index.ts`
**Teste novo:** `lib/audit/service-role-configured.test.ts`

## O bug

```ts
export function isServiceRoleConfigured(): boolean {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return key.length > 50 && !key.startsWith("PLACEHOLDER");
}
```

A função pergunta "tenho uma service role key utilizável?" e responde medindo o
**comprimento** da string. Isso só valia enquanto o Supabase emitia chave em
formato JWT (200+ caracteres). O Supabase passou a emitir também o formato
curto `sb_secret_...`.

## Evidência

Chave real medida no `.env.local` de outro worktree deste mesmo projeto:
formato `sb_secret_`, **41 caracteres**. `41 > 50` é falso → a função devolvia
`false` para uma chave perfeitamente configurada e válida.

## Alcance — 13 pontos de uso, e o que cada um faz quando a resposta é `false`

| Local | Comportamento quando `isServiceRoleConfigured()` devolve `false` (bugado) |
|---|---|
| `app/actions/auth/useRecoveryCode.ts:48` | `return { ok: false, error: "service_unavailable" }` — **quem perdeu o autenticador não consegue mais logar no próprio CRM**; a mensagem sugere tentar de novo, o que nunca funciona (a chave nunca muda de tamanho sozinha). |
| `app/api/v1/team/route.ts:54` | Lista de equipe volta com `email: null, full_name: null` em todo membro — degrada silenciosamente. |
| `app/api/v1/leads/bulk/route.ts:71` | Atribuição em massa de dono devolve 422 `owner_validation_unavailable` ("tente novamente em instantes") — nunca resolve sozinho. |
| `app/api/v1/attendants/availability/route.ts:50` | Devolve só linhas de disponibilidade sem roster (nome/email/role nulos, `current_load: 0`). |
| `app/api/v1/team/assignable/route.ts:35,48` | Usa client comum em vez de admin (arrisca RLS incompleta pra managers) e devolve `full_name: null` na lista de atribuíveis. |
| `app/api/v1/team/invite/route.ts:62` | `admin = null` — convite por email não resolve membros já ativos por email (reconvida gente que já é membro). |
| `app/api/v1/metrics/attendants/route.ts:89` | Métricas de atendente vêm sem nome/email — dashboard degradado. |
| `app/api/v1/conversations/[id]/transfer/route.ts:56` | Pula a validação de que o destino é membro ativo agent+ da org — transferência sem checagem. |
| `app/actions/settings/regenerateRecoveryCodes.ts:42` | Usa client user-scoped em vez de admin pra delete+insert dos códigos de recuperação (pode falhar por RLS mais restrita no delete). |
| `app/actions/auth/confirmMfaEnroll.ts:69` | Sem fallback admin se o insert user-scoped falhar por RLS — perde os códigos de recuperação gerados no enrollment. |
| `lib/leads/timeline-query.ts:132` | Timeline de lead mostra IDs em vez de nomes de usuário nas atividades. |
| `lib/audit/index.ts:44` (a própria função) | `audit()` cai no client do usuário — em rotas sem sessão (webhook, cron, login falho) a RLS barra o insert e **a auditoria simplesmente não acontece**, silenciosamente. |

O ponto mais grave é `useRecoveryCode.ts`: é o único caminho de recuperação de
conta pra quem perdeu o app autenticador, e falhava com a chave certa configurada.

## O conserto

```ts
export function isServiceRoleConfigured(): boolean {
  const key = env.SUPABASE_SERVICE_ROLE_KEY.trim();
  return key.length > 0 && !key.startsWith("PLACEHOLDER");
}
```

Parei de inferir a partir do comprimento. A pergunta real é "tenho uma chave
utilizável?", e a única resposta "não" verdadeira é ausência de fato: string
vazia ou marcador de placeholder explícito. Qualquer outra coisa — JWT longo,
`sb_secret_` curto, ou um formato futuro que o Supabase venha a emitir — conta
como configurada. Erra para o lado de "tenho a chave": se a chave estiver
errada de verdade, o admin client vai falhar alto na chamada real (erro do
Supabase), o que é preferível a degradar em silêncio pra todo usuário, que era
o efeito real do bug.

Comentário no código explica o raciocínio pro próximo que mexer ali.

## Teste

Novo arquivo `lib/audit/service-role-configured.test.ts` (segue o padrão de
`lib/supabase/cookie-secure.test.ts`: mocka `@/lib/env` e muta o valor por
teste, porque `env.SUPABASE_SERVICE_ROLE_KEY` é validado — e lançaria — no
import se não fosse mockado).

4 testes, todos verdes:
- `chave sb_secret_ (~41 chars, formato novo do Supabase) → true`
- `JWT longo (formato legado do Supabase) → true`
- `string vazia → false (ausência de verdade)`
- `marcador de placeholder → false`

### Sabotagem (prova que o teste morde)

Restaurei a heurística antiga (`key.length > 50 && ...`) e rodei
`pnpm vitest run lib/audit/service-role-configured.test.ts`:

```
FAIL  lib/audit/service-role-configured.test.ts > isServiceRoleConfigured — presença de chave, não comprimento > chave sb_secret_ (~41 chars, formato novo do Supabase) → true
AssertionError: expected false to be true
```

Ficou vermelho **exatamente** no teste da chave `sb_secret_` (nome do teste
acima), os outros 3 continuaram verdes. Restaurei o fix (`key.length > 0`) e
rodei de novo: 4/4 verde.

## Verificação

- `pnpm vitest run lib/audit/service-role-configured.test.ts` — 4 passed
- `pnpm test:unit` (suíte inteira, 1369 testes) — 2 falhas por timeout
  (`import-puro-sem-env.test.ts` e `_mapping.test.tsx`), ambas rodadas
  isoladas em seguida e passaram 100% — timeout de máquina compartilhada sob
  carga, não regressão do fix. 1367/1369 verdes na corrida completa, 100%
  isolado.
- `pnpm typecheck` — 0 erros
- `pnpm lint` — 0 erros (152 warnings pré-existentes, nenhum nos arquivos tocados)

## Investigação: outras heurísticas de comprimento/prefixo em credencial

`grep -rn "\.length >" --include="*.ts" --include="*.tsx"` filtrado por
contexto de credencial encontrou 3 ocorrências além da consertada — **nenhuma
da mesma classe de bug** (nenhuma infere formato de um terceiro que pode mudar):

| Local | O que checa | Por que não é o mesmo bug |
|---|---|---|
| `lib/lgpd/pades-signer.ts:25` — `isPadesConfigured()` | `Boolean(key && key.length > 10)` sobre `LGPD_SIGNING_KEY` | Não é chave de terceiro com formato fixo — é um segredo de assinatura P12 que o próprio operador gera/cola; `>10` é só uma checagem frouxa de "não está vazio", não uma inferência de formato de terceiro. MVP explicitamente documentado como stub até o cert real ser provisionado. |
| `lib/nuvemshop/state.ts:18` — `key()` (state OAuth) | `secret.length >= 16` sobre `INTERNAL_SECRET` | Segredo INTERNO gerado pelo próprio self-hoster (não por terceiro) — o corte é uma exigência mínima de força HMAC, não uma tentativa de reconhecer o formato de outra empresa. Comportamento estável (o operador não vai "trocar o formato" do próprio secret). |
| `lib/impersonate/cookie.ts:69` — `isSecretConfigured()` | `secret.length >= 32` sobre o secret de assinatura do cookie de impersonate | Mesma categoria: secret interno, exigência de força mínima pra HMAC-SHA256, não inferência de formato externo. |

Essas três são checagens de **força mínima de segredo gerado internamente**,
categoria diferente da bugada (inferir se uma credencial **emitida por
terceiro** — cujo formato o terceiro pode mudar — está presente). Não mexi
nelas, conforme escopo pedido.
