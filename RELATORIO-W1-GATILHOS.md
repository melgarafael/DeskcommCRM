# W1-GATILHOS — relatório

**Worktree:** `/Users/rafaelmelgaco/fv-gatilhos` · **Branch:** `fv/gatilhos` (de `feat/followup-vivo` = `4f89a0da`)
**Autor:** DevGatilhos · **Data:** 2026-08-10

---

## 1. O que já era emitido em `event_log` (a lista levantada)

Trinta e cinco tipos, extraídos dos `p_event_type` de toda chamada a `emit_event`
em `lib/`, `app/` e `workers/` no SHA `4f89a0da` (excluindo `*.test.ts`):

```
ai.handoff_resolved            lead.created                   message.failed
ai.handoff_triggered           lead.risk_backlog_seeded       message.received
ai.responded                   lead.stage_changed             message.send_requested
ai.sentiment_alert             lead.tag_added                 message.sent
ai_agent.dispatch_requested    lead.updated                   org.updated
ai_agent.run_started           lgpd.data_request_received     user.profile_updated
contact.anonymized             lgpd.export_delivered          whatsapp.chat_id_not_recognized
contact.created                lgpd.export_generated          whatsapp.conversation_mark_failed
contact.tag_added              lgpd.redact_applied            knowledge_source.updated
contact.updated                lgpd.redact_failed             media.derive_requested
conversation.claimed           lgpd.redact_received           media.persist_requested
conversation.transferred       crm.activity_write_failed
```

Mais três emitidos por **trigger Postgres** (`fn_emit_event_on_lead_change`, via
`fn_log_event` — nenhum faz HTTP): `lead.won`, `lead.lost`, `lead.reopened`,
e `lead.assigned` na troca de dono.

Consumidores registrados hoje (`lib/event-log/register-handlers.ts`): resposta de
IA, sentimento, handoff por sentimento, indexador RAG, export e redact LGPD,
regras de automação, reatividade do follow-up, persistência e derivação de mídia
— e, agora, o gatilho de etapa.

### O achado que muda o desenho

`lead.stage_changed` sai de **exatamente três** rotas HTTP:

| Emissor | Linha | Quando |
|---|---|---|
| `app/api/v1/leads/[id]/move/route.ts` | 171 | arrasto do card no quadro |
| `app/api/v1/leads/_handler.ts` (`moveLeadHandler`) | 619 | MCP e regras de automação |
| `app/api/v1/leads/bulk/route.ts` | 200 | movimento em lote |

**`lib/leads/agent-stage-sync.ts` não é um deles.** O briefing afirmava que a
linha 220 desse arquivo emite `stage_changed` em `event_log`; medido, o arquivo
não tem uma única ocorrência de `event_log`. Ele escreve `crm_leads.stage_id`
direto (linha 238) e grava uma **atividade** em `crm_lead_activities` via
`emitLeadActivity` (linha 264). O maestro confirmou por medição independente e
corrigiu o briefing na fonte.

**Consequência que fica aberta, e não é só minha:** card movido pelo assistente
de IA não arma este gatilho — e também não dispara as **regras de automação**,
que consomem o mesmo `lead.stage_changed` (`lib/automation/engine.handler.ts:9`).
Não consertei porque o conserto muda comportamento de automação existente, fora
da minha fronteira de arquivos. Reportado ao maestro; o lugar do conserto é o
emissor, nunca um segundo produtor lendo a atividade — isso duplicaria a verdade
e passaria a disparar dois enrollments no dia em que o primeiro fosse corrigido.

---

## 2. "Caso" e "demanda": não são a mesma coisa, e o gatilho pedido colide

São **duas entidades distintas**, com donos e ciclos de vida diferentes:

| | `demandas` (migrations 0136–0138) | `agent_cases` (migration 0050) |
|---|---|---|
| O que é | o problema do cliente | o caso de **escalada** — a IA travou e passou ao humano |
| Como abre | **automática**, no primeiro `inbound` de todo contato sem demanda aberta (trigger `trg_demanda_abre_no_inbound` em `messages`) | quando o agente aciona handoff |
| Vocabulário | `estado`, `origem`, `proximo_passo`, `desfecho` | `status`, `blocker`, `followup_attempts` |
| Liga as duas | `demandas.agent_case_id` — ponteiro, não cópia | |

(O briefing citava a migration `0119`; a de demandas é a `0136`.)

Daí saem dois problemas com "caso aberto" como gatilho:

1. **Sobre `demandas`, o gatilho é vazio de significado.** Como toda primeira
   mensagem de todo contato abre demanda, "quando abrir um caso" equivale a
   "quando alguém escrever pela primeira vez" — o follow-up dispararia em cima
   de quem acabou de falar com a gente.
2. **Sobre `agent_cases`, o gatilho colide de frente com o que já existe.** A
   abertura do caso emite `ai.handoff_triggered`, e `lib/followup/reactivity.ts`
   já consome esse evento para **pausar ou cancelar** todos os follow-ups vivos
   do contato — porque tem um humano atendendo. Um gatilho que criasse um
   enrollment no mesmo evento estaria brigando com a política de handoff dentro
   do mesmo tick.

**Proposta:** o gatilho coerente é o **simétrico** — *caso encerrado*, que já
existe no schema como `conversation_end` e tem evento (`ai.handoff_resolved`, e o
fechamento de conversa que `fn_demanda_fecha_com_conversa` já observa). É o
momento em que um follow-up de pós-atendimento faz sentido. **Parei aqui e
aguardo a decisão do Rafael** antes de construir — construir "caso aberto" como
pedido literalmente entregaria um controle que briga com outro.

---

## 3. "Proposta feita": não existe tabela, e não precisa de uma

Varri `lib/`, `app/` e `supabase/`: não há entidade de proposta comercial. O que
existe é:

- **`crm_stages.agent_stage_hint`** (migration 0084) com o valor `negotiating`,
  definido no próprio classificador como *"há proposta/preço/condições na mesa e
  o lead está discutindo valor, desconto, parcelamento"*
  (`lib/agent-engine/agent/stage-classifier.ts:55`);
- `lib/leads/next-action.ts`, onde "proposta" significa outra coisa — a **próxima
  ação proposta pela IA** ao humano. Homônimo, não sinônimo.

Ou seja: **"proposta feita" já é uma etapa do funil.** No SonghaiCRM o negócio
que teve proposta é o negócio que está na coluna "Proposta enviada" (ou o nome
que o clone deu a ela). Aplicando DIRC, é caso de **Calcular/Referenciar**, não de
Duplicar: modelar uma tabela `propostas` criaria uma segunda verdade sobre um
estado que o funil já guarda, e cujo movimento já é auditado.

**Portanto o gatilho 3 está entregue pelo gatilho 1** — o usuário escolhe a etapa
"Proposta enviada" no mesmo controle. Zero tabela nova, zero campo novo.

---

## 4. O que foi construído

| Peça | Arquivo | Papel |
|---|---|---|
| Produtor | `lib/followup/gatilho-etapa.ts` | consome `lead.stage_changed`, aplica o gate, cria o enrollment, grava a proveniência |
| Adapter | `lib/followup/gatilho-etapa.handler.ts` | pluga no dispatcher genérico do `event_log` |
| Registro | `lib/event-log/register-handlers.ts` | +1 linha |
| Publish | `app/api/v1/ai/followup-flows/[id]/publish/route.ts` | libera `stage_change`; recusa etapa ausente, apagada ou arquivada |
| Tela | `.../TriggerConfigControl.tsx` | terceiro tipo de gatilho, seletor de etapa **por nome** |
| Leitura | `hooks/followup/useEtapasDeGatilho.ts` | id → nome da etapa, agrupada por funil |

**Event-driven, não time-driven**, porque "o lead entrou na etapa X" é um evento
com hora e autor — ao contrário de silêncio, que é ausência de evento e por isso
continua sendo varredura no tick do cron.

**As três regras do motor, respeitadas e provadas:** o índice org-wide
`idx_followup_enrollments_one_live` barra o segundo enrollment (23505 é caminho
normal, vira `skipped_existing`); `resolveAgentForAutomaticTrigger` gateia e
devolve o `agent_id` pinado; nada roda dentro da transação do banco.

**Sem migration.** A `0143` continua livre: não há mudança de schema. A
proveniência do enrollment (de que negócio, de qual etapa para qual, e por qual
linha do `event_log`) entra como `enrolled_by_stage_change` em
`followup_enrollment_events`, que já existe e já é a timeline que a fila lê. Uma
coluna `origem` em `followup_enrollments` seria uma segunda verdade sobre o mesmo
fato.

### Duas decisões de tela que não são cosméticas

- **A etapa é escolhida pelo nome, agrupada por funil.** Duas etapas podem se
  chamar "Proposta" em funis diferentes; sem o cabeçalho do funil, o operador
  escolheria a errada sem ter como saber.
- **O rótulo diz *quando*.** O disparo depende de dois crons de um minuto (o
  dreno do `event_log` e o tick do motor), então a tela promete "poucos minutos",
  não "na hora". Prometer instantâneo seria o controle mentindo sobre a própria
  função — que é exatamente o defeito que esta missão existe para consertar.
- **`conversation_end` continua escondido e continua recusado no publish**, porque
  continua sem produtor. A honestidade do arquivo foi preservada.

### Um efeito colateral em teste alheio

`tests/e2e/followup-builder.spec.ts` congelava "o seletor oferece exatamente 2
opções e nenhuma de `stage_change`". Ela reprovava, de propósito, a ausência do
produtor que esta entrega criou — atualizei para 3 opções, mantendo a asserção de
que `conversation_end` não aparece.
