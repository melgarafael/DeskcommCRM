# Spec 17 — Índice de Atrito

> Medir o propósito declarado. Doutrina: [`../doctrine/sistema-vivo/03-medida-do-proposito.md`](../doctrine/sistema-vivo/03-medida-do-proposito.md).

**Estado:** mapeamento concluído · implementação não iniciada
**Medido em:** `96678e21`

---

## 1. O problema que esta spec resolve

O propósito do sistema é **resolver o relacionamento cliente↔empresa com o menor atrito possível para os dois lados**. Hoje não existe nenhum número para "atrito".

O que existe é `GET /api/v1/metrics/attendants` → `won`, `lost`, `conversations_handled`, `avg_first_response_seconds`, e o funil por estágio. Todas medem **atividade e conversão**.

A consequência concreta, e não é hipotética: **um agente que insiste seis vezes converte mais e queima relacionamento — e nos painéis atuais aparece como o melhor agente da organização.** `agent_cases.followup_attempts` já conta a insistência, e nenhuma tela lê essa coluna.

---

## 2. O achado central do mapeamento

**A maior parte do índice já é derivável dos dados de hoje.** De 13 componentes especificados na doutrina:

| Classe | Qtd | Significado |
|---|---|---|
| ✅ **Derivável hoje** | 8 | Só falta consulta + tela |
| ◐ **Precisa de definição** | 3 | O dado existe; falta decidir a régua |
| ✗ **Precisa de instrumentação** | 2 | Não há como derivar do que existe |

Nenhum componente exige mudança de schema no caminho quente.

---

## 3. Mapeamento componente a componente

### 3.1 Lado do cliente

| Componente | Estado | Fonte |
|---|---|---|
| **Turnos até o desfecho** | ✅ | `count(messages)` por `conversation_id` entre `agent_cases.opened_at` e `closed_at` |
| **Opt-out** | ✅ | `contacts.is_blocked` + `blocked_at` (gravado pela detecção de STOP no inbound) |
| **Pedido explícito de humano** | ✅ | `crm_lead_activities` tipo `handoff_triggered` + `conversations.last_handoff_reason` + `contacts.force_human` |
| **Insistência do agente** ⭐ | ✅ | `agent_cases.followup_attempts` — **coluna já existe e nenhuma tela a lê** |
| **Abandono** | ◐ | Derivável: sem `inbound` após a última `outbound` e sem desfecho. **Falta definir a janela por canal** |
| **Reabertura** | ◐ | Novo `agent_cases` na mesma `conversation_id` em janela curta. **Falta definir a janela**; e só cobre casos, não leads (dependência do cap. 5) |
| **Tempo até a 1ª resposta *útil*** | ◐ | `avg_first_response_seconds` já existe, mas mede a **primeira** resposta, não a útil. **Falta definir "útil"** — proposta em §5 |
| **Repetição da mesma pergunta** | ✗ | Exige comparação semântica entre mensagens `inbound` da mesma demanda. Infra de embedding existe (`lib/ai/embed.ts`); o cálculo não |
| **Espera não comunicada** | ✗ | Depende de o sistema conhecer o próprio prazo — não existe (dívida do cap. 6.6) |

### 3.2 Lado da empresa

| Componente | Estado | Fonte |
|---|---|---|
| **Intervenções humanas por desfecho** | ✅ | `messages.sent_via = 'user'` · `agent_case_events.actor_kind = 'human'` |
| **Vetos por execução** | ✅ | `before_send_traces` por `job_id` — já tem `vetoed_gate` e `vetoed_code` |
| **Retrabalho** | ✅ | `agent_case_events.kind = 'escalated'` + `human_action = 'escalate'` |
| **Espera na fila humana** | ✅ | `agent_cases.opened_at` → primeiro evento `human_replied`. Alternativa: `conversations.assigned_at` → primeira `messages` com `sent_via = 'user'` |
| **Tempo humano por desfecho** | ◐ | Aproximável por soma de intervalos entre eventos de ator humano no mesmo caso. **É proxy, e a spec deve dizê-lo no rótulo** |

### 3.3 Achado não previsto na doutrina — resposta por fora do sistema

`messages.sent_via` tem três valores que importam, e o terceiro não estava previsto:

| Valor | Quem escreve | O que significa |
|---|---|---|
| `ai` | `app/api/v1/messages/_handler.ts:302` (ator ≠ user) | O agente respondeu |
| `user` | mesmo handler (ator = user) | Humano respondeu **pelo sistema** |
| `external_device` | `lib/waha/ingest.ts:407,611` | Humano respondeu **pelo celular, fora do sistema** ⚠️ |

**`external_device` é uma métrica de atrito da empresa** — e possivelmente a mais honesta que existe. Ela mede quantas vezes o operador contornou a ferramenta. Um sistema com atrito baixo para a empresa tem essa contagem caindo; um sistema que atrapalha tem essa contagem subindo, e nenhum outro indicador denuncia isso.

Incluir como componente próprio: **taxa de contorno** = `external_device ÷ (user + external_device)`.

---

## 4. Os pares eficiência/dano

Regra 3.3 da doutrina: toda métrica de eficiência é publicada ao lado da contra-métrica que denuncia seu custo, no mesmo painel e com o mesmo destaque.

| Eficiência (já existe) | Contra-métrica (a construir) | Estado |
|---|---|---|
| `won` / taxa de conversão | Turnos até desfecho · opt-outs · insistência média | ✅ derivável |
| `conversations_handled` | Abandono · reabertura | ◐ definição |
| `avg_first_response_seconds` | Repetição da mesma pergunta | ✗ instrumentação |
| Automação (% sem humano) | Pedidos de humano · **taxa de contorno** · **repetição depois da passagem** | ✅ derivável |
| Custo por conversa | Tempo humano por desfecho | ◐ proxy |

**A repetição depois da passagem** (migration 0294) é o laço de retorno da entrega de contexto na
passagem para humano: das passagens em que o cliente VOLTOU a falar nas 24 h seguintes, em quantas
ele teve de repetir o que já tinha dito (limiar 0,7, o mesmo do índice de repergunta). Se o
briefing chega a quem assume, ela cai; se não chega, não muda. Numerador e denominador viajam
separados (`repeticao_pos_passagem` / `passagens_medidas`) porque é a borda que transforma
denominador zero em `—`, e não em `0%`. Para ver a régua em vigor sem confiar nesta linha:
`grep -n "repeticao_pos_passagem" -B24 supabase/baseline.sql | head -40`.

---

## 5. Decisões pendentes

Três réguas precisam ser fixadas antes da implementação. Nenhuma tem resposta óbvia e todas afetam comparabilidade histórica.

**5.1 O que é "primeira resposta útil".** Proposta: a primeira `outbound` do agente que **não** é apenas acusar recebimento. Operacionalização barata, sem modelo: a primeira `outbound` que ocorre **depois** de o agente ter chamado alguma ferramenta de leitura ou escrita no mesmo turno — ou seja, a primeira resposta que teve trabalho por trás. Descarta "Olá! Já vou verificar" sem precisar classificar texto.

**5.2 A janela de abandono.** Depende do canal: em WhatsApp, 48h sem resposta significa outra coisa que em e-mail. Proposta: knob por canal, começando em 72h, e a decisão fica em `channel_knobs` — o que satisfaz o invariante 6 (configuração com superfície).

Na consulta por período, a base é o número de conversas com pelo menos um envio no intervalo, mesmo que tenham recebido outro envio, resposta ou encerramento depois. Cada conversa entra uma vez. O abandono considera a última saída dentro do intervalo e, no instante da consulta, a conversa ainda sem resolução ou encerramento, sem resposta posterior e com silêncio acima da régua da organização.

**5.3 O denominador.** A doutrina exige que seja o **desfecho por demanda**, e a demanda ainda não é entidade de primeira classe (cap. 5). `agent_cases` é o embrião mais próximo — tem `opened_at`, `closed_at`, `status` com desfecho e vínculo com conversa e lead.

**Decisão recomendada:** usar `agent_cases` como denominador da Fase 1, **rotulando explicitamente** que o índice cobre demandas que passaram por caso — não o total. Um índice com escopo declarado é honesto; um índice que finge cobrir tudo destrói a comparação quando o escopo mudar.

---

## 6. Faseamento

**Fase 1 — o que já é derivável (nenhuma mudança de schema).**
Os 8 componentes ✅ + a taxa de contorno. Uma função de agregação e uma tela. Entrega o par eficiência/dano completo para conversão e automação, que são os dois com maior risco de otimização perversa.

**Fase 2 — as definições.** Fixar 5.1, 5.2 e 5.3; `channel_knobs` ganha a janela de abandono com superfície de configuração.

**Fase 3 — a instrumentação.** Repetição semântica (usa a infra de embedding existente) e, dependente do cap. 6.6, espera não comunicada.

**Fase 4 — o denominador definitivo.** Migrar para a entidade de demanda quando o cap. 5 for implementado.

---

## 7. Living System Checklist

| Pergunta | Resposta |
|---|---|
| Quem me alimenta? | `messages` · `agent_cases` · `agent_case_events` · `before_send_traces` · `contacts` · `crm_lead_activities` |
| Quem eu alimento? | Tela de métricas (`/app/metrics`) · e o flywheel, como sinal de qualidade por agente |
| Que registro eu emito? | Nenhum — é agregação de leitura. **Justificado:** não muta estado |
| Onde apareço na tela? | `/app/metrics`, ao lado das métricas de eficiência que ele já mostra — nunca em aba separada (regra 3.3: separados, a de eficiência vence sempre) |
| Por qual porta se chega? | `/app/metrics` já está em `lib/navigation/registry.ts` |
| Qual meu anti-morte? | N/A — peça de leitura. **Justificado** |
| Onde se configura? | Janela de abandono em `channel_knobs`, com tela (Fase 2) |
| Qual a continuidade IA↔humano? | N/A — não participa do turno |
| **Qual meu laço de retorno?** | **É o laço.** O índice por agente alimenta o flywheel: agente com atrito alto e conversão alta é candidato a revisão. Sem isso, esta spec seria um painel — invariante 7 |
| Atualizei o mapa? | Pendente na implementação |
