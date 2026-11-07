# Módulo conectado — F1: o perfil `connected` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O manifesto, o catálogo e o banco aceitam um módulo `connected` (serviço externo), com a origem do serviço no catálogo revisado e um interruptor, por instalação, que desliga o módulo sem desinstalar.

**Architecture:** É a mesma forma que o perfil `data` teve na 0611: um perfil novo no Zod e em `fn_extensions_finish_install`, vocabulário novo de permissões (as áreas), e nenhuma chave nova no manifesto (as treze chaves ficam). O endereço do serviço mora só na ENTRADA do catálogo, nunca no pacote. O interruptor segue o molde de `fn_extensions_remove_installation` (recibo idempotente, revisão da instalação, `applied_now`).

**Tech Stack:** TypeScript, Zod, Postgres (`baseline.sql` + migration), Next.js route handlers, vitest.

**Spec:** `docs/specs/33-spec-modulo-conectado.md`, seção F1 (e D8). Plano-irmão: `…-00-indice.md`. A F1 não depende da R.

## Global Constraints

- `ExtensionManifest` continua com as treze chaves (`format_version … contributions`); a lista exata está no Zod e em `fn_extensions_finish_install`. Nenhuma chave nova.
- O manifesto não tem URL (ADR-0003 D3). O endereço do serviço é `service_origin`, só na entrada do catálogo.
- `service_origin`: origem exata, HTTPS, sem credencial, caminho, query ou fragmento; endereço especial recusado; exceção só no loopback de laboratório (mesma regra de `lib/extensions/download.ts`).
- Zero módulos continua sendo um estado completo (não-negociável 1): nada aqui aparece sem um módulo `connected` instalado.
- Schema sai em tripla: migration em `supabase/migrations/`, apêndice idempotente em `supabase/baseline.sql`, linha `-- manifest:` no cabeçalho. Número da migration por `pnpm checar:colisao-de-migration`, nunca pelo último arquivo.
- Todo `t("literal")` novo entra no dicionário (`lib/i18n/dicionario.ts` e `traducoes/*.json`); o gate `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` reprova o literal sem tradução.
- Função nova em `public` (a do interruptor) termina com `revoke execute ... from public, anon, authenticated;` e `grant execute ... to service_role;`, igual a `fn_extensions_remove_installation` (baseline linhas 28702 e 28711). `create or replace` das três funções existentes mantém os grants. Vigia: `tests/invariants/hardening-definer-varredura.test.ts` (CLAUDE.md, Migrations, item 9).
- Apêndice do baseline em bloco rotulado `-- ---- <coisa> (migration NNNN) ----`, idempotente e auto-curativo; constraint nova só depois de corrigir os dados (item 6 e 8). Antes de empurrar, validar `install` e `update` do baseline num Postgres descartável: isso roda no CI (`invariants`), não aqui.
- Mutação nova (o interruptor) grava auditoria: a ação `extension.switched` entra na lista de `lib/audit/actions.ts`, ao lado de `extension.removed` (linha 933).
- Definition of Done (CLAUDE.md): itens 13 (checklist do Sistema Vivo), 16 (afirmações de estado) e 18 (destino) estão na Task 6, não são opcionais.
- Nada roda nesta máquina: o veredito de cada tarefa é o CI do fork.

## Decisão registrada: a F1 NÃO sobe `HOST_API_VERSION`

A spec diz "a versão da API do host sobe". Medido em `main`: `HOST_API_VERSION = 2` (`lib/extensions/manifest.ts:138`) e os três pacotes oficiais (`extensoes/pacotes/deskcomm/*.json`, `extensoes/catalogo.json`) declaram `host_api: {min: 2, max: 2}`. `checkCompatibility` devolve `host_api_unsupported` quando `max < HOST_API_VERSION`: subir para 3 suspenderia os três pacotes oficiais em toda instalação, inclusive nas já instaladas (o artefato é imutável). Um perfil novo não muda o que os pacotes existentes fazem, então não exige subir. "Manifesto `connected` em host antigo é recusado com `profile_unsupported`" já vale sem bump: o host antigo não tem `connected` na lista de perfis. Um módulo `connected` declara `host_api: {min: 2, max: 2}`. A subida fica para quando um contrato mudar de fato (F6) e junto com novas versões dos pacotes oficiais. Efeito colateral bom: some o conflito de número com o PR rascunho #3477. **A spec é emendada no mesmo PR (Task 6).** O Paulo confirma isto antes de a F1 ir ao Rafael.

## Review Focus

1. Pacote `connected` que declara `navigation.*`, `theme.apply` ou `dados.proprios`: recusa no Zod e no banco, com a mesma resposta (Task 2 e Task 4).
2. `service_origin` com `http://` fora do laboratório, `localhost`, IP privado (`10.0.0.1`, `[::1]`), usuário e senha, caminho, barra final ou fragmento: recusa na admissão do catálogo (Task 3).
3. Entrada de catálogo de pacote `declarative` ou `data` que traz `service_origin`: recusa na instalação, para ninguém pôr endereço de serviço em pacote que não é conectado (Task 4).
4. Interruptor em instalação que não é `connected`, em instalação removida, com revisão velha e repetido com o mesmo recibo (Task 5).
5. A lista de permissões do TypeScript e a do banco divergirem: o teste de espelho cobre as 26 (Task 1 e Task 4).

---

### Task 1: O vocabulário das áreas

**Files:**
- Create: `lib/extensions/areas.ts`, `lib/extensions/areas.test.ts`
- Modify: `lib/extensions/capacidades.ts` (lista `EXTENSION_PERMISSIONS`), `lib/extensions/portas-legiveis.ts` (`NOME_DA_PORTA`, `portasLegiveis`), `lib/i18n/dicionario.ts`, `lib/i18n/traducoes/*.json`, `experiments/extensoes/catalog/catalog.py` (lista `PERMISSOES`)
- Test: `tests/unit/catalogo-de-ensaio-espelha-o-vocabulario.test.ts` (já existe; passa a cobrir as 26)

**Interfaces:**
- Produces: `EXTENSION_AREAS` (tupla `as const`: `contatos, negocios, conversas, agenda, funis, agentes_ia, catalogo, configuracao, analise`); `type ExtensionArea`; `permissaoDaArea(area: ExtensionArea, modo: "leitura" | "escrita"): ExtensionPermission`; `ehPermissaoDeArea(p: ExtensionPermission): boolean`. As permissões novas têm a forma `area.<área>.<leitura|escrita>` (18 novas, 26 no total) e F3 as consome.

- [ ] **Step 1: Write the failing test** em `lib/extensions/areas.test.ts`: (a) para cada área e cada modo, `permissaoDaArea` devolve um valor presente em `EXTENSION_PERMISSIONS`; (b) o conjunto `EXTENSION_PERMISSIONS.filter(ehPermissaoDeArea)` tem exatamente 18 elementos e é igual ao produto `EXTENSION_AREAS × {leitura, escrita}`; (c) toda permissão tem nome em `nomeDaPorta`.
- [ ] **Step 2: Run** `pnpm vitest run lib/extensions/areas.test.ts` — Expected: FAIL (módulo inexistente). *(Nesta máquina: só o CI roda; este passo vira "conferir no CI".)*
- [ ] **Step 3: Implement** `areas.ts` e as 18 entradas literais em `EXTENSION_PERMISSIONS` (tupla escrita por extenso, porque `z.enum` precisa do tipo literal), com um comentário apontando F3 como dona do significado. Em `portas-legiveis.ts`, `NOME_DA_PORTA` ganha "Contatos (leitura)", "Contatos (escrita)" e as demais; `portasLegiveis` trata as permissões de área à parte, como já faz com `dados.proprios`: a frase de área não diz "abre" (módulo conectado não abre tela do CRM), diz "Lê {áreas}" e "Altera {áreas}", montada com o molde traduzido e cada nome traduzido separadamente (o gate de espanhol varre literais).
- [ ] **Step 4: Atualizar `catalog.py` (`PERMISSOES`) na mesma ordem do TypeScript** e confirmar que `catalogo-de-ensaio-espelha-o-vocabulario.test.ts` compara as 26.
- [ ] **Step 5: Run no CI** `verify-parte` — Expected: PASS, incluindo `i18n-espanhol-cobre-a-tela`.
- [ ] **Step 6: Commit** `feat(extensoes): vocabulario das areas do modulo conectado`.

### Task 2: O manifesto aceita `connected`

**Files:**
- Modify: `lib/extensions/manifest.ts` (tipo `ExtensionManifest.profile` na linha 59, `profile: z.enum` na 279, `.superRefine` das 341–363, `checkCompatibility` na 567)
- Test: `lib/extensions/manifest.test.ts`

**Interfaces:**
- Consumes: `ehPermissaoDeArea` (Task 1).
- Produces: `ExtensionManifest.profile` passa a `"declarative" | "data" | "connected"`; `checkCompatibility` aceita os três.

- [ ] **Step 1: Write the failing tests** em `manifest.test.ts`, com um manifesto `connected` válido de base (`data: {mode:"none"}`, `configuration: {}`, `contributions: {}`, `permissions: ["area.contatos.leitura"]`, `host_api: {min:2,max:2}`): aceito; recusado se tiver `navigation.tasks`, `theme.apply` ou `dados.proprios` em `permissions`; recusado sem nenhuma permissão de área (o schema já exige `min(1)`, o teste afirma a mensagem); recusado com `contributions.crm_cards`; recusado com `configuration` com `density`; recusado com `data.mode === "declarado"`; e `checkCompatibility` devolve `{compatible: true}` para ele e continua devolvendo `profile_unsupported` para `"outro"`. Um manifesto `declarative` com `area.*` em `permissions` é recusado (a lista de portas de um guia não ganha área de carona).
- [ ] **Step 2: Run** `manifest.test.ts` — Expected: FAIL (perfil `connected` rejeitado pelo enum).
- [ ] **Step 3: Implement.** `profile` ganha `"connected"` no tipo, no enum e na lista de `checkCompatibility`. No `.superRefine` entra o ramo `connected` com as seis regras do passo 1 e a regra espelho nos outros dois perfis. Não tocar `HOST_API_VERSION`.
- [ ] **Step 4: Run no CI** — Expected: PASS em `manifest.test.ts` e nos testes que importam o schema.
- [ ] **Step 5: Commit** `feat(extensoes): o manifesto aceita o perfil connected`.

### Task 3: A origem do serviço na entrada do catálogo

**Files:**
- Modify: `lib/extensions/manifest.ts` (`catalogEntrySchema`, linha 382, e `CatalogEntry`), `lib/extensions/download.ts` (nova função exportada ao lado de `validateCatalogOrigin`, linha 68), `lib/extensions/service.ts` (admissão do catálogo, ~linha 670)
- Create: `lib/extensions/servico-do-modulo.ts`, `lib/extensions/servico-do-modulo.test.ts`
- Test: `lib/extensions/download.test.ts`, `lib/extensions/manifest.test.ts`

**Interfaces:**
- Produces: `CatalogEntry.service_origin?: string`; `assertServiceOrigin(origin: string, policy: DownloadPolicy): void` (lança `ExtensionError("extension_invalid_package")`); `servicoDoModulo(snapshot: ExtensionCatalog, publisher: string, name: string, version: string): string | null`, que F2 e F4 usam para achar o endereço.

- [ ] **Step 1: Write the failing tests.** `download.test.ts`: `assertServiceOrigin` aceita `https://modulo.exemplo.com`; recusa `http://modulo.exemplo.com`, `https://user:senha@modulo.exemplo.com`, `https://modulo.exemplo.com/caminho`, `https://modulo.exemplo.com/x`, `https://modulo.exemplo.com?q=1`, `https://modulo.exemplo.com#f`, `https://localhost`, `https://10.0.0.1`, `https://[::1]`; o loopback de laboratório só passa com a política local ligada. `manifest.test.ts`: entrada com `service_origin` válido passa no `catalogSchema`; `service_origin` fora da forma de origem exata não passa. `servico-do-modulo.test.ts`: devolve a origem da entrada certa e `null` para entrada sem o campo ou inexistente.
- [ ] **Step 2: Run** — Expected: FAIL (função e campo inexistentes).
- [ ] **Step 3: Implement** `assertServiceOrigin` reutilizando `parseExactOrigin`, `isAllowedLocalOrigin` e as checagens de `validateCatalogOrigin` (extrair o miolo em função comum em vez de copiar). `catalogEntrySchema` ganha `service_origin: z.string().refine(isExactOrigin).optional()`; a admissão em `service.ts` chama `assertServiceOrigin` para cada entrada que a tem, com a mesma política de `assertCatalogOrigin`.
- [ ] **Step 4: Run no CI** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(extensoes): origem do servico na entrada do catalogo`.

### Task 4: O banco aceita `connected` (tripla de migration)

**Files:**
- Create: `supabase/migrations/<timestamp>_<NNNN>_modulo_conectado_perfil.sql` (NNNN por `pnpm checar:colisao-de-migration`), `tests/invariants/extensoes-conectado.test.ts`
- Modify: `supabase/baseline.sql` (apêndice idempotente no fim; vale a ÚLTIMA definição de cada função), `lib/database.types.ts` só se alguma assinatura mudar (as três funções mantêm a assinatura)

**Interfaces:**
- Consumes: formas atuais de `fn_extensions_permissoes_validas` (baseline linha 49016), `fn_extensions_admit_catalog` (32533) e `fn_extensions_finish_install` (49033).
- Produces: as três funções, redefinidas com `create or replace`: (a) `permissoes_validas` aceita as 26 permissões (teto de 1 a 26, sem repetição); (b) `admit_catalog` aceita a chave `service_origin` na entrada, com o mesmo regex de `origin` (`^https?://[^/@?#[:space:]]+$`); (c) `finish_install` aceita `profile = 'connected'` com as regras do Task 2 e exige `(profile = 'connected') = (v_op.entry ? 'service_origin')`.

- [ ] **Step 1: Write the failing invariant** (Postgres real do `baseline.sql`, no molde de `tests/invariants/modulo-de-dados-compilador.test.ts`): admitir um catálogo com uma entrada `connected` + `service_origin` e instalar um manifesto `connected` válido passa; manifesto `connected` com `navigation.tasks` é recusado com `extension_artifact_mismatch`; `connected` sem `service_origin` na entrada é recusado; `declarative` com `service_origin` na entrada é recusado; `service_origin` com caminho, `@` ou espaço é recusado na admissão com `extension_invalid_input`; `permissoes_validas` aceita as 26 e recusa uma 27ª e uma repetida.
- [ ] **Step 2: Sabotagem prevista** (feita no CI numa branch descartável): tirar a igualdade `(profile = 'connected') = (v_op.entry ? 'service_origin')` e ver o caso "declarative com service_origin" ficar vermelho; N de M previsto antes de rodar.
- [ ] **Step 3: Implement** a migration idempotente (só `create or replace function`, sem BEGIN/COMMIT e sem tabela temporária), com `-- manifest:` na linha 1 e o apêndice no baseline copiando as três funções. Reconferir, com `git grep`, qual é a última definição de cada uma no baseline.
- [ ] **Step 4: Run no CI** `invariants` — Expected: PASS, e `invariants` antigos (`extensoes-declarativas`, `modulo-de-dados-compilador`) continuam verdes.
- [ ] **Step 5: Commit** `feat(extensoes): o banco aceita o perfil connected e a origem do servico`.

### Task 5: O interruptor da instalação (D8)

**Files:**
- Create: `supabase/migrations/<timestamp>_<NNNN>_modulo_conectado_interruptor.sql`, `app/api/v1/extensions/[id]/switch/route.ts`, `tests/invariants/extensoes-interruptor.test.ts`
- Modify: `supabase/baseline.sql` (apêndice), `lib/database.types.ts` (assinatura nova, na forma de `fn_extensions_remove_installation`, linha 15600), `lib/extensions/service.ts` (nova `switchExtension`, ao lado de `removeExtension`, linha 946), `lib/extensions/requests.ts` (schema do corpo), `lib/extensions/view.ts` (campo `disabled_at`), `lib/audit/actions.ts` (ação `extension.switched`), `app/admin/(protected)/extensoes/page.tsx` (selecionar `disabled_at`), `components/extensions/ExtensionsManager.tsx` e `components/extensions/InstalledExtensionCard.tsx` (botão e aviso; o cartão é onde `extension.removed` já aparece), dicionário de i18n
- Test: `lib/extensions/service.test.ts`, `components/extensions/ExtensionsManager.test.tsx`

**Interfaces:**
- Produces (banco): `extension_installations.disabled_at timestamptz`, `disabled_by uuid references auth.users(id) on delete set null`, CHECK `disabled_by is null or disabled_at is not null`; `kind` `'switch'` na CHECK de `extension_operations` (reler a CHECK vigente antes de reescrever, porque a 0611 já a ampliou); `fn_extensions_set_switch(p_actor uuid, p_operation uuid, p_installation uuid, p_disabled boolean, p_expected_installation_revision integer) returns jsonb`, no molde de `fn_extensions_remove_installation` (assert do ator, travas, recibo por impressão digital, `applied_now`), que recusa instalação removida (`extension_removed`), revisão velha (`extension_version_changed`) e artefato que não é `connected` (`extension_switch_not_applicable`), e incrementa a revisão da instalação.
- Produces (TypeScript): `switchExtension(actorId: string, operationId: string, installationId: string, input: { expected_installation_revision: number; disabled: boolean }): Promise<ExtensionOperationView>`; `POST /api/v1/extensions/[id]/switch` com o mesmo portão de `remove/route.ts` (`requireExtensionPlatform`, `requireSupportWrite`, chave de operação) e auditoria `extension.switched` com `{operation_id, disabled}`.

- [ ] **Step 1: Write the failing tests.** Invariante: desligar um `connected` grava `disabled_at`, incrementa a revisão e devolve `applied_now: true`; repetir o mesmo recibo devolve `applied_now: false` sem mexer na revisão; recibo igual com corpo diferente dá `extension_idempotency_conflict`; revisão velha dá `extension_version_changed`; instalação `declarative` dá `extension_switch_not_applicable`; instalação removida dá `extension_removed`; ligar de novo zera `disabled_at`. `service.test.ts`: `switchExtension` chama a RPC com os quatro parâmetros e audita só quando `applied_now`. Componente: a linha de um módulo `connected` desligado mostra o aviso "Desligado nesta instalação" e o botão "Ligar"; módulo declarativo não mostra o botão.
- [ ] **Step 2: Sabotagem prevista:** trocar `extension_switch_not_applicable` por aceitar qualquer perfil e ver o caso do `declarative` ficar vermelho; remover o incremento da revisão e ver o caso da revisão velha ficar vermelho.
- [ ] **Step 3: Implement** a migration (tripla; a RPC termina com o `revoke ... from public, anon, authenticated` e o `grant ... to service_role` da Global Constraints; teste: a função aparece sem `anon` nem `public` nas permissões de execução), a RPC, o serviço, a rota, o schema de corpo em `requests.ts` e a UI, no molde de `remove`. Esta tarefa NÃO faz token, grupo nem `/app/m`: ela guarda e mostra o estado. A F2 e a F4 leem `disabled_at`.
- [ ] **Step 4: Run no CI** — Expected: `verify`, `invariants` e `e2e` (este só roda em PR contra `main`; usar o PR ao upstream como portão) verdes.
- [ ] **Step 5: Commit** `feat(extensoes): interruptor local do modulo conectado`.

### Task 6: A prova, a spec emendada e o fragmento de release

**Files:**
- Modify: `docs/specs/33-spec-modulo-conectado.md` (F1: tirar "a versão da API do host sobe" e registrar a decisão de não subir com a medição acima), `docs/testing/user-journey-map.md` (jornada nova), `docs/architecture/extensoes-declarativas.architecture.json` (nó do perfil e do interruptor, como manda a doutrina)
- Create: `.changes/<fragmento>.md` com `capacidade_nova`; `evidence/modulo-conectado-f1/` com a saída do CI e as sabotagens

**Interfaces:** nenhuma nova.

- [ ] **Step 0: Declarações do Definition of Done** (vão no corpo do PR e em `evidence/modulo-conectado-f1/declaracoes.md`):
  - **Destino (item 18): infraestrutura da plataforma de extensões.** Pergunta-raiz: sem nenhum módulo `connected` instalado, a operação comum continua inteira, porque o perfil, o campo `service_origin` e o botão só existem com um módulo conectado. Se o mantenedor classificar como "ambos", pede o consumidor real do ponto novo do núcleo; o consumidor é o primeiro módulo conectado, que a spec 33 descreve, e o PR não nomeia o privado (índice, passo 9).
  - **Tela nova (item 14): nenhuma.** O aviso e o botão entram em `/admin/extensoes`, que já tem porta em `lib/navigation/catalogo.ts`; conferir isso com `grep` no catálogo e registrar a saída.
  - **Env nova (item 9): nenhuma.**
  - **Living System Checklist (item 13)**, cada resposta nomeando o artefato:
    1. Quem me alimenta: a entrada do catálogo admitido por `fn_extensions_admit_catalog` e o pacote lido por `parseManifest`.
    2. Quem eu alimento: `fn_extensions_finish_install` (instala o perfil) e, depois, F2 e F4, que leem `disabled_at`. Declarar F2/F4 como consumidores futuros nomeados na spec 33, não como aresta presente.
    3. Registro que emito: `extension_operations` (recibo) e `api_audit_log` com `extension.switched`.
    4. Onde apareço: `InstalledExtensionCard` em `/admin/extensoes`.
    5. Porta: `/admin/extensoes` já no `NAV_CATALOG`.
    6. Anti-morte: nenhum, justificado: é estado de configuração, não demanda de pessoa.
    7. Onde se configura: o botão Ligar/Desligar da mesma tela; falha mostra o código da operação.
    8. Continuidade IA↔humano: não se aplica (nenhum agente passa por aqui).
    9. Laço de retorno: instalação `connected` desligada fica visível com data e responsável (`disabled_at`, `disabled_by`); o que muda no sistema é F2 recusar o token, e isso só vale depois da F2. Declarar como dívida da F2.
    10. Mapa: `docs/architecture/extensoes-declarativas.architecture.json` ganha o nó do perfil e do interruptor com ≥2 arestas.
  - **Afirmações de estado (item 16):** conferir, só sobre o que a F1 muda, `docs/specs/extensoes-declarativas-v1.md`, `docs/doctrine/extensoes.md` e a skill `.agents/skills/deskcomm-extensao` (a tabela "o que ela não faz" e o texto "o pacote é JSON declarativo"). Onde disserem que existem só os perfis `declarative` e `data`, trocar por um comando que mostre a lista (`grep -n 'profile: z.enum' lib/extensions/manifest.ts`). Se a skill mudar, rodar `pnpm skills:sync` e avisar no PR que a página de guias da LP acompanha.

- [ ] **Step 1: Escrever a jornada** (tela, banco fresco do `baseline.sql`, envs opcionais ausentes): admitir um catálogo de laboratório com uma entrada `connected`, instalar, ver a instalação em `/admin/extensoes` com o aviso de módulo conectado, desligar, ver "Desligado nesta instalação", ligar de novo; sem módulo conectado, a tela de extensões é a de hoje.
- [ ] **Step 2: Fragmento `.changes/`** com `capacidade_nova` e a frase do que muda para quem usa; nada de seção no CHANGELOG.
- [ ] **Step 3: Pré-voo** (`pre-voo.sh`, `pnpm checar:colisao-de-migration`, `pnpm release:conferir`) — só leem o git. Merge da `main` do Rafael antes de empurrar; zero conflito.
- [ ] **Step 4: Commit** `docs(extensoes): jornada, fragmento e spec 33 emendada para a F1`.

## Self-review

- **Cobertura da spec F1:** perfil no Zod e no banco (Tasks 2 e 4); manifesto sem URL e endereço no catálogo (Task 3); validação pela mesma regra do download (Task 3); áreas e rótulo/ícone da lista existente (Task 1 e `display` do manifesto, que já tem `icon`); versão da API (decisão registrada, não implementada, com motivo medido); recusa em host antigo (vale sem bump); interruptor D8 (Task 5), com o "token recusa" e o "grupo some" ficando para F2 e F4 por dependerem delas.
- **Nomes:** `permissaoDaArea` e `ehPermissaoDeArea` (Task 1) são usados nas Tasks 2 e 4; `assertServiceOrigin` e `servicoDoModulo` (Task 3) são usados em `service.ts`; `switchExtension` e `fn_extensions_set_switch` (Task 5) têm o mesmo nome na rota, no serviço e nos testes.
- **Não medido:** o conteúdo atual da CHECK de `kind` depois da 0611 (a Task 5 manda reler); se `lib/i18n/traducoes/` tem um arquivo por idioma ou só `tr.json` e `es.json` (a Task 1 diz `*.json` de propósito); se algum e2e antigo afirma o texto da tela de extensões que o aviso novo altera.
