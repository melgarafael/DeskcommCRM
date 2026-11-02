# Medição da latência do turno do agente (#1099)

Esta issue é a medição que autoriza (ou veta) a quarta mudança de latência proposta
no PR #849. **Nenhuma mudança de comportamento de envio foi feita nesta rodada.**

## 1. O que foi medido

O caminho de uma mensagem do cliente até a primeira bolha tem duas partes: a **espera
antes do turno** (debounce + fila do drain) e o **turno em si** (`executarTurnoDoAgente`,
`lib/agent-engine/agent/inbound-turn.ts`). Pontos de instrumentação:

| Fase | Onde está no código | Instrumentação |
|---|---|---|
| Espera antes do turno | `event_log.created_at` → `job_queue.run_after` (debounce `INBOUND_DEBOUNCE_MS`, `lib/agent-engine/env.ts`) → `job_queue.locked_at` (claim do drain, tick ocioso `CRM_DRAIN_IDLE_INTERVAL_MS`) | só as colunas de tempo nas tabelas; **não instrumentada por log** (ver NÃO MEDIDO) |
| Classificadores auxiliares (estágio + jailbreak + Jev) | `Promise.all` de `classifyStage`, `classifyJailbreak` e `perguntaAoJev` em `executarTurnoDoAgente` | campo `classificadores_ms` no log `turno do agente concluído` (#1099) |
| Chamada ao modelo (LLM) | `lib/agent-engine/edge/llm/run-model-call.ts` | `llm_calls.latency_ms` por chamada; `latency_ms` também volta em `BotResponse` (`lib/ai/types.ts`) |
| Pausa humana (atraso antes da 1ª bolha) | `esperarComoHumano` em `lib/agent-engine/agent/atraso-humano.ts` | log `atraso humano antes da 1ª bolha` com `atraso_ms`; desconta `processamentoMs` (processamento ANTES da 1ª bolha, #849) |
| Throttle anti-ban entre bolhas/envios | `runBeforeSend` em `lib/agent-engine/guardrails/before-send.ts` (o `sleep` de `throttleWaitMs`) e `decidePacing` em `lib/agent-engine/pacing/engine.ts` | `waitMs = max(0, throttleMs + jitter - (now - lastSentAt))`; não logado por envio |
| Escoamento da fila (lote) | `runDrainLoop` em `lib/agent-engine/edge/crm/drain.ts` (comparação com `knobs.batchSize`) | lote cheio não espera o tick ocioso |
| Turno inteiro | de `inicioDoProcessamento` ao fim de `executarTurnoDoAgente` | campo `duracao_do_turno_ms` no log `turno do agente concluído` (#1099) |

Atenção a duas armadilhas de nome:

- `agent_turn_traces.latency_ms` (gravado por `registrarTracoDoTurno`, `lib/agent-engine/agent/traco-do-turno.ts`) é `max(llm_calls.latency_ms)` do job: a chamada de LLM **mais lenta**, não o total do turno. Não use como `T_total`.
- `duracao_do_turno_ms` inclui pausa humana e throttle; `processamentoMs` (o desconto do #849) é só o processamento antes da 1ª bolha. São números diferentes.

## 2. Metodologia

1. Coletar, em instalação com carga real de WhatsApp, por **pelo menos 7 dias**:
   - log `turno do agente concluído` (`duracao_do_turno_ms`, `classificadores_ms`) + `atraso humano antes da 1ª bolha` (`atraso_ms`);
   - `llm_calls.latency_ms` (modelo) e `duracao_ms` de ferramentas no traço;
   - `event_log.created_at`, `job_queue.run_after` e `job_queue.locked_at` dos jobs de inbound (query, não log).
2. Decompor cada mensagem em:
   - `T_debounce = job_queue.run_after - event_log.created_at`
   - `T_fila = job_queue.locked_at - job_queue.run_after` (espera do claim do drain)
   - `T_classif = classificadores_ms`
   - `T_llm = soma de llm_calls.latency_ms do job`
   - `T_pausa = atraso_ms logado`
   - `T_throttle = soma do throttleWaitMs no turno` (hoje não logado — precisa de instrumentação antes de medir)
   - `T_turno = duracao_do_turno_ms`
   - `T_total = T_debounce + T_fila + T_turno`
3. Calcular p50/p95/p99 de cada componente e a fração de `T_total` que cada um representa.

O log `turno do agente concluído` só sai no caminho em que o turno termina normalmente;
turno vetado, em handoff ou com erro não o emite, e fica fora da amostra.

## 3. Tabela medida

Sem carga real de WhatsApp disponível nesta rodada, **a tabela fica vazia de propósito**.
Preencher com números medidos; número inventado é o pior resultado possível aqui.

| Componente | p50 (ms) | p95 (ms) | p99 (ms) | % do total | n |
|---|---:|---:|---:|---:|---:|
| Debounce (`T_debounce`) | — | — | — | — | 0 |
| Fila do drain (`T_fila`) | — | — | — | — | 0 |
| Classificadores (paralelo) | — | — | — | — | 0 |
| LLM (`llm_calls.latency_ms`) | — | — | — | — | 0 |
| Pausa humana (`atraso_ms`) | — | — | — | — | 0 |
| Throttle anti-ban entre envios | — | — | — | — | 0 |
| **Total (`T_total`)** | — | — | — | 100% | 0 |

## 4. A conta da quarta mudança (a da issue #1099)

A quarta mudança do PR #849, nos termos da issue, são duas trocas de padrão por latência:

1. **`INBOUND_DEBOUNCE_MS` 8000 → 4000.** Responde mais perto da rajada; o comentário em `lib/agent-engine/env.ts` diz por que o número é 8000 (responder em rajada é gatilho de ban).
2. **`CRM_DRAIN_IDLE_INTERVAL_MS` 15000 → 2000.** O tick ocioso faz dois `update` (reaper + claim): de ~11.520 para ~86.400 consultas por dia numa instalação sem atendimento (conta, não medição; ver issue #258 sobre o egress).

**Condição de autorização (a ser verificada com os números da tabela):**

- `T_debounce` e `T_fila` respondem, juntos, por uma fração relevante de `T_total` (sem a decomposição não se sabe qual das duas trocas responde pela melhora);
- a mudança de debounce traz teto na janela deslizante e preserva a exclusão de job em espera do #830 (`not (payload ? 'held_run_after')` em `drain.ts`), provada por invariante em `pnpm test:db`;
- o aviso de anti-ban continua no `env.ts` se o número mudar.

### Proposta adicional (não pedida pela issue)

O throttle entre envios poderia deixar de dormir quando `now - lastSentAt` já cobre
`throttleMs + jitter` (trocar o padrão fixo por tempo decorrido). Para avaliar:

- distribuição de `now - lastSentAt` no momento do envio;
- fração de envios em que `now - lastSentAt >= throttleMs + jitterMaxMs`;
- ganho mediano ≥ 2× o jitter máximo (`jitterMaxMs`, ≤ 800 ms por padrão) em ≥ 50% dos turnos;
- nenhum caso de `lastSentAt` nulo/stale em produção (senão o throttle viraria 0 por engano).

Custo: risco de banimento se `lastSentAt` estiver errado (relógio do daemon vs. do banco,
sessão compartilhada, envio concorrente no mesmo número).

## 5. Decisão desta rodada

**Não mexer.** A conta não fecha sem os números da tabela. Reduzir debounce, tick ocioso
ou throttle com base em suposição compraria latência pagando com o canal do cliente
(banimento) ou com a cota de banco.

Reabrir quando a tabela da seção 3 estiver preenchida com carga real de WhatsApp.
Até lá, manter o comportamento atual.

## NÃO MEDIDO

- Nenhuma latência foi medida: a tabela está vazia.
- Os campos novos (`duracao_do_turno_ms`, `classificadores_ms`) não foram observados chegando ao log num turno real.
- A espera antes do turno (debounce + fila do drain) **não é instrumentada por este PR**: só pode ser medida por query em `event_log`/`job_queue`.
- O `throttleWaitMs` não é logado por envio; `T_throttle` precisa de instrumentação antes de entrar na tabela.
