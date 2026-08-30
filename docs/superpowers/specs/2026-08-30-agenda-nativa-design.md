# Agenda nativa do CRM (Frente A) — design

**Data:** 2026-08-30 · **Base:** `main@87ea9f8`

## O problema

O SonghaiCRM não tem nenhum conceito de agendamento/compromisso hoje — não existe
tabela `appointments`, não existe tela de agenda, e `crm_lead_links` já reserva
`'appointment'` no vocabulário de `target_kind` desde o início sem nunca ter sido
usado. Comparando com o upstream (DeskcommCRM), ele construiu um módulo de
"Agenda" completo em 4 releases (1.7.0–1.10.1): tipos de agendamento,
disponibilidade por atendente, tela de calendário, integração OAuth com Google
Calendar (por pessoa, nos dois sentidos) e capacidades de IA para marcar direto
no WhatsApp.

Esse escopo completo é grande demais para um spec só — decompomos em três
frentes independentes, cada uma com seu próprio ciclo spec → plano →
implementação:

- **Frente A (este documento)** — Agenda nativa do CRM. Funciona sozinha, sem
  depender do Google.
- **Frente B** — Integração com Google Calendar (OAuth por pessoa, sync nos
  dois sentidos). Só faz sentido depois de A existir.
- **Frente C** — IA marca/reagenda/cancela pelo WhatsApp. Consome A.

Este spec cobre **só a Frente A**.

## Decisões

| Decisão | Escolha | Por quê |
|---|---|---|
| Disponibilidade de agendamento vs. fila de chat | **Tabela nova, separada** de `attendant_availability` (fila do WhatsApp, epic de Governança) | Conceitos diferentes: fila é efêmera (toggle agora), agenda é estrutural (horário semanal recorrente). Acoplar faria os dois evoluírem juntos sem necessidade e arriscaria um bug num afetar o outro |
| Agendamento sem lead | **Sempre amarrado a um lead** | Encaixa na timeline (`crm_lead_activities`) e no dossiê que já existem; marcar hora pode criar o lead na hora se ainda não existir |
| Responsável do tipo | **Pessoa fixa por tipo**, não papel/rodízio | MVP — o motor de rodízio da fila de chat é outro domínio; escalar para "qualquer atendente do papel X" é alargamento futuro, sem migração destrutiva |
| Quem cria o agendamento | **Só a equipe, pela tela do CRM** | Sem link público de auto-agendamento nem IA marcando sozinha nesta frente — ambos exigiriam superfície pública/rate-limit ou a Frente C, fora de escopo aqui |
| Estados do agendamento | `scheduled` / `completed` / `cancelled` / `no_show` | Cobre o ciclo básico de negócio e mede falta desde o início — útil pra clínicas/serviços |
| Lembrete de WhatsApp | **Sim, no MVP** — 1 lembrete, janela fixa configurável (default 24h) | Produto é WhatsApp-first; deixar de fora seria estranho, e reusa o pipeline de envio que já existe |
| Vínculo lead↔agendamento | `crm_lead_links` com `target_kind='appointment'` (já reservado, nunca usado) | DIRC: referenciar em vez de duplicar — o vocabulário já existe no CHECK constraint |
| Tela | Lista por dia + seletor de data (sem drag-and-drop, sem grade semanal) | Mais simples de construir e testar nesta primeira entrega; o upstream teve vários bugs de mobile/scroll justamente na grade — evitamos essa classe de defeito adiando-a |

## Modelo de dados

Três tabelas novas, `organization_id not null` + RLS desde o nascimento (doutrina
de multi-tenancy do `CLAUDE.md`).

### `appointment_types`

```
id                   uuid pk
organization_id      uuid not null references organizations(id) on delete cascade
name                 text not null
duration_minutes     integer not null check (duration_minutes > 0)
responsible_user_id  uuid not null references auth.users(id)
color                text                          -- hex, mesma regex de accent_hex
is_active            boolean not null default true
created_at, updated_at
```
RLS: SELECT org-wide; INSERT/UPDATE/DELETE exige `fn_role_at_least(organization_id,'manager')`
(mesmo padrão de `ai_*_write` da migration 0163).

**Responsável que perde acesso à organização (revogação de membership, não
delete de conta):** o tipo não é desativado automaticamente — silenciar um
tipo de agendamento sem avisar seria pior que deixá-lo visível. Em vez disso,
a tela de Tipos de agendamento resolve o `responsible_user_id` contra
`user_organizations` ativo e mostra um aviso ("responsável sem acesso a esta
organização") quando não encontra, sem travar a tela. `attendant_schedule`
segue a mesma regra: uma pessoa sem membership ativo simplesmente não aparece
mais no cálculo de `available-slots` (a leitura já filtra por membership via
`fn_user_org_ids()`/RLS), mas a linha de horário não é apagada — se a pessoa
voltar, o horário está lá.

### `attendant_schedule`

```
id                uuid pk
organization_id   uuid not null references organizations(id) on delete cascade
user_id           uuid not null references auth.users(id) on delete cascade
day_of_week       smallint not null check (day_of_week between 0 and 6)
starts_at         time not null
ends_at           time not null check (ends_at > starts_at)
created_at, updated_at
unique (organization_id, user_id, day_of_week, starts_at)  -- permite 2 blocos no mesmo dia (manhã/tarde)
```
RLS: SELECT org-wide (a agenda de todo mundo precisa ser visível pra montar
`available-slots` de qualquer tipo); INSERT/UPDATE/DELETE só a própria linha
(`user_id = auth.uid()`) OU manager+ — mesmo padrão de `attendant_availability`.
Pessoa sem nenhuma linha para um `day_of_week` = não atende naquele dia.

**Fuso horário — explícito, não implícito:** `starts_at`/`ends_at` são
interpretados no fuso de `organizations.timezone` (a mesma coluna que o
anti-ban já usa via `lib/tempo/fusos.ts`), nunca UTC cru. É o mesmo bug
histórico que o anti-ban já teve ("janela 7h-22h virava 4h-19h") — resolvido
aqui usando o MESMO utilitário, não uma conversão própria nova.

### `appointments`

```
id                    uuid pk
organization_id       uuid not null references organizations(id) on delete cascade
lead_id               uuid not null references crm_leads(id) on delete cascade
appointment_type_id   uuid not null references appointment_types(id)
responsible_user_id   uuid not null references auth.users(id)   -- copiado do tipo na criação
scheduled_at          timestamptz not null
duration_minutes      integer not null check (duration_minutes > 0)  -- copiado do tipo na criação
status                text not null default 'scheduled'
                      check (status in ('scheduled','completed','cancelled','no_show'))
reminder_sent_at      timestamptz
created_by_user_id    uuid not null references auth.users(id)
created_at, updated_at
```

**Por que copiar `responsible_user_id`/`duration_minutes` do tipo em vez de só
referenciar `appointment_type_id`:** se o tipo mudar de responsável ou duração
depois, agendamentos já marcados não podem mudar de dono/tamanho em silêncio —
o agendamento registra o que foi COMBINADO no momento da marcação (mesmo
princípio já usado em `payments.amount_cents`/`currency`, migration 0162).

**Conflito de horário — regra dura, no banco:** exclusion constraint via
`btree_gin`/`tstzrange`:

```sql
alter table appointments add constraint appointments_no_overlap
  exclude using gist (
    responsible_user_id with =,
    tstzrange(scheduled_at, scheduled_at + (duration_minutes || ' minutes')::interval) with &&
  ) where (status = 'scheduled');
```

Garante no banco que a mesma pessoa nunca tem 2 agendamentos `scheduled`
sobrepostos, mesmo com duas abas/duas rotas tentando ao mesmo tempo — não
depende só da UI checar antes de inserir.

RLS de `appointments`: SELECT org-wide (mesma lógica de `crm_leads` — quem vê o
lead deve ver o agendamento dele; herda `fn_can_view_lead` via EXISTS no lead,
mesmo idioma de `crm_lead_activities_select`); INSERT/UPDATE exige pelo menos
`agent` (não é dado sensível, mas não é `viewer`).

**LGPD — entra na cascata de redact.** O `CLAUDE.md` define a cascata como
"contact + conversations + messages (mídia removida) + activities (preserva
timestamps)" — `appointments` fica de fora dessa lista hoje e carrega PII de
visita (o lead nomeado, histórico de comparecimento). Este spec ADICIONA
`appointments` à cascata: `fn_redact_contact` (ou a função equivalente que
executa o redact) passa a também anonimizar o vínculo — na prática, como o
`lead_id` já vira `Cliente Anonimizado #N` via a anonimização do lead/contato,
`appointments.lead_id` não muda, mas a linha PRECISA ser alcançada pela
mesma verificação de invariante que testa a cascata hoje (ela lê pelo nome do
lead, então herda a anonimização automaticamente — o ponto de atenção é
garantir que nenhuma coluna de `appointments` grave nome/telefone em texto
livre fora do `lead_id`, o que já é o caso neste desenho). Precisa de teste
dedicado no invariante de LGPD existente, não só assumir que "funciona
porque é FK".

### Vínculo com o lead

`crm_lead_links` ganha uma linha `(lead_id, target_kind='appointment', target_id=appointments.id)`
a cada agendamento criado — o vocabulário já existe no CHECK, sem migração de
schema adicional. A timeline do lead (`crm_lead_activities`) recebe uma
activity `type='agendamento'` a cada criação/mudança de status (reusa o
vocabulário já semeado como skill da IA em `skill_pointers`,
`supabase/baseline.sql` linha ~8016).

## API

Rotas REST em `/api/v1/`, JSON snake_case, `ok()`/`fail()`, Zod em todo input,
`requireRole` por rota — convenção padrão do repo:

- `appointment-types` — GET (list), POST (manager+)
- `appointment-types/[id]` — GET, PATCH, DELETE (manager+; DELETE só se
  `is_active=false` E zero agendamentos futuros, senão 409 — mesmo espírito da
  proteção de "arquivar em vez de apagar" já usada em funis)
- `attendant-schedule` — GET (própria ou, com `?user_id=`, manager+ vê de outro);
  PUT substitui o conjunto de blocos da semana da própria pessoa (ou de outra,
  manager+)
- `appointments` — GET (filtro por intervalo de data + responsável opcional),
  POST (cria; roda a checagem de slot livre + fallback no erro de exclusion
  constraint do banco, que é a fonte da verdade final)
- `appointments/[id]` — PATCH (muda `status`, ou reagenda trocando
  `scheduled_at` — reagendar é só uma atualização, não um DELETE+INSERT, para
  preservar `id`/histórico). **Reagendar zera `reminder_sent_at` para `null`**
  sempre que `scheduled_at` muda — senão um compromisso que já teve lembrete
  enviado e foi remarcado pra semana que vem nunca recebe lembrete novo (o
  cron só olha `is null`)
- `appointments/available-slots?type_id=&date=` — GET, calcula slots livres:
  horário de trabalho do responsável do tipo naquele dia de semana (no fuso
  da organização) MENOS agendamentos `scheduled` que já ocupam parte da janela

**Auditoria:** toda mutação (POST/PATCH/DELETE) nas 4 rotas grava 1 linha em
`api_audit_log`, fire-and-forget, como manda o DoD do `CLAUDE.md` — sem
exceção para esta feature.

## Telas

- **Agenda** (`app/app/agenda/`, novo item no menu — ícone `CalendarCheck` ou
  similar do Phosphor, registrado em `lib/navigation/registry.ts`) — lista do
  dia selecionado (hora, lead, tipo, responsável, status) + seletor de data +
  botão "Novo agendamento".
- **Configurações → Tipos de agendamento** — CRUD (admin/manager), mesmo padrão
  visual das telas de configuração existentes.
- **Equipe → Atendimento** (tela que já existe para `attendant_availability`)
  ganha uma seção "Meu horário de agendamento" — cada pessoa configura os
  próprios blocos por dia da semana; manager+ pode editar de qualquer um.
- **Dossiê do lead** — seção de agendamentos (próximos + histórico), e a
  timeline de atividades reflete criação/mudança de status.

**Diálogo de novo agendamento:** escolhe lead (ou cria na hora) → escolhe tipo
(preenche responsável + duração automaticamente) → escolhe data → sistema
mostra só os horários livres (chama `available-slots`) → confirma.

## Crons (o laço de retorno — Sistema Vivo)

### `appointment-reminder`
A cada 5–15 min: busca `appointments` com `status='scheduled'`,
`reminder_sent_at is null` e `scheduled_at` dentro da janela configurada
(constante fixa no MVP, ex. 24h — não config por org ainda).

**Não é um envio cru — passa pela cadeia `runBeforeSend` (`lib/agent-engine/
guardrails/before-send.ts`), a mesma que corrigiu o bug de dupla resposta
IA+humano nesta sessão.** Um lembrete que ignorasse essa cadeia mandaria
mensagem pra lead que pediu STOP (`contacts.is_blocked`/`force_human`),
ignoraria a janela de 24h do canal e o throttle anti-ban — violação direta da
doutrina WAHA (W-01 a W-12) do `CLAUDE.md`. O `channel_session_id` usado é o da
**conversa mais recente do lead** (`conversations` por `lead_id`/`contact_id`,
`order by last_inbound_at desc limit 1`) — nunca inventado; se o lead não tem
nenhuma conversa (nunca escreveu, canal nunca conectado), o gate de janela de
24h veta e o veto vira aviso na Central, não uma tentativa de enviar por um
canal que não existe.

Grava `reminder_sent_at` só quando o resultado de `runBeforeSend` é `sent` —
um veto (STOP, janela fechada, anti-ban) não marca como enviado, pra não
mascarar "não mandei porque não podia" como "mandei". Falha de infraestrutura
(canal desconectado, erro do provedor) abre aviso na Central
(`agent_inbox_items`) — mesmo padrão de `recover-stuck-messages`, nunca falha
em silêncio.

### `appointment-outcome-nudge`
Agendamento `scheduled` cujo `scheduled_at + duration_minutes` já passou há
mais de 1h **não é auto-marcado** como `completed`/`no_show` — só um humano
sabe se o cliente veio. Abre aviso na Central pedindo para confirmar o
desfecho. Fecha o invariante "nada morre sem próximo passo": sem isso, um
agendamento passado ficaria `scheduled` para sempre, mentindo para qualquer
relatório de no-show.

Ambos os crons entram no crontab do `scheduler` (`docker/scheduler/entrypoint.sh`)
e no gate `tests/unit/cron-routes-scheduled.test.ts`, como qualquer cron novo.

## Testes

- **Migration**: `pnpm test:db` — as 3 tabelas + RLS + exclusion constraint
  aplicadas em install fresco e em update sobre banco existente.
- **Unit**: Zod dos payloads de cada rota; cálculo de `available-slots`
  (casos: sem horário cadastrado, horário parcialmente ocupado, múltiplos
  blocos no mesmo dia); a regra do cron de lembrete (janela, não duplicar,
  aviso em falha) e do nudge de desfecho, no mesmo estilo dos testes de
  `recover-stuck-messages`/`event-log-purge` (dublê de client, sem Docker).
- **Invariante de RLS**: isolamento entre 2 organizações nas 3 tabelas novas,
  e que a exclusion constraint recusa dois agendamentos sobrepostos mesmo
  inseridos concorrentemente (2 conexões simultâneas).
- **E2E (Playwright)**: fluxo completo — cadastrar tipo, cadastrar horário do
  atendente, marcar agendamento pelo dossiê do lead, ver na tela de Agenda,
  marcar como concluído.

## Fora de escopo (Frentes B e C, specs futuros)

- OAuth com Google Calendar, sync nos dois sentidos.
- IA marcando/remarcando/cancelando pelo WhatsApp.
- Link público de auto-agendamento (tipo Calendly).
- Rodízio/escala de responsável por tipo (só pessoa fixa por enquanto).
- Grade semanal com drag-and-drop (só lista por dia nesta versão).
- Lembrete configurável por organização (janela fixa no MVP).
- Exceções pontuais na disponibilidade (férias, feriado, "hoje eu saio mais
  cedo") — `attendant_schedule` é só o padrão semanal recorrente; um dia fora
  do padrão continua aparecendo como livre em `available-slots` até essa
  camada existir. Registrado aqui para não ser descoberto como bug depois.
