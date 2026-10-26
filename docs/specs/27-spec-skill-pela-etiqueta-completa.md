# Spec 27 — A skill pela etiqueta, completa: a etiqueta chega antes da resposta

Status: **PROPOSTA**. Continuação do PR #3230 (`feat(skills): a skill também
entra pela etiqueta da conversa ou do contato`, mergeado em 23/10/2026, na
1.89.0). O #3230 entregou o gatilho; esta spec fecha os buracos que impedem o
gatilho de disparar na prática.

As referências ao código citam o símbolo; quando trazem linha, ela foi conferida
na main `40db34708` (24/10/2026). Os números de operação foram medidos numa
instalação 1.89.0 em produção, numa organização só, em 26/10/2026 entre 08h50 e
09h12 (Brasília), com consulta só de leitura e sempre filtrada por
`organization_id`.

## O problema, em uma frase

A skill entra pela etiqueta, mas **ninguém põe a etiqueta na hora certa**: a
prospecção não grava o ramo no contato, o agente marca tarde (e às vezes no
lugar que a skill não lê), e o operador não tem como testar uma skill que só
entra por etiqueta.

## O que foi medido

| # | Medição | Resultado |
|---|---|---|
| M1 | Conversas de prospecção com a etiqueta do ramo (conversa ou contato), antes de qualquer correção manual | **6 de 198** |
| M2 | Gravações de etiqueta feitas pelo agente de prospecção em 30 dias (`api_audit_log`, `mcp.tool_called`, `crm_manage_tags`) | 44 no total; **3** com o ramo |
| M3 | Das 44 gravações, quantas foram no **negócio** (`target_kind: lead`) | **13** — invisíveis para a skill (o matcher lê só conversa e contato) |
| M4 | Turnos reais do agente de prospecção em 26/10 às 8h (quase todos lembretes do follow-up, sem mensagem nova do cliente) | 17 turnos; skill de ramo entrou em **6**, todas por palavra de mensagem antiga, nenhuma por etiqueta |
| M5 | `skill_activations.trigger` na organização | `hard` 208, `probe` 13 — não há como saber quantas entraram pela etiqueta |
| M6 | Botão **Testar** com skill que entra só por etiqueta | não entra: `etiquetasParaOMatcher` devolve `[]` quando há `preview` |

Onde está cada causa no código:

- **Prospecção não etiqueta.** `criarPegadaDoCandidato` (`lib/prospecting/store.ts`)
  cria contato (`createContactHandler`, sem `tags`), negócio
  (`createLeadHandler`) e conversa (`beginServiceAtOrigin`, que já grava
  `active_ai_agent_id` e `metadata.prospecting_campaign_id`). O ramo da campanha
  existe (`prospecting_campaigns.search.niche`) e não vai para lugar nenhum.
  `campaignConfigSchema` (`lib/prospecting/schema.ts`) é `.strict()` e não tem
  campo de etiqueta.
- **Etiqueta marcada no turno vale só no turno seguinte** (limite 3 declarado no
  #3230): `etiquetasParaOMatcher` lê as etiquetas antes do `matchSkills`, no
  início do turno (`inbound-turn.ts`, `skillMatch`). Na prospecção o primeiro
  turno é a primeira resposta, a mais importante.
- **Lembrete não tem mensagem nova**: o sinal do matcher é
  `recentInboundSignal` (as últimas inbound, antigas); a skill só entra por
  etiqueta ou por palavra de mensagem antiga (M4).
- **Etiqueta no negócio não ativa** (limite 1 do #3230): a consulta de
  `etiquetasParaOMatcher` junta `conversations.tags || contacts.tags`. O agente
  grava no negócio quando escolhe `target_kind: lead` (M3), e o nó
  `edit_lead_tag` dos fluxos de follow-up grava sempre no negócio.
- **Prévia não lê etiqueta** (limite 2 do #3230): `if (preview) return [];`.
- **Telemetria não separa** (limite 5 do #3230): o match por etiqueta grava
  `trigger='hard'`, o mesmo da palavra-chave; a CHECK
  `skill_activations_trigger_check` aceita só `hard` e `probe`.

## O que muda

### 1. A campanha de prospecção grava etiquetas no contato, antes do envio

- `campaignConfigSchema` ganha `contact_tags`: lista **opcional** de até 5
  etiquetas, normalizadas por `normalizarTags` (`lib/contacts/tag-normalizada.ts`,
  minúscula, 40 caracteres). Ausente = comportamento de hoje, byte a byte (a
  comparação de `activateCampaign` entre a config salva e a enviada continua
  valendo para campanha antiga).
- Na tela da campanha (`app/app/prospecting/_client.tsx`, passo da
  configuração, junto de "Qualificação"), campo **"Etiquetas do contato"**,
  pré-preenchido com o nicho da busca normalizado (`search.niche`) e editável. O
  texto de ajuda diz para que serve: "as skills com estas etiquetas entram
  desde a primeira resposta".
- Em `criarPegadaDoCandidato`, logo depois de o `contactId` existir (contato
  novo **ou** reaproveitado por `contatoDaCampanha`) e **antes** do envio, chama
  `fn_contato_adicionar_etiquetas(p_org, p_contato, p_etiquetas)` — a mesma
  junção atômica que a ação `add_tag` usa (`lib/automation/actions/add-tag.ts`,
  migration 0682). Se `adicionadas` vier não vazio, emite `contact.tag_added`
  como a ação `add_tag` emite. Falha da junção não derruba a abordagem: registra
  aviso e segue (a skill ainda entra por palavra).
- Vale para os dois modos de entrada (`funnel_entry` `on_start` e `on_send`):
  os dois passam por `criarPegadaDoCandidato`.
- **Campanha já iniciada:** nova ação `adjust_tags` na rota
  `/api/v1/prospecting`, com a mesma régua de `adjust_pace` (só campanha
  pausada, audita `previous` e `next`). Vale para os contatos criados dali em
  diante; quem já foi abordado não é reescrito.

Isto resolve, na prospecção, o limite 3 (a etiqueta já existe no primeiro
turno) e os lembretes (a etiqueta está no contato quando o lembrete roda).

### 2. A skill lê também a etiqueta do negócio

- `etiquetasParaOMatcher` passa a juntar as etiquetas dos negócios do contato do
  turno: os abertos (`crm_leads.status = 'open'`); sem negócio aberto, o mais
  recente. O contato é o da conversa do turno (`conversations.contact_id`, a
  mesma junção que a consulta já faz), sempre com `organization_id` nas três
  tabelas; nada vem do corpo de requisição.
- Continua falhando aberto: erro na leitura vira aviso e lista vazia.

Isto fecha o limite 1 e torna úteis as 13 gravações de M3 e o nó
`edit_lead_tag` dos fluxos.

### 3. O botão Testar aceita etiquetas simuladas

- `testRunSchema` (`lib/ai/agents/validation.ts`) ganha `sample_tags`: lista
  opcional, mesma normalização e teto de 20.
- `TurnPreview` ganha `tags?: string[]`; `etiquetasParaOMatcher` devolve
  `preview.tags ?? []` em vez de `[]`.
- No painel de teste (`app/app/ai/agents/[id]/_components/TestPanel.tsx`), campo
  "Etiquetas da conversa (simulação)".

Isto fecha o limite 2: o operador prova pela tela que a skill entra pela
etiqueta.

### 4. A telemetria diz por onde a skill entrou

- `matchSkills` passa a devolver o motivo de cada match (`palavra` ou
  `etiqueta`); quando os dois casam, vale `etiqueta`.
- `skill_activations.trigger` aceita `tag`. Migration nova
  `<timestamp>_<NNNN>_skill_activations_trigger_tag.sql` (NNNN por
  `pnpm checar:colisao-de-migration`), troca a CHECK para
  `('hard','probe','tag')`, idempotente, com `-- manifest:` no cabeçalho e
  apêndice no `supabase/baseline.sql`.
- O traço do turno (`traco-do-turno.ts`) já agrega `trigger` por skill, então o `tag` chega ao dado do traço. **Mostrar "entrou pela etiqueta" numa tela fica fora desta spec**: hoje nenhuma tela exibe o campo `gatilho` do traço (medido por busca em `app/` e `lib/`).

## Fora desta spec (de propósito)

- Texto de prompt, de skill e de lembrete de cada organização: é configuração,
  não produto.
- Roteador que reclassifica conversa de prospecção, lista de modelos da
  assinatura apagada na renovação do login, instrução da campanha repetida em
  todo turno: medidos na mesma sessão, não são do mecanismo de skill por
  etiqueta; vão em specs próprias.
- Reavaliar o matcher no meio do turno quando o agente põe uma etiqueta: com o
  item 1, a prospecção não precisa disso; nas conversas que o cliente começa a
  palavra-chave continua sendo a porta.

## Fatias (um PR, um commit por fatia)

1. `feat(prospeccao): a campanha grava as etiquetas do contato antes de abordar`
   — schema, `criarPegadaDoCandidato`, `adjust_tags`, tela, testes.
2. `feat(skills): a etiqueta do negócio também ativa a skill` — matcher e teste
   de isolamento.
3. `feat(skills): o Testar aceita etiquetas simuladas` — schema da prévia,
   `TurnPreview`, painel.
4. `feat(skills): a ativação registra que entrou pela etiqueta` — migration
   (tripla), `matchSkills` e gravação.

## Como provar

- **Unit, com sabotagem** (cada uma fica vermelha sem a linha do conserto):
  - `criarPegadaDoCandidato` com `contact_tags: ['estetica']` chama a junção com
    o contato novo e com o reaproveitado; sem `contact_tags`, não chama.
  - `campaignConfigSchema` sem `contact_tags` = mesma saída de hoje.
  - `adjust_tags` recusa campanha em execução e audita `previous`/`next`.
  - `etiquetasParaOMatcher` devolve a etiqueta do negócio aberto; não lê negócio
    de outra organização (dois tenants).
  - Prévia com `sample_tags: ['estetica']` casa a skill de `any_tags: ['estetica']`.
  - Match por etiqueta grava `trigger='tag'`.
- **Invariantes:** a migration passa nas duas majors do Postgres do CI.
- **Pela tela, como leigo** (banco fresco do `baseline.sql`): criar campanha,
  ver o campo pré-preenchido com o nicho, iniciar, conferir a etiqueta na ficha
  do contato antes da primeira mensagem; no Testar do agente, simular a
  etiqueta e ver a skill ativa no resultado do teste.
- **Na instalação de origem da medição**, depois do deploy: repetir M1 com os
  contatos novos (meta: todo contato de campanha com `contact_tags` nasce com a
  etiqueta) e M5 (aparecer `tag`).

## Destino

**Núcleo.** Sem `contact_tags` e sem skill com `any_tags`, nada muda; a
consulta de etiquetas só roda quando alguma skill carregada tem `any_tags`
(como já é no #3230).

— Paulo Lima Jr
