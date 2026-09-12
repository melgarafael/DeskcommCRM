# A régua — as definições que o produto usa, e as armadilhas que distorcem a leitura

Medido no código em setembro de 2026 (v1.17.0). Nomes de tabela e coluna são os reais do
`supabase/baseline.sql`.

## Três "handoffs", três números

| onde | conta o quê |
|---|---|
| Uso e orçamento | só `event_log.event_type = 'ai.handoff_triggered'` (runtime legado) |
| Evolução da IA | `agent_inbox_items.kind = 'handoff'` (motor atual) **mais** o `event_log` acima |
| Desempenho › Atrito | `crm_lead_activities.type = 'handoff_triggered'` |

Régua deste guia: **somar `agent_inbox_items` (motor atual) e `event_log` (legado)**, como a
Evolução faz — e declarar. Handoff **não tem `agent_id`**: a atribuição por agente é um proxy pelo
agente atual da conversa (`conversations.active_ai_agent_id`), que pode ter mudado depois.

## "Ganhou" e "perdeu"

- Desempenho e Atrito: `crm_leads.status` por `closed_at`; **leads cujo dono é o agente não entram**
  em Ganhos/Perdidos por atendente (o filtro exige `owner_user_id`).
- Evolução: transições do estado do agente (`lead_state_transitions.to_stage`), que é outra coisa —
  o passo do agente, não a etapa do funil.
- Régua deste guia: `crm_leads` por `closed_at`, todos os donos, com `owner_kind` separado.

## Fuso horário

- `organizations.timezone` (padrão `America/Sao_Paulo`, **não validado** ao gravar) é a régua da
  tela Atividades e deste guia. Uso e Evolução agrupam por **dia UTC**; o orçamento mensal também.
- A janela de envio do número é `channel_knobs.window_start_hour/window_end_hour` no
  `channel_knobs.timezone`; o horário do **agente** é outro campo (`trigger_config.filters.business_hours`)
  e fora dele o turno é adiado, não perdido.
- Sempre `at time zone o.timezone` nas consultas; se o fuso for inválido, diga e use
  `America/Sao_Paulo`.

## `sent_at` não é `created_at`

Inbound: `sent_at` é o carimbo do WhatsApp; outbound: `sent_at` é o momento do enfileiramento, e a
entrega real fica em `delivered_at`. Uso conta recebidas por `created_at`; Atrito por `sent_at`.
Régua deste guia: `sent_at`.

## Quem respondeu

`messages.direction` + `messages.sent_via` (`ai`, `user`, `external_device` = celular, `automation`,
`crm`, `system`) + `sent_by_user_id`. A tela de Desempenho mede "1ª resposta" só de humano
(`sent_by_user_id` preenchido) — a IA fica de fora. Este guia separa IA × humano × ninguém.

## Grupos e arquivados

Nenhuma função de métrica do produto filtra `conversations.is_group` nem `status = 'archived'`.
Este guia filtra `is_group = false` e trata `archived` como fechado.

## Abandono depende do "agora"

"Abandonadas" compara `last_outbound_at` com `now() - N horas`: o mesmo período dá número
diferente conforme a hora da consulta. Registre a hora da medição no relatório.

## Custo sem preço

`llm_calls.cost_cents` é **nulo** quando o modelo não está na tabela de preços (gateway, OpenRouter
com id desconhecido). `sum()` esconde; sempre imprima `count(*) filter (where cost_cents is null)`
ao lado. Custo é em centavos de **dólar**.

## `agent_id` vazio no histórico

`llm_calls.agent_id` só passou a ser gravado depois de um conserto; chamadas antigas ficam sem
agente. A tabela `ai_agent_runs` está vazia no motor atual — a tela "Uso das capacidades" por
agente tende a mostrar zero por isso, não porque o agente não usou nada.

## Vocabulário aberto

`crm_lead_activities.type`, `llm_calls.purpose`, `crm_leads.source`, `lost_reason` não têm
restrição no banco: um `group by` pode trazer valores fora da lista. Mostre-os como estão, sem
"corrigir".

## Anonimizados

Corpo de mensagem anonimizado vira um texto fixo — duas mensagens anonimizadas em sequência
parecem "repergunta" para a métrica de similaridade do produto. Contadores incluem anonimizados;
taxas de texto, não confie.

## Tetos silenciosos

Uso lê no máximo 50 mil linhas; Evolução 50 mil (com aviso); Radar 500 leads. Numa organização
grande, a tela corta; a consulta direta não. Se os números divergirem da tela, é isso antes de
qualquer outra hipótese.

## Demandas "derivadas"

A entidade `demandas` nasceu depois das conversas; o histórico anterior foi preenchido com
`aberta_em = conversations.created_at`. Análises de tempo de vida de demanda misturam duas
formas — corte pelo período posterior à existência da entidade, ou declare.

## Follow-up: fluxo × promessa

Fluxos (`followup_enrollments`) registram desfecho (`converted`, `replied`, `exhausted`,
`opted_out`, `handoff`). Promessas de retorno do agente ("volto amanhã", `cron_jobs`) **não**
registram desfecho — "respondeu em 48 h depois do retorno" é inferência, e este guia a declara.
