# Fluxos de atendimento (port do #1130) — Plano de implementação

> **Para quem executa:** SUB-SKILL: superpowers:executing-plans (nativo) ou
> superpowers:subagent-driven-development. Passos em checkbox (`- [ ]`).

**Objetivo:** trazer os "fluxos de atendimento" do @vgamkt (PR #1130) — a IA conduz um
roteiro de perguntas durante a conversa, uma por vez, e guarda as respostas — como
**módulo opcional da instalação, desligado por padrão**, com os consertos que a prova
prática exigiu, em 4 PRs sequenciais.

**Arquitetura:** o roteiro é um grafo da máquina de follow-up que já existe
(`followup_flow_pointers`/`followup_flow_versions`), numa terceira superfície
`atendimento`. A execução é uma linha de `followup_enrollments` num status PRÓPRIO
(`coletando`), conduzida pelo TURNO do agente, não pelo relógio. As respostas vão para
`contacts.custom_fields`; a trilha vai para `followup_enrollment_events`, sem valores.
O motor entra no turno num único ponto, atrás da chave, depois das checagens de pedido
de humano e de opt-out.

**Stack:** Next.js 16 / TypeScript estrito / Postgres (Supabase) / Vitest / Zod.

**Fontes (leitura obrigatória antes de executar):**
- Despacho: `triagem/operacao/despachos/2026-09-23/port-fluxos-de-atendimento-1130.md` (repo principal).
- Prova prática (17 achados, com evidência): `triagem/operacao/prova-fluxos-1130.md`.
- Decisão do dono: docs 61 e 64 da pasta de decisões (opção (a), 23/09 17h30).
- Código do autor: `git fetch origin +pull/1130/head:refs/remotes/pr/1130`; os arquivos
  do motor são `lib/followup/atendimento.ts`, `lib/followup/captura-do-fluxo.ts`,
  `lib/agent-engine/agent/flow-validate.ts` e o trecho de fluxo de `inbound-turn.ts`.

## Restrições globais

- Chave: `platform_config.chave = 'MODULO_FLUXOS_DE_ATENDIMENTO'`, valor `ligado`/`desligado`;
  ausente ou erro de leitura = DESLIGADO (regra de `lib/instalacao/modulos.ts`).
- Desligado, nenhum caminho novo roda: o turno não lê roteiro, não chama o validador, não
  inicia nada; a API recusa criar fluxo `surface='atendimento'` (404, como o banco externo).
- Migrations `0394` (e `0395` só se preciso), carimbos > `20260923203100`. Toda mudança de
  schema = arquivo em `supabase/migrations/` + bloco idempotente no `baseline.sql` + linha no
  `MANIFEST.md`. CHECK de conjunto é editado NO bloco único que já o define
  (`tests/unit/baseline-constraint-reconstruida.test.ts`).
- Nenhuma tabela nova (DIRC abaixo). Nenhuma função nova exposta: toda função criada em
  `public` termina com `revoke ... from public, anon, authenticated`.
- Crédito: código do autor entra em commits com `--author="VANDER GUSTAVO ALVES
  <62725454+vgamkt@users.noreply.github.com>"`; a reescrita nossa em commits separados com
  `Co-Authored-By`/`Claude-Session`. Título de PR termina com "— de @vgamkt". Fragmento
  `.changes/` `capacidade_nova` com "Trabalho de @vgamkt, recortado do PR #1130." só no PR
  que liga a capacidade para quem opera (PR 3). PRs sem auto-merge.
- Nenhum valor respondido pelo cliente em log, em evento, em payload de job ou em
  `cancel_reason`. O único lugar do valor é `contacts.custom_fields`.
- Máquina sem Docker: `test:db` e e2e rodam no CI.

## Decisões de desenho (e por quê)

### D1 — O dado coletado vai para `contacts.custom_fields` (condição 2 do doc 61)

DIRC do que o PR criava em `contact_flow_data`:
- **Duplicar?** Não. O contato já tem `custom_fields` (jsonb objeto, CHECK
  `contacts_custom_fields_object`), exportado no pedido do titular
  (`lib/lgpd/export-collector.ts` seleciona a coluna) e **zerado pela anonimização nos dois
  caminhos** pelo gatilho `trg_contacts_anonimizado_limpa_custom_fields` (virada
  false→true de `is_anonymized`, que tanto o botão quanto o pedido formal fazem). A prova
  mediu o dano da tabela própria: o CPF morava em dois lugares (J2) e o botão não o apagava (J6).
- **Integrar?** Sim — chave do campo = chave em `custom_fields`. Dois roteiros que pedem
  "cidade" gravam a MESMA cidade do contato: isso é o desejado (uma verdade por contato), e
  o roteiro não repergunta o que o contato já tem.
- **Referenciar/Calcular:** "de qual roteiro veio" e "quando" ficam na trilha (D3), não no dado.
- O argumento do autor ("sem histórico por fluxo") é coberto pela trilha, que diz qual
  execução gravou qual chave, e quando.

### D2 — A execução é `followup_enrollments` com status NOVO `coletando`

O defeito que BLOQUEIA nº 3 (quem some no meio nunca recebe a retomada) vem de o roteiro
ocupar a vaga do índice `idx_followup_enrollments_one_live` (um vivo por contato na
organização, status `active|waiting_reply|paused_handoff|paused_manual`). E o autor pagou
a mesma classe cinco vezes (claim 0242, aplicar-inbound, silence-sweep, kick-local, três
pontos de cancelamento): todo código que lê `status in ('active','waiting_reply')` achava o
roteiro. Com status próprio o roteiro fica **fora por construção** de todos esses caminhos,
e ganha índice único próprio (`um roteiro coletando por contato`). O CHECK
`followup_enrollments_relogio_coerente` põe `coletando` no grupo SEM relógio — some o
`next_eval_at = '2999-12-31'` do autor. `completed`/`cancelled` continuam sendo os
terminais. Por que não uma coluna `surface` no enrollment: duplicaria o pointer e ainda
exigiria filtro em cada consulta — o status resolve os dois.

**D2b (acrescentado na execução).** Os produtores do relógio (gatilhos de etapa, lead,
caso, retorno, silêncio, o enroll manual) escolhem pointer pelo `trigger_config`, não pela
superfície. Um roteiro com gatilho de silêncio viraria enrollment `active` e o motor de
follow-up rodaria as perguntas. Gatilho `trg_enrollment_superficie_coerente` (BEFORE
INSERT/UPDATE de `status`/`pointer_id`) recusa com `23514` roteiro fora de
`coletando`/terminal e `coletando` fora de roteiro. O publish exige gatilho `manual` no
roteiro, e o enroll manual recusa roteiro com 422 legível. No relógio, `collect`/`skill`
seguem como passagem (código do autor): o publish e o gatilho já impedem que cheguem lá.

### D3 — A trilha vai para `followup_enrollment_events`, sem valores

`contact_flow_events` duplicava a tabela de eventos que o enrollment já tem.
`event_type` ∈ `roteiro_iniciado | roteiro_mensagem | roteiro_resposta |
roteiro_fora_do_fluxo | roteiro_tentativa | roteiro_pergunta_feita | roteiro_concluido |
roteiro_encadeou` (`EVENTOS_DO_ROTEIRO`), `node_id` = nó da pergunta, `payload` tipado
por `PayloadDoEvento` (`campo`, `origem`, `correcao`, `esgotadas`, `proximo_fluxo`) — sem
campo de valor. Esgotar vira `roteiro_concluido` com `esgotadas` e desfecho `exhausted`.
**Tentativas por pergunta = contagem de `roteiro_tentativa` por `campo`** (DIRC Calcular —
some a coluna `attempts`). Idempotência por mensagem: a primeira coisa do processamento é
reivindicar a mensagem com um evento `roteiro_mensagem` de `idempotency_key =
'roteiro_msg:<message_id>'` no índice único `(enrollment_id, idempotency_key)` que já existe;
um job reexecutado não consegue a chave e não reprocessa (achado do autor, 60bbe49b5).
Sem valor no payload, a trilha não é dado pessoal: a LGPD não precisa redigi-la.

### D4 — Sem síntese por IA e sem `completion_note` (decisão do titular, 23/09 ~20h)

O "passa-bastão" para o próximo roteiro e o resumo na tela são MONTADOS dos campos
(`montarResumoDoRoteiro`: rótulo → valor em `custom_fields`). Some a coluna com PII
(`completion_note`), o job `flow_summary` e +1 chamada de modelo por roteiro. Vai ao dono
como pergunta; pode voltar num PR posterior.

### D5 — Sem `flow_start` e sem `flow_collect` (decisão do titular + do próprio autor)

`flow_collect` (o modelo principal grava) virou no-op no próprio PR (9be39f83f: "validador
é a fonte única"). `flow_start` (a IA decide começar um roteiro) fica fora: as entradas são
palavra-gatilho e roteador de intenção. Vai ao dono como pergunta.

### D6 — Onde o motor entra no turno

`executarTurnoDoAgente` (`lib/agent-engine/agent/inbound-turn.ts`) já retorna cedo em:
lead em handoff humano (`isLeadInHandoff`), conversa não elegível, agente pausado ou
assistido, pedido explícito de humano (`detectHumanHandoffRequest`) e opt-out ambíguo
(`detectAmbiguousOptOut`). O motor entra **depois** desses retornos, e só quando:
`!preview && job.kind === 'inbound_turn' && !optedOutThisTurn && moduloLigado(...)`.
O início pelo ROTEADOR (que no PR rodava antes da checagem de pausa, l.~1901) passa para o
mesmo ponto. Isto fecha o achado 5 (roteiro aberto para quem pediu para parar) por ordem,
não por remendo. Toda a lógica mora num módulo novo, `lib/agent-engine/agent/roteiro-no-turno.ts`;
o turno ganha ~40 linhas: uma chamada antes do modelo, um bloco no sufixo, skills na união,
e a trava "a pergunta saiu?" depois do envio.

### D7 — A chave do módulo

`fluxos_atendimento` em `MODULOS_OPCIONAIS` (`lib/instalacao/modulos.ts`), linha
`MODULO_FLUXOS_DE_ATENDIMENTO` em `platform_config` (0341). Sem migration: o CHECK de
`platform_config.chave` é só de formato. O interruptor em `/admin/sistema` entra no PR 3,
junto com a tela que dá uso a ele — ligar antes disso não teria o que configurar.

### D8 — Roteador aponta roteiro com FK composta

`ai_router_members.flow_pointer_id` (0237 do autor) entra com
`foreign key (organization_id, flow_pointer_id) references followup_flow_pointers
(organization_id, id) on delete set null (flow_pointer_id)` — um membro não pode apontar
roteiro de outra organização (a FK simples permitiria). Exige índice único
`(organization_id, id)` em `followup_flow_pointers`.

### D9 — O que NÃO é portado (e por quê)

| Peça do #1130 | Destino |
|---|---|
| `contact_flow_data`, `contact_flow_events`, `completion_note`, job `flow_summary` (0236/0238/0239/0241/0243) | Substituídos por D1–D4 |
| 0240/0243 (cascata LGPD redefinida) | Desnecessárias: nada com PII ficou fora de `custom_fields`. Evita ressuscitar cascata velha |
| 0242 (claim nunca pega atendimento) + filtros em aplicar-inbound/sweep/kick-local | Desnecessários por D2 |
| `anti-mecanico.ts` e o gate na cadeia `before_send` | Fora: é estilo, mexe na cadeia global (versão 7→8). Volta com medição, se o dono pedir |
| Bloco "Dados essenciais/PENDENTES" e `estado-do-atendimento.ts` | Específicos do fork (motos: nome/cidade/CNH); não existem na main |
| Catálogo, fotos, banco externo, editor de skill | Outros recortes do #1130, já com destino próprio |
| `flow_start`, `flow_collect`, síntese por IA | D4, D5 |

### D10 — Os 9 consertos: quais o PR 1 já absorve por desenho

| # | Achado da prova | Onde fecha |
|---|---|---|
| 1 | Dado coletado não aparece em tela | PR 3 |
| 2 | "Anonimizar contato" não apaga o roteiro | **PR 1** (D1 + gatilho que encerra o roteiro vivo, D11) |
| 3 | Quem some no meio perde a retomada | **PR 1** (D2) |
| 4 | Validador grava o que o cliente não deu ("Outra", ano 125) | PR 2 |
| 5 | "Pare" com palavra-gatilho abre roteiro | **PR 1** (D6) |
| 6 | CPF em texto puro no log | **PR 1** (a linha "decisão do validador" não é portada com o texto; teste cobra) |
| 7 | CPF sem validação e duplicado | duplicação: **PR 1** (D1); tipo `cpf` com dígito e cifra em `cpf_encrypted`: PR 2 |
| 8 | Áudio/figurinha = "não respondeu" | PR 2 |
| 9 | Roteiro segue ativo com humano assumindo / não expira | PR 2 |
| — | "Esgotado" em todo roteiro concluído (menor) | **PR 1** (desfecho `converted`/`exhausted` pelo que de fato aconteceu) |
| menores | editor oferece nós recusados; "Esgotado" em todo concluído; Follow-ups listando roteiros; PDF LGPD sem os dados; guia desatualizado | PR 2 (motor/validação) e PR 3 (tela) |

### D11 — LGPD nos dois caminhos

Com D1 e D3, o que resta do roteiro depois da anonimização é: a linha de enrollment
(sem PII) e eventos (sem PII). O único risco vivo é um roteiro `coletando` continuar
perguntando. Gatilho novo `trg_contato_anonimizado_encerra_roteiro` (AFTER UPDATE OF
`is_anonymized`, virada false→true) cancela o enrollment `coletando` do contato — mesmo
desenho dos sete gatilhos de redação do schema, um lugar para os dois caminhos. Provado
por invariante novo que roda os dois caminhos (`fn_lgpd_anonymize_contact` e
`fn_lgpd_cascade_redact_contact`).

### D12 — Achados da execução do PR 1 (não estavam na prova)

- **Sticky recomeçava o roteiro.** O membro sticky do roteador também devolvia o roteiro:
  todo turno do mesmo assunto tentaria começá-lo, e depois de concluído recomeçaria para
  sempre. Só a intenção casada agora (`classified`/`reclassified`) começa roteiro.
- **Validador sem modelo.** `validarRespostaDoFluxo` chamava o modelo sem `model`: numa
  instalação configurada só pela tela (sem `default_model`), todo turno cairia calado em
  `indefinido`. Passa a usar `auxModelArgs` do turno, a regra dos outros auxiliares.
- **Bloco do turno mandava chamar `flow_collect`**, ferramenta que não existe aqui (D5).

### D13 — Revisão adversarial do PR 1 (head c0659740b)

Consertado no próprio PR 1:
- **Bloqueador:** a policy de `followup_flow_pointers` é só de tenant; um viewer mudava
  pelo PostgREST a superfície de um fluxo de silêncio ativo para `atendimento`, o
  `trg_enrollment_superficie_coerente` recusava cada inscrição e a varredura de silêncio
  abortava a cada tick — para todas as empresas depois daquele pointer. Três cortes:
  (a) os cinco carregadores de pointer do relógio pulam `atendimento`; (b) try por
  pointer na varredura (`pointers_failed`); (c) no banco, superfície imutável
  (`trg_superficie_do_fluxo_imutavel`) e roteiro só com gatilho manual (CHECK
  `followup_flow_pointers_roteiro_so_manual`); o PATCH devolve 422 legível.
- **update.sh:** a fusão por nono dígito (bloco da 0198) reapontava `followup_enrollments`
  sem deduplicar o roteiro vivo; fica o mais novo, o excedente é encerrado com evento
  `roteiro_cancelado`.

Registrado para o PR 2:
- `moduloLigado` sem memo: +1 leitura de `platform_config` por turno de inbound.
- `updateModuloDaInstalacao` já aceita `fluxos_atendimento` (o `z.enum` vem de
  `MODULOS_OPCIONAIS`). Não há botão na tela até o PR 3, e ligar antes só ativa o motor
  para roteiros criados pela API. Documentado aqui; se o titular preferir, o PR 2 recusa
  ligar até o PR 3.
- `coletando` fora das listas `ENROLLMENT_STATUSES`, do 409 de cancelar, do
  `outcome-stats` e do `EnrollmentStatus` do motor.
- O validador roda antes da reivindicação da mensagem: um retry paga a chamada de modelo
  de novo (a gravação continua idempotente).

## Foco de revisão (o que nenhum teste de tarefa cobre por acaso)

1. Mensagem de "pare" / pedido de humano que contém palavra-gatilho → nenhum roteiro nasce
   (teste na Task 6, com o turno inteiro dublado).
2. Contato já com o campo em `custom_fields` antes do roteiro → a pergunta não é feita
   (teste na Task 4).
3. Job reexecutado (retry) com a mesma mensagem → não conta tentativa duas vezes nem regrava
   (teste na Task 4, idempotência por `roteiro_msg:<id>`).
4. Chave desligada com roteiro `coletando` já existente → o turno ignora o roteiro por inteiro
   (teste na Task 6).
5. Organização B apontando o roteador para roteiro da A → recusado pelo banco (invariante, Task 8).

---

# PR 1 — BASE

Branch `feat/fluxos-atendimento-base`. Entrega: chave, schema, motor atrás da chave, LGPD
dos dois caminhos, invariante novo de RLS/LGPD. Nenhuma tela nova. Fragmento `.changes/`
`nada_mudou` (desligado, nada muda para quem opera).

### Task 1: a chave do módulo

**Files:** Modify `lib/instalacao/modulos.ts`, `lib/instalacao/modulos.test.ts`, e o que o
`tsc` apontar como `Record<ModuloOpcional, …>` exaustivo (ex.: `lib/navigation/*`,
`lib/mcp/tools/catalogo/*`).

**Produces:** `moduloLigado(db, "fluxos_atendimento"): Promise<boolean>`.

- [ ] Teste: com linha `MODULO_FLUXOS_DE_ATENDIMENTO = ligado`, `modulosLigados` devolve
  `["fluxos_atendimento"]`; sem linha, `[]`; o `in()` consulta as duas chaves.
- [ ] `MODULOS_OPCIONAIS = ["banco_externo", "fluxos_atendimento"]`,
  `CHAVE_DO_MODULO.fluxos_atendimento = "MODULO_FLUXOS_DE_ATENDIMENTO"`.
- [ ] `pnpm exec vitest run lib/instalacao` verde; `pnpm typecheck` 0. Commit nosso.

### Task 2: schema — migration 0394 + baseline + MANIFEST

**Files:** Create `supabase/migrations/2026092321xxxx_0394_fluxos_de_atendimento_base.sql`;
Modify `supabase/baseline.sql` (bloco único do CHECK de `surface` da 0196; bloco único de
`followup_enrollments_status_valido`/`_relogio_coerente` da 0145; apêndice novo antes da
VARREDURA anon), `supabase/migrations/MANIFEST.md`, `lib/database.types.ts`
(`flow_pointer_id` em `ai_router_members`).

Conteúdo da migration (idempotente, sem BEGIN/COMMIT):

```sql
-- 1. superfície nova
alter table public.followup_flow_pointers drop constraint if exists followup_flow_pointers_surface_check;
alter table public.followup_flow_pointers add constraint followup_flow_pointers_surface_check
  check (surface in ('followup','crm_automation','atendimento'));
-- 2. status coletando (sem relógio)
alter table public.followup_enrollments drop constraint if exists followup_enrollments_status_valido;
alter table public.followup_enrollments add constraint followup_enrollments_status_valido
  check (status in ('active','waiting_reply','dormente','paused_handoff','paused_manual','coletando','completed','cancelled','dead'));
alter table public.followup_enrollments drop constraint if exists followup_enrollments_relogio_coerente;
alter table public.followup_enrollments add constraint followup_enrollments_relogio_coerente
  check ((status in ('active','waiting_reply','dormente') and next_eval_at is not null)
      or (status in ('paused_handoff','paused_manual','coletando','completed','cancelled','dead')));
-- 3. um roteiro vivo por contato
create unique index if not exists idx_followup_enrollments_um_roteiro_coletando
  on public.followup_enrollments (organization_id, contact_id) where status = 'coletando';
-- 4. roteador aponta roteiro da MESMA organização
create unique index if not exists idx_followup_flow_pointers_org_id
  on public.followup_flow_pointers (organization_id, id);
alter table public.ai_router_members add column if not exists flow_pointer_id uuid;
-- FK composta (do $$ … exception when duplicate_object)
-- 5. gatilho: anonimizar encerra o roteiro vivo (dois caminhos)
create or replace function public.fn_contato_anonimizado_encerra_roteiro() returns trigger …
revoke all on function … from public; revoke execute … from anon; … from authenticated;
create trigger trg_contato_anonimizado_encerra_roteiro after update of is_anonymized on public.contacts
  for each row when (new.is_anonymized = true and coalesce(old.is_anonymized,false) = false)
  execute function public.fn_contato_anonimizado_encerra_roteiro();
```

- [ ] Conferir os blocos em vigor no baseline antes de editar (a definição EM VIGOR do
  `status_valido` é o `do $$` com o laço que derruba a versão sem `dormente`: o laço passa a
  derrubar a versão sem `coletando`, para o `update.sh` trocar a constraint num clone antigo).
- [ ] `pnpm exec vitest run tests/unit/baseline-constraint-reconstruida.test.ts
  tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts tests/unit/*migration*` verde.
- [ ] Commit nosso.

### Task 3: grafo — nós `collect`/`skill`, `settings`, `ao_finalizar`, publish por superfície

**Files (autor, port):** `lib/followup/graph-schema.ts`, `lib/followup/graph-mappers.ts`,
`lib/followup/eventos-legiveis.ts`, `lib/followup/node-handlers.ts` (collect/skill = falha
no relógio: nunca chegam lá, D2), `lib/followup/vocabulario.ts`, `lib/followup/api-schemas.ts`
(`FOLLOWUP_FLOW_SURFACES` + `surface` opcional no create), `lib/followup/validate-publish.ts`.
**Files (nosso):** rota `app/api/v1/ai/followup-flows/route.ts` (create com
`surface='atendimento'` só com a chave ligada, senão 404) e `…/[id]/publish/route.ts`
(passa a superfície ao validador); `lib/followup/enroll.ts` recusa pointer `atendimento`;
entradas exaustivas da UI por tipo de nó que o `tsc` apontar (rótulo/cor mínimos; o editor
completo é PR 3).

**Produces:** `collectConfigSchema` (`key` `^[a-z][a-z0-9_]{0,59}$`, `label`, `type` ∈
`text|number|date|boolean|select`, `required`, `permite_correcao`, `options`, `question`),
`skillConfigSchema`, `endFinishSchema`, `flowSettingsSchema { max_tentativas_pergunta
(1..10, default 3), gatilhos? }`, `validateFlowForPublish(graph, opts & { surface? })`.

- [ ] Testes (port de `graph-schema.test.ts`/`validate-publish.test.ts` do autor): `collect`
  válido; `select` sem opção recusa; atendimento com `wait` recusa com
  `no_fora_da_superficie`; follow-up com `collect` recusa com o mesmo código; aresta com
  condição no atendimento recusa.
- [ ] Commit do autor (port) + commit nosso (superfície nos dois sentidos, rota, enroll).

### Task 4: o motor do roteiro (`lib/followup/atendimento.ts`)

**Files:** Create `lib/followup/atendimento.ts` (port reescrito), `lib/followup/captura-do-fluxo.ts`
(port quase literal) e seus testes.

**Interfaces (Produces):**

```ts
export function mapearChecklist(graph: FlowGraph): ResultadoDoChecklist;            // autor, literal
export function situacaoDoChecklist(c, valores: ReadonlySet<string>, o?): SituacaoDoChecklist; // autor
export function melhorFluxoPorGatilho(fluxos, texto): FluxoComGatilhos | null;       // autor
export function renderBlocoDeAtendimento(estado, finalizacao?): string;             // autor, sem nota por IA
export function montarResumoDoRoteiro(estado): string;                               // D4
export async function carregarEstadoDeAtendimento(db: pg.Pool, a: { organizationId; contactId }): Promise<EstadoDeAtendimento | null>;
export async function iniciarFluxoDeAtendimento(db, a: { organizationId; contactId; flowPointerId }): Promise<string | null>;
export async function escolherFluxoPeloGatilho(db, a: { organizationId; texto }): Promise<{ id; nome } | null>;
export async function processarInboundDoFluxo(db, a: { organizationId; estado; texto; messageId?; validacoes? }): Promise<ResultadoDoInbound>;
```

Diferenças para o código do autor: `valores` vêm de `contacts.custom_fields` (só as chaves
do checklist); gravar = `update contacts set custom_fields = custom_fields || jsonb_build_object($k, $v)`
filtrado por `organization_id`; tentativas = `count(*) … event_type = 'roteiro_tentativa'
and payload->>'campo' = $k`; status `coletando`; sem `next_eval_at`; conclusão grava
`status='completed'` e `outcome` do nó Fim; eventos sem valor.

- [ ] Testes puros (port de `atendimento.test.ts`/`captura-do-fluxo.test.ts`).
- [ ] Testes com banco dublado (`pg.Pool` falso que grava as queries): gravar resposta faz
  UM `update contacts … custom_fields ||` com `organization_id`; payload do evento NÃO contém
  o valor; mensagem já processada (evento com a chave `roteiro_msg:<id>`) não gera nada;
  contato com a chave já em `custom_fields` não tem a pergunta pendente.
- [ ] Sabotar: remover o filtro de idempotência → teste vermelho; restaurar; `grep` confirma.
- [ ] Commit do autor (port literal das peças puras) + commit nosso (armazenamento D1–D4).

### Task 5: o validador (`flow_validate`)

**Files:** Create `lib/agent-engine/agent/flow-validate.ts` (+ teste, port); Modify
`lib/ai/pontos/registro.ts` (ponto `flow_validate`, papel `entender`).

- [ ] Port literal + teste do autor. Chamada com o modelo auxiliar do turno (`argsAux`).
- [ ] Teste nosso: nenhum `log.*` do módulo recebe o texto do cliente.
- [ ] Commit do autor + commit nosso.

### Task 6: o roteiro no turno (`roteiro-no-turno.ts`) + ligação no `inbound-turn.ts`

**Files:** Create `lib/agent-engine/agent/roteiro-no-turno.ts` (+ teste); Modify
`lib/agent-engine/agent/inbound-turn.ts`, `lib/agent-engine/agent/router-config.ts`,
`lib/agent-engine/agent/resolve-turn-agent.ts` (`flowPointerId` do membro casado).

**Interfaces:**

```ts
export interface RoteiroDoTurno {
  estado: EstadoDeAtendimento;
  finalizacao?: EndFinish;
  bloco: string;           // vai para openingSuffixes
  skills: string[];        // união com skillMatch.matched
}
export async function prepararRoteiroDoTurno(deps: {
  pool: pg.Pool; moduloLigado: () => Promise<boolean>; validar: ValidarResposta; log: Logger;
}, t: { tenantId; leadId; texto: string | null; messageId: string | null;
        flowPointerDoRoteador: string | null; mensagens: MensagemDoContexto[] }): Promise<RoteiroDoTurno | null>;
export async function garantirPerguntaDoRoteiro(deps, t: { roteiro: RoteiroDoTurno;
  corposEnviados: readonly string[]; enviar: (texto: string) => Promise<'sent' | 'vetoed'> }): Promise<void>;
```

- [ ] Teste: chave desligada → `null` sem nenhuma query de roteiro; roteiro existente +
  chave desligada → `null`; sem roteiro e sem gatilho → `null`; gatilho casa → inicia e o
  turno de início só grava o que o validador leu.
- [ ] Ligação no turno, depois do bloco do opt-out ambíguo e só com
  `!preview && liveJob().kind === 'inbound_turn' && !optedOutThisTurn`. O início pelo roteador
  usa `routed.flowPointerId` nesse mesmo ponto.
- [ ] Teste de ordem (fonte do `inbound-turn.ts`, AST ou índice de texto): a chamada de
  `prepararRoteiroDoTurno` vem DEPOIS de `detectAmbiguousOptOut` e de
  `detectHumanHandoffRequest`, e depois do `pausedAt`. Sabotar movendo a chamada → vermelho.
- [ ] Commit nosso (o encaixe é reescrita; a lógica portada já tem autoria nas Tasks 4–5).

### Task 7: LGPD — o gatilho e a prova

Coberto pela migration (Task 2) e provado no invariante da Task 8. O payload sem valor é
cercado pelo TIPO (`PayloadDoEvento` não tem campo de valor) e pelo teste da trilha em
`lib/followup/atendimento.test.ts`; a exposição das funções novas é vigiada pelo
`tests/invariants/hardening-definer-varredura.test.ts` que já existe.

### Task 8: invariante novo (roda no `test:db` do CI)

**Files:** Create `tests/invariants/roteiro-de-atendimento-rls-lgpd.test.ts`.

- [ ] Duas organizações. Um usuário `authenticated` da B não lê enrollment `coletando`,
  eventos `roteiro_*` nem `custom_fields` do contato da A (controle positivo: o dono da A lê).
- [ ] Membro do roteador da B com `flow_pointer_id` de roteiro da A → `23503`.
- [ ] Índice: segundo `coletando` no mesmo contato → `23505`; um `active` de follow-up NO MESMO
  contato convive com o `coletando` (é o bloqueio 3 da prova).
- [ ] LGPD, caminho do botão (`fn_lgpd_anonymize_contact`) e caminho formal
  (`fn_lgpd_cascade_redact_contact`), cada um num contato: depois, `custom_fields = '{}'`,
  nenhum enrollment `coletando`, e o texto respondido não aparece em nenhum `payload` de
  `followup_enrollment_events` do contato.
- [ ] Não roda local (sem Docker): prova no job `invariants` do CI.

### Task 9: plano, MANIFEST, fragmento, PR

- [ ] Fragmento `.changes/` `nada_mudou`. `pnpm release:conferir`.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` inteiro (rodapé é a autoridade).
- [ ] PR "feat(fluxos): base dos fluxos de atendimento, desligada por padrão — de @vgamkt",
  sem auto-merge. Comentário no #1130.

---

# PR 2 — OS CONSERTOS (depois do PR 1 aprovado)

Cada item: teste que reproduz o achado da prova (vermelho na base do PR 1), conserto, sabotagem.

1. **Dado inventado (#4).** O validador só aceita um campo quando a mensagem traz o DADO
   dele: (a) `select` exige que a opção esteja no texto do cliente (ou sinônimo explícito
   da opção) — "moto de uns 15 mil" não vira "Outra"; (b) `number` com pista de "ano" exige
   1950–2100 e não aceita número que é parte de outro token ("CG 125" não vira ano);
   (c) campo que não é o PRIMEIRO pendente só é aceito se o texto contiver o valor literal.
   Arquivo: `flow-validate.ts` + `captura-do-fluxo.ts`. Casos da prova como teste.
2. **Tipo `cpf` (#7).** `contactFlowFieldTypeSchema` ganha `cpf`; validação por dígito
   verificador (`lib/contacts/cpf.ts`); gravação em `contacts.cpf_encrypted`/`cpf_hash`
   (nunca em `custom_fields`); o evento só diz `campo`. CPF inválido não conta como resposta
   e a IA pede de novo.
3. **Áudio e figurinha (#8).** O texto do turno vem de `media_derived_text` quando houver
   (áudio transcrito); mídia sem texto derivado NÃO conta tentativa (vira "sem leitura").
4. **Humano assume / roteiro sem prazo (#9).** Handoff (`performHumanHandoff`), força
   humana e opt-out cancelam o `coletando` com evento `roteiro_cancelado`; `settings.expira_em_horas`
   (padrão 72) e o cron diário que já existe (`data-retention` ou `recover-stuck`) encerra
   `coletando` vencido como `esgotado`.
5. **Menores do motor.** Fim concluído grava `outcome='converted'` e não "Esgotado"
   (esgotado só quando alguma pergunta esgotou); encadear ignora o próprio roteiro e diz
   por quê no publish; o seletor não oferece o próprio roteiro.
6. **Log sem PII como cerca.** Teste que varre `lib/followup/atendimento.ts`,
   `roteiro-no-turno.ts` e `flow-validate.ts` e reprova `log.*` com `texto`/`valor`.

## PR 2 — como foi executado (branch `feat/fluxos-atendimento-consertos`)

| Achado / pendência | Conserto | Prova |
|---|---|---|
| 4 — validador inventa dado | `respostaTemLastro`: a resposta precisa estar NA mensagem, por tipo (opção escrita; número escrito, ano 1950–2100; texto livre e sim/não soltos só na pergunta que está sendo feita) | `flow-validate.test.ts` com as frases da prova ("uns 15 mil" ≠ "Outra"; "CG 125" ≠ ano 125); `captura-do-fluxo.test.ts` |
| 7 — CPF sem validação | tipo `cpf`: mod-11 na captura e no validador; correção carrega o tipo. O valor fica SÓ em `custom_fields` (um lugar, apagado pela anonimização) | idem |
| 8 — áudio/figurinha = "não respondeu" | o roteiro lê legenda + derivado da mídia da linha da mensagem; mídia sem leitura não conta tentativa nem chama o validador | `roteiro-no-turno.test.ts` |
| 9 — roteiro vivo com humano | migration 0397: gatilho na virada de `force_human`/`is_blocked` encerra (não pausa) com evento; a pausa curta pelo celular NÃO encerra | invariante novo `roteiro-de-atendimento-humano-opt-out-prazo` (CI) |
| opt-out | o mesmo gatilho + `STATUS_ALCANCADOS_PELO_OPT_OUT` com `coletando` | `reactivity-dormente.test.ts` + invariante |
| expiração | `fn_encerrar_roteiros_vencidos` (padrão 72 h, `settings.expira_em_horas`), no relógio e no cron, com evento `roteiro_expirado` | invariante + `atendimento.test.ts` |
| memo da chave | `moduloLigadoComMemo`, 30 s | `modulos.test.ts` |
| `coletando` nas listas | fila, enrollments, cancelamento (antes 409), outcome-stats, `EnrollmentStatus` | teste da rota de cancelar |
| validador antes do claim | claim primeiro; retry não paga modelo | `roteiro-no-turno.test.ts` |
| ligar o módulo antes da tela | **decisão: RECUSAR** ligar até o PR 3 (`MODULOS_AINDA_NAO_LIGAVEIS`); desligar segue livre | `updateModuloDaInstalacao.test.ts` |
| Follow-ups listando roteiros | GET padrão sem roteiros (`?surface=atendimento` só roteiros); tela e editor de follow-up idem | `route.test.ts` |
| editor oferecendo nós recusados | a paleta do FOLLOW-UP já está filtrada (PR 1); a paleta do ROTEIRO nasce filtrada no PR 3, junto do editor dele | — |

Ficam para o PR 3: tela e guia, PDF de LGPD com os campos personalizados, ficha do contato,
o roteador escolhendo roteiro, e tirar `fluxos_atendimento` de `MODULOS_AINDA_NAO_LIGAVEIS`.

# PR 3 — TELAS (fragmento `capacidade_nova` com o crédito)

1. Interruptor em `/admin/sistema` (`app/admin/(protected)/sistema/_form.tsx`), como o do
   banco externo.
2. Tela "Fluxos de atendimento" (lista + editor reaproveitando o editor do follow-up), com
   paleta filtrada por superfície (só Início/Pergunta/Skill/Fim), sem a barra de gatilho do
   follow-up, guia "Como usar" com palavras-gatilho e encadear. Porta em
   `lib/navigation/registry.ts` com `modulo: "fluxos_atendimento"` (sem a chave, sem porta
   e 404). O menu segue a decisão (d) do doc 48.
3. Ficha do contato e conversa: seção "Roteiro" com o resumo montado (`montarResumoDoRoteiro`)
   e a trilha legível; rótulo de `coletando` na fila; Follow-ups não lista `atendimento`.
4. Roteador: escolher o roteiro de uma intenção.
5. PDF do titular (LGPD) com os campos personalizados do contato.
6. `.changes/` `capacidade_nova`: "Trabalho de @vgamkt, recortado do PR #1130."

# PR 4 — PROVA

1. `test:db` no CI verde com o invariante do PR 1 e um novo cobrindo o PR 2 (cancelamento
   por handoff, expiração).
2. Spec Playwright `tests/e2e/fluxo-de-atendimento.spec.ts` (instalação fresca, chave ligada
   pela tela, roteiro criado pela tela, cliente responde pelo webhook, dado aparece na ficha,
   anonimizar pela tela apaga) — entra em `SPECS_PARTE_*` do `e2e.yml`.
3. Atualizar `docs/testing/user-journey-map.md` e o mapa `docs/architecture/`.

## PR 3 — execução (2026-09-24, branch `feat/fluxos-atendimento-telas`)

| Item | Feito | Onde se prova |
|---|---|---|
| 1. interruptor | `/admin/sistema` com a chave; `MODULOS_AINDA_NAO_LIGAVEIS` vazio | `updateModuloDaInstalacao.test.ts`, e2e |
| 2. tela + editor | lista e editor em `/app/ai/atendimento` (404 com o módulo desligado); paleta por `NOS_DA_SUPERFICIE`; sem gatilho/handoff do follow-up; painel do Início com gatilhos, tentativas e prazo; Fim com "ao concluir" e encadear (sem o próprio); guia reescrito. Porta: entrada do catálogo com `modulo` e SEM `sidebar` (decisão d do doc 48) | `NodePalette.test.tsx`, `EndForm.test.tsx`, `PublishBar.test.tsx`, e2e |
| 3. ficha e conversa | `GET /contacts/[id]/roteiros` + `RoteirosDoContato` (ficha e painel do inbox), resumo montado dos campos; "Coletando respostas do roteiro" na fila | `roteiros-do-contato.test.ts`, `route.test.ts`, `RoteirosDoContato.test.tsx`, e2e |
| 4. roteador | intenção aponta um roteiro (commit portado do autor) | — (tela do autor) |
| 5. PDF LGPD | snapshot e PDF com `custom_fields` | `lgpd-pdf-campos-personalizados.test.ts` |
| 6. fragmento | `capacidade_nova`, crédito a @vgamkt | `pnpm release:conferir` |

Não feito no PR 3: a trilha legível dos eventos `roteiro_*` na fila (sem rótulo em
`eventos-legiveis.ts`); o PDF mostra a chave técnica do campo (o rótulo da pergunta mora no
grafo). A spec e2e reproduz o turno com as funções do motor, sem worker nem modelo.

### Revisão adversarial do #1573 (2026-09-24) — consertado no PR 3

| Achado | Conserto | Prova |
|---|---|---|
| B1 porta visível com o módulo desligado | `NavHub.modulosLigados` virou obrigatório (o compilador cobra de todo hub; IA, CRM e Análise passaram a enviar); seletor de roteiro no roteador some com o módulo desligado | `app/app/ai/page-modulo.test.tsx` (NavHub real), `routers/[id]/_client.test.tsx` |
| B2 vínculo roteador → roteiro descartado | schema aceita `flow_pointer_id`; os dois gravadores inserem a coluna e recusam roteiro de outra empresa ou fora de `atendimento` (422, nada apagado) | `tests/unit/roteador-grava-o-roteiro.test.ts` |
| espanhol do "ao concluir" | 4 rótulos no dicionário + teste que cobra cada um | `EndForm.test.tsx` |
| ficha de anonimizado | a rota devolve lista vazia (vale para ficha e conversa) | `contacts/[id]/roteiros/route.test.ts` |
| PDF LGPD | seção própria com o rótulo da pergunta (ou a chave legível); CPF só na linha do documento | `lgpd-pdf-campos-personalizados.test.ts` |
| ciclo A → B → A | o publish recusa o encadeamento que volta ao roteiro | `validate-publish.test.ts`, `tests/api/followup-flows.test.ts` |

Ficam para o PR 4: o cache da lista ao duplicar; a aresta roteador → turno no mapa
`roteiros-de-atendimento`; a leitura repetida em `lib/followup/editar.ts`; o ciclo que um
ROLLBACK de versão fecharia (o conserto confere só na publicação); o INSERT de
`ai_router_members.flow_pointer_id` contra Postgres real (a prova do PR 3 é pela rota com
banco de mentira).
