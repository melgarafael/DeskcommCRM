# Módulo conectado F2: declarações do PR

Este documento é a declaração que vai no corpo do PR da F2 (token do módulo: segredo da instalação,
assinatura, busca do token, ator `module` e revogação). Cada afirmação traz o comando que a produz.
Nada aqui foi executado nesta máquina: o veredito é o CI do PR interno.

## Destino (item 18 do Definition of Done)

**Infraestrutura da plataforma de extensões.**

Pergunta-raiz: *se nenhuma organização desta instalação ativar um módulo `connected`, a operação comum
continua inteira?* Sim. Sem nenhum módulo `connected` instalado e ativado:

- o segredo da instalação (`extension_installation_secrets`) só é gravado por instalação `connected`
  (`lib/extensions/service.ts`, chamada a `cifrarSegredo`); um `declarative` não recebe linha;
- o token do módulo (linhas de `api_tokens` com `extension_installation_id`) só nasce quando
  `fn_extensions_configure` ativa um `connected` (a reserva da vaga). Ativar um `declarative` não cria token;
- os nonces (`extension_token_nonces`) só são gravados pela busca do token, que só responde a uma
  assinatura válida de uma instalação existente;
- a rota `POST /api/v1/extensions/token` recusa com a mesma mensagem genérica qualquer instalação que
  não exista, esteja desligada ou não ativa na organização;
- a rota `POST /api/v1/extensions/[id]/segredo` recusa com 409 `extension_secret_not_applicable` um
  módulo que não é `connected`;
- a tela de tokens só mostra a linha "Módulo <slug>" quando a linha tem `module_slug`.

Verificação: `grep -n "extension_secret_not_applicable" lib/extensions/girar-segredo.ts`.

Se o mantenedor classificar a mudança como "ambos", o consumidor real do ponto novo é o primeiro módulo
conectado, descrito na spec 33. A spec não está nesta branch, e este PR não a nomeia além disso.

Versão da API do host: **não sobe nesta F2.** `HOST_API_VERSION = 2` (verificação:
`grep -n "HOST_API_VERSION =" lib/extensions/manifest.ts`, linha 150).

## Tela (item 14)

**Nenhuma tela nova.** Duas telas existentes ganham linha ou botão:

- `/admin/extensoes`: cartão do módulo `connected` com "Gerar segredo" (sem segredo) ou "Gerar novo segredo"
  (com segredo), e a caixa que mostra o segredo uma vez
  (`components/extensions/InstalledExtensionCard.tsx`). A porta já existe em `lib/admin/navegacao.ts`,
  linha 210 (`grep -n '"/admin/extensoes"' lib/admin/navegacao.ts`).
- `/app/settings/api-tokens`: linha "Módulo <slug>" (sem botão de copiar) e o botão Revogar, que
  desativa a ativação daquela organização (`app/app/settings/api-tokens/_components/ApiTokensClient.tsx`).
  A porta já existe em `lib/navigation/catalogo.ts`, linha 1152
  (`grep -n "api-tokens" lib/navigation/catalogo.ts`).

## Env nova (item 9)

**Nenhuma.** `AI_CRED_AES_KEY` já existia para a cifra das credenciais de IA; a F2 só a reutiliza.
Verificação: `grep -n "AI_CRED_AES_KEY" .env.example lib/env.ts` (linhas 93 e 180) e
`git diff --stat f88438ad8 30a87a43a -- .env.example lib/env.ts` sai vazio.

Chave ausente: a instalação `connected` falha **antes** de `fn_extensions_finish_install`, lançando
`ChaveDeCifraAusenteError` (`lib/extensions/segredo-do-modulo.ts`, linha 38). O recibo fica em
preparação (`lib/extensions/service.ts`, linhas 890 a 891), e quem pediu repete o mesmo pedido depois de
configurar a chave. Como a mensagem chega à tela, ver "O que NÃO foi medido".

## Migrations (tripla)

- `supabase/migrations/20261105100000_9117_modulo_conectado_token_schema.sql` (`api_tokens` ganha
  `extension_installation_id` e `module_slug`; `created_by` passa a aceitar nulo com a CHECK
  `api_tokens_dono_check`; índice único parcial `api_tokens_modulo_vivo_idx`; tabelas
  `extension_installation_secrets` e `extension_token_nonces`, só de servidor).
- `supabase/migrations/20261105110000_9118_modulo_conectado_token_funcoes.sql` (funções
  `fn_extensions_module_token_reserve`, `fn_extensions_module_token_rotate`,
  `fn_extensions_module_token_revoke`; redefinidas `fn_extensions_configure`,
  `fn_extensions_remove_installation` e `fn_extensions_set_switch`).
- `supabase/baseline.sql`: apêndice idempotente com os dois blocos, antes da VARREDURA anon (0116).
  Verificação: `grep -n "extension_installation_secrets\|extension_token_nonces" supabase/baseline.sql`
  e `grep -n "fn_extensions_module_token_" supabase/baseline.sql`.
- Cada migration tem `-- manifest:` no cabeçalho (`head -1` de cada arquivo).

## Living System Checklist (item 13)

1. **Quem me alimenta.** A instalação e a ativação, gravadas por `fn_extensions_configure`,
   `fn_extensions_set_switch` e `fn_extensions_remove_installation` (`supabase/baseline.sql`). O segredo,
   gravado por `girarSegredoDaInstalacao` (`lib/extensions/girar-segredo.ts`) e pela instalação
   (`lib/extensions/service.ts`). A assinatura e o carimbo, enviados pelo módulo a
   `app/api/v1/extensions/token/route.ts`.
2. **Quem eu alimento.** `api_tokens` (a linha do módulo), lida por `resolveApiToken` em `lib/mcp/auth.ts`
   para autorizar `/api/v1`. O escopo é mínimo: `mcp:read`, `role:viewer`, `actor:module:<slug>`.
   Os nonces são lidos só pela própria busca. A autoridade por área é da F3: nesta fase o token não
   distingue área.
3. **Registro que emito.** `api_audit_log` com três ações novas ou reaproveitadas, todas em
   `lib/audit/actions.ts`: `extension.secret_rotated` (girar, `girar-segredo.ts`, sem o valor do segredo),
   `extension.token_issued` (busca bem-sucedida, ator módulo com `metadataDoModulo` de
   `lib/audit/ator-modulo.ts`, sem o texto do token) e `extension.switched` (quando desligar revoga).
   Recibo: **nenhum novo** (emenda 3 do plano: girar não tem recibo, para o segredo não ficar em
   `extension_operations.result`).
4. **Onde apareço na tela.** Os dois lugares do item 14: o cartão em `/admin/extensoes` e a linha
   "Módulo <slug>" em `/app/settings/api-tokens`.
5. **Por qual porta se chega.** `/admin/extensoes` (`lib/admin/navegacao.ts`, linha 210) e
   `/app/settings/api-tokens` (`lib/navigation/catalogo.ts`, linha 1152). Nenhuma tela nova.
6. **Anti-morte.** **Nenhum, com justificativa:** a busca é de máquina para máquina. Quem a recusa é o
   módulo, que recebe um código de erro (`module_auth_failed` 401, `rate_limited` 429,
   `internal_error` 503) e pode repetir. Nenhuma demanda de pessoa fica esperando resposta nesta fase.
7. **Onde se configura.** O próprio cartão (gerar ou girar o segredo) e a tela de tokens (revogar).
   A falta de `AI_CRED_AES_KEY` recusa a instalação de módulo `connected` (item 9 acima). Como essa recusa
aparece na tela, **não foi conferido**: o comentário de `lib/extensions/service.ts` (linha 144) diz que a
instalação não grava nada, sem dizer a mensagem.
8. **Continuidade IA↔humano.** Não se aplica nesta fase. A F2 não cria agente; o token do módulo tem só
   `mcp:read`, e a tela de tokens é a única ponte humana.
9. **Laço de retorno.** Fecha no host: desligar, remover ou revogar a linha do módulo revoga o token, e a
   busca seguinte é recusada (`fn_extensions_module_token_rotate` recusa com PT409 quando a ativação está
   desativada). **Dívida declarada, não presumida:** o que o módulo faz ao receber a recusa fica fora do
   sistema, e nenhum teste desta branch mede esse comportamento.
10. **Mapa.** `docs/architecture/extensoes-declarativas.architecture.json` ganha a lane `module` e oito nós
    (`installation_secret`, `token_nonce`, `module_token`, `secret_route`, `token_route`, `revoke_route`,
    `module`, `tokens_ui`) e 14 arestas. Verificação: `Get-Content -Raw
    docs/architecture/extensoes-declarativas.architecture.json | ConvertFrom-Json` (o JSON lê sem erro),
    e cada nó novo tem pelo menos uma aresta de entrada e uma de saída.

## Rota pública nova (Global Constraints)

`/api/v1/extensions/token` é o **único** caminho público desta fase, com a regra exata de
`lib/auth/public-paths.ts`. Os irmãos `/api/v1/extensions/[id]/segredo` e `/install` continuam de sessão.
Verificação: `grep -n 'extensions\\/token\$/' lib/auth/public-paths.ts` (a regra exata, com `$/` no fim;
os comentários da mesma região também citam o caminho, por isso a busca pela regra e não só pelo texto).

## Fragmento de release

`.changes/modulo-conectado-token.md`, com `impacto: capacidade_nova` e `secao: adicionado`. O texto
explica o que muda para quem administra a instalação (segredo, token de uma hora, revogação) e diz que
sem módulo conectado nada aparece. Sem seção no `CHANGELOG.md`.

## Afirmações de estado (item 16)

Só o que a F2 muda. Cada uma tem o comando que a produz hoje.

| Afirmação | Antes da F2 | Comando que a produz | Situação |
|---|---|---|---|
| `api_tokens.created_by` é obrigatório | `NOT NULL` no baseline | `grep -n "alter column created_by drop not null" supabase/baseline.sql` | Mudou: a linha 69230 solta o `NOT NULL`. A CHECK `api_tokens_dono_check` garante o dono. |
| Ativar ou desativar não cria nem revoga token | `fn_extensions_configure` não tocava `api_tokens` | `grep -n "fn_extensions_module_token_reserve(" supabase/baseline.sql` | Mudou: ativar reserva a vaga e desativar revoga. |
| O ator da API é sempre pessoa | o tipo `Actor` não tinha variante de módulo | `grep -n '"module"' lib/api/handlers/types.ts` e `grep -n 'type: "module"' lib/mcp/auth.ts` | Mudou: escopo `actor:module:<slug>` vira ator `module` (`lib/mcp/auth.ts`, linha 105). |
| Suspender a organização não revoga | `validateBearerToken` recusa com 403 `org_suspended` | `grep -n "org_suspended" lib/mcp/auth.ts` | **Mantida** (emenda 2 do plano): a F2 não revoga na suspensão. |
| Auditoria lista as ações do módulo | `docs/specs/extensoes-declarativas-v1.md`, linha 134, cita só `extension.switched` | `grep -n "secret_rotated\|token_issued" docs/specs/extensoes-declarativas-v1.md` (sai vazio) e `grep -n "extension.secret_rotated\|extension.token_issued" lib/audit/actions.ts` | **Falsa após a F2 e NÃO corrigida aqui:** a spec está fora do escopo desta entrega (o plano manda não mexer na spec). Corrigir no PR da spec: acrescentar `extension.secret_rotated` e `extension.token_issued` à linha 134. |
| Versão da API do host | `HOST_API_VERSION = 2` | `grep -n "HOST_API_VERSION =" lib/extensions/manifest.ts` | Mantida. |
| Chave de cifra existe | `AI_CRED_AES_KEY` já era usada | `grep -n "AI_CRED_AES_KEY" .env.example lib/env.ts` | Mantida; a F2 não cria env. |
| Rota pública da busca | não existia | `grep -n "extensions/token" lib/auth/public-paths.ts` | Nova: o único caminho público desta fase. |

## O que NÃO foi medido

- **Nada foi executado nesta máquina.** Nenhum `pnpm`, `vitest`, typecheck, lint, build, Docker ou
  Playwright. O veredito de cada tarefa é o CI do PR interno.
- **As migrations 9117 e 9118 e o apêndice do baseline não foram aplicados** em nenhum Postgres. A ordem
  das recusas em `fn_extensions_module_token_rotate` e a reconferência do teto quando a linha estava
  expirada nunca rodaram.
- **O fluxo ponta a ponta com um módulo real não foi exercido.** Nenhum módulo `connected` existe no
  laboratório (ver J67.1), então nenhuma busca real saiu de um módulo assinando com o segredo.
- **A concorrência entre buscas só é provada pelos invariantes de banco** (`tests/invariants/
  extensoes-token-modulo-funcoes.test.ts`). Nenhuma jornada em tela cobre duas buscas ao mesmo tempo.
- **Mensagem de chave de cifra ausente na tela** não foi conferida: não se sabe se o operador vê o motivo
  ou só a falha genérica da instalação.
- **Linha "Módulo <slug>" antes da primeira busca** (a vaga reservada) não foi vista em tela; a afirmação
  de que ela ainda não tem texto utilizável é previsão do desenho, não medição.
- **Nenhuma jornada em navegador.** J68 é especificação: os casos estão com "NÃO EXECUTADO" e nenhum abriu
  `/admin/extensoes` nem `/app/settings/api-tokens`.
- **`lib/database.types.ts` não foi regenerado.** O arquivo não está no diff da F2
  (`git diff --name-only f88438ad8 30a87a43a -- lib/database.types.ts` sai vazio), então os tipos gerados
  não conhecem as colunas nem as tabelas novas.
- **Spec 33 e o plano não foram alterados**, como o plano pede. A linha 134 da spec v1 ficou falsa (ver a
  tabela acima).
- **Espelho `.claude/skills` não regenerado.** A F2 não tocou o guia `deskcomm-extensao`, então
  `pnpm skills:sync` não é exigido por esta entrega.
- **Sistema Vivo da F1 não conferido no plano dela.** O plano da F1 não está nesta worktree; o molde usado
  foi `evidence/modulo-conectado-f1/declaracoes.md`.
