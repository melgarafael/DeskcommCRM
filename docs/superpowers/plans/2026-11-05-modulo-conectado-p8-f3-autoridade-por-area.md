# Módulo conectado (Spec 33) — F3: autoridade por área — plano de implementação

> **Para quem executa:** um agente por tarefa, na ordem; quem escreve não valida; o Claude lê o diff e o CI julga. Leia antes: `CLAUDE.md` da `origin/main`, skill `deskcomm-doutrina`, `docs/doctrine/extensoes.md`, Spec 33 (F3 e decisões 1, 5), planos p5 (F1) e p7 (F2) e `docs/superpowers/plans/2026-11-03-modulo-conectado-p6-r-classificacao-final.md` (o que ficou de sessão e por quê).

**Meta:** um token de módulo só alcança, em cada organização, as áreas que o pacote DECLAROU **e** a organização CONSENTIU, com o papel efetivo `min(teto do token, papel atual da pessoa)`. Tudo aplicado num único ponto (`resolveAuthDual`), mais o fechamento das duas outras entradas que aceitam `dsk_`.

**Base:** branch `feat/modulo-conectado-f3`, nasce de `feat/modulo-conectado-f2`. PR interno contra a F2.

## Medido em 05/11/2026

| Fato | Onde | Consequência |
|---|---|---|
| Só 3 arquivos chamam `validateBearerToken`: `lib/api/auth-dual.ts`, `app/api/v1/contacts/route.ts`, `app/api/mcp/route.ts` | grep | **Risco que a spec não vê:** o servidor MCP e `contacts/route.ts` aceitam qualquer `dsk_` e leem pelos escopos do token; um token de módulo (`mcp:read`) leria tudo por ali, **sem passar pela área**. A Tarefa 3 fecha as duas entradas para ator `module` e uma cerca varre que nenhuma outra apareça. |
| O token de módulo da F2 nasce com `mcp:read`, `role:viewer`, `actor:module:<slug>` e **não carrega áreas** | migration 9118 | As áreas efetivas NÃO podem morar no token: consentimento mudado tem de valer na hora. `resolveAuthDual` lê o vínculo a cada requisição. |
| Permissões `area.<área>.<leitura\|escrita>` já existem no manifesto `connected` (26 permissões) | F1: `lib/extensions/areas.ts`, `capacidades.ts` | "Declarado" = as `area.*` do manifesto do artefato da instalação. |
| `organization_extensions.configuration` é fechada (só `density`, `show_description`) por CHECK | baseline ~28040 | O consentimento NÃO entra em `configuration`; ganha **coluna própria** `consented_areas text[]`. |
| Portas de token por modelo e método: `lib/auth/portas-de-token/{configuracao,operacao,leitura}.ts` | R | O mapa de área é uma tabela única por modelo de porta, e um teste exige que **toda** porta tenha área ou esteja na lista "nunca há área". |
| `fn_extensions_configure` tem limite de 8 ativas e revisão otimista | baseline | O consentimento é função separada (`fn_extensions_set_consent`), com a mesma revisão. |
| Decisão 5 da spec: `configuracao` e `agentes_ia` só por quem **administra a organização** | spec | A função confere o papel do ator na organização. |

## Global Constraints

- Tripla de migration (timestamp posterior a `20261105110000`, NNNN por `pnpm checar:colisao-de-migration` lendo a regra no script, apêndice no baseline antes da VARREDURA anon, `-- manifest:`). Função nova: `revoke … from public, anon, authenticated` + `grant … to service_role`.
- O segredo, o token e o JWT nunca vão a log, audit ou recibo.
- Sem token de módulo ativo, **nada muda** para sessão nem para token de pessoa: um teste compara a resposta de uma amostra de rotas antes/depois.
- Zero módulos continua estado completo.
- A F3 **não** libera rota nova: o conjunto alcançável é o que a R converteu menos a lista "nunca há área" da spec.

## Mapa de áreas (decisão do engenheiro, 05/11; revisável pelo Paulo)

Regra de classificação por **prefixo de rota** (modelo de porta), `GET` = `leitura`, `POST|PUT|PATCH|DELETE` = `escrita`:

| Área | Prefixos |
|---|---|
| `contatos` | `contacts`, `tags`, `companies`, `segments` |
| `negocios` | `leads`, `deals`, `proposals`, `lead-captures`, `forecast` |
| `conversas` | `conversations`, `messages/[id]/hide` (a ocultar), `notes`, `handoffs` |
| `agenda` | `agenda`, `appointments`, `attendants/sectors` quando for agenda; `attendants/*` em `configuracao` |
| `funis` | `pipelines` (funil, etapas, previsão), `automation-rules` (leitura) |
| `agentes_ia` | `ai/*` (skills, estilo, guardrails, roteamento, memória, follow-up, casos) |
| `catalogo` | `products`, `services`, `catalogo`, `message-templates`, `financeiro/catalogo` |
| `configuracao` | `settings/*` (menos `api-tokens`, `assinatura`, `art15`), `attendants/*`, `team` (leitura apenas), `routing` |
| `analise` | `metrics/*`, `reports/*`, `financeiro/lancamentos` (leitura), `honorarios` (leitura) |

Prefixos que não casam acima, ou financeiros de escrita, **não têm área** e recusam módulo (por padrão, "recusa por falta de área" é o lado seguro). O financeiro NÃO ganha área nesta fase: escrita de `financeiro/*` e `honorarios/*` fica fora do alcance de módulo até o Paulo decidir uma área própria.

Papel mínimo: `configuracao` e `agentes_ia` exigem que o **consentimento** seja dado por quem administra a organização (decisão 5). O papel efetivo da chamada é definido na Tarefa 4.

## Review Focus

1. Token de módulo + rota **sem** área ⇒ 403 (o conjunto de portas sem área é só o permitido pela lista).
2. Módulo consentido só em `contatos.leitura`: `GET /contacts` passa, `POST /contacts` 403, `GET /pipelines` 403.
3. Consentimento retirado entre duas chamadas: a segunda recusa (nada em cache entre requisições).
4. Pacote declara `area.contatos.escrita` mas a organização aceitou só leitura ⇒ escrita recusa; consentir área que o pacote NÃO declarou é recusado pela função.
5. Token de módulo no endpoint MCP e em `contacts/route.ts` ⇒ 403; token de pessoa continua igual.
6. Pessoa removida da organização com JWT ainda válido ⇒ 403 (papel lido do banco, não do JWT).
7. JWT de outra organização/instalação, vencido, assinado por outra chave ⇒ 403.
8. Acompanhamento de suporte: toda escrita de módulo recusa, lido no servidor.
9. Rota nova adicionada às portas depois da F3 sem área ⇒ o teste de varredura quebra.

## Tarefa 1 — Consentimento (schema + função)

**Arquivos:** migration `…_NNNN_modulo_conectado_consentimento.sql` (+ apêndice), `tests/invariants/extensoes-consentimento.test.ts`.

- `alter table public.organization_extensions add column if not exists consented_areas text[] not null default '{}'` + CHECK `consented_areas <@ array[<26 permissões area.*>]` (lista copiada de `lib/extensions/areas.ts`, e um teste de invariante garante igualdade com o TypeScript).
- `fn_extensions_set_consent(p_actor uuid, p_organization uuid, p_installation uuid, p_expected_revision integer, p_areas text[]) returns jsonb`: ator precisa administrar a organização (`fn_extensions_assert_actor`); instalação `connected` e não removida; `p_areas` ⊆ `area.*` **declaradas** no manifesto do artefato (`PT409`/`extension_area_not_declared` se não); `configuracao.*` e `agentes_ia.*` só se o ator for `admin`/`owner` da organização; revisão otimista como `configure`; grava, incrementa `revision`. Retirar uma área vale imediatamente.
- Invariantes: viewer/agent/manager não consentem `configuracao`; área não declarada recusa; revisão velha recusa; org A não consente instalação ativada só na B; a função não é executável por `authenticated`.

## Tarefa 2 — Mapa de áreas (TypeScript)

**Arquivos:** `lib/auth/portas-de-token/areas.ts` (+ teste), os três arquivos de portas (só leitura).

- `export function areaDaPorta(modelo: string, metodo: string): { area: ExtensionArea; modo: "leitura" | "escrita" } | null` — pelas regras do mapa acima, por prefixo do modelo de porta.
- `export const PORTAS_SEM_AREA_POR_DESENHO: readonly string[]` — a lista "nunca há área" da spec e as de sessão por desenho, com o motivo escrito em comentário.
- **Teste de varredura:** para cada modelo de porta de `MODELOS_DA_CONFIGURACAO | OPERACAO | LEITURA` e cada método, `areaDaPorta` devolve área OU o modelo está em `PORTAS_SEM_AREA_POR_DESENHO`; qualquer porta nova sem classificação reprova. O teste imprime a lista de portas **sem** área para o Paulo conferir (nenhuma deve ser leitura inócua por esquecimento).

## Tarefa 3 — Aplicação central e fecho das outras entradas

**Arquivos:** `lib/api/auth-dual.ts` (+ teste), `app/api/mcp/route.ts`, `app/api/v1/contacts/route.ts`, `lib/auth/modulo-autorizado.ts` (+ teste), teste-cerca `tests/unit/token-de-modulo-so-entra-pelo-portao.test.ts`.

- `autorizarModulo({ organizationId, installationId, metodo, modeloDaPorta }): Promise<{ ok: true } | { ok: false; codigo }>`: lê (admin client, filtros explícitos) `organization_extensions` + `extension_installations.disabled_at/removed_at` + manifesto declarado; calcula `declaradas ∩ consented_areas`; exige `enabled`, instalação não desligada/removida, área da porta nesse conjunto no modo certo.
- `resolveAuthDual`: quando o ator do token é `module`, chama `autorizarModulo` **antes** do papel/escopo e devolve 403 com código estável (`module_area_not_granted`, `module_disabled`) e mensagem em português; o `organizationId` vem da linha do token. Sem a porta conhecida, recusa.
- `app/api/mcp/route.ts` e `contacts/route.ts`: ator `module` ⇒ 403 `module_token_not_allowed_here`.
- **Cerca:** só `auth-dual.ts`, `mcp/route.ts` e `contacts/route.ts` podem importar/chamar `validateBearerToken`/`resolveApiToken`, e os dois últimos têm a recusa de `module`; arquivo novo que chame reprova.
- Testes: os 9 pontos do Review Focus 1, 2, 3, 5 e 9 com banco falso; comparação "sem módulo, nada muda".

## Tarefa 4 — Papel efetivo e JWT de contexto

**Arquivos:** `lib/modulo/jwt-de-contexto.ts` (+ teste), `app/api/v1/extensions/[id]/contexto/route.ts` (+ teste), `lib/env.ts`, `.env.example`, `lib/api/auth-dual.ts`.

- Chave **assimétrica** do host (ES256 via `jose`, já dependência): `MODULE_JWT_PRIVATE_KEY` (PEM, opcional). Ausente ⇒ a rota responde 503 com mensagem clara e o módulo fica com teto `agent` sem pessoa (spec). Env nova entra em `.env.example` e `lib/env.ts` como opcional.
- Rota de **sessão** (`requireRole`, vale MFA, fora de `public-paths`) que entrega à tela `{ jwt, expires_at }`: claims `sub` (pessoa), `org`, `inst`, `exp` ≤ 5 min.
- `resolveAuthDual`: cabeçalho `X-Module-Context` opcional. Com JWT válido (assinatura, `exp`, `org` e `inst` iguais aos do token, pessoa **ainda membro** da organização — papel lido do banco agora) ⇒ papel efetivo `min(teto, papel_atual)`, com teto `manager` para token de módulo (acima de `agent` só com JWT; **`admin` nunca**: decisão do engenheiro, mais restritiva que a spec, porque `admin` mexe em equipe e segredo); sem JWT ⇒ teto `agent`. JWT inválido/vencido/de outra org ⇒ 403.
- Em acompanhamento de suporte, escrita de módulo ⇒ 403 (mesma regra de `requireSupportWrite`, lida no servidor).
- Testes: pontos 6, 7 e 8; papel efetivo `min`; pessoa rebaixada entre duas chamadas.

## Tarefa 5 — Tela de consentimento

**Arquivos:** `components/extensions/*` (ativação), rota `app/api/v1/extensions/[id]/consentimento/route.ts` (+ teste), `lib/extensions/portas-legiveis.ts`, i18n `es`, `en`, `tr`.

- Na ativação de um `connected`, lista as áreas **declaradas** em frases legíveis (as de `portas-legiveis.ts`), cada uma com caixa de seleção; `configuracao` e `agentes_ia` aparecem desabilitadas para quem não administra a organização, com o motivo. Salvar chama a rota, que chama `fn_extensions_set_consent` (revisão esperada; recibo/`Idempotency-Key` como a rota de configurar).
- Audit `extension.consent_changed` com as áreas (lista fechada, sem dado pessoal).
- Testes de componente e de rota (403 para quem não administra a organização; consentir área não declarada ⇒ 409).

## Tarefa 6 — Atribuição e fecho

- Audit de chamada de módulo: ator = token do módulo (F2), `metadata.person_id` = pessoa do JWT quando houver.
- `.changes/modulo-conectado-autoridade.md`, J69, mapa de arquitetura, `evidence/modulo-conectado-f3/declaracoes.md` (destino, 10 respostas do Sistema Vivo, o que NÃO foi medido), mesma forma da F1/F2.

## Fora desta fase

Eventos (F5), tela do módulo (F4), financeiro como área, token só-leitura de 30 dias (F5).

## Ordem e executores

1 (Sonnet) → 2 (Haiku, tabela mecânica; eu confiro a lista de portas sem área) → 3 (Sonnet, segurança) → 4 (Sonnet, segurança) → 5 (Sonnet) → 6 (Haiku). Um commit por tarefa; nada roda local; o CI do PR interno julga.
