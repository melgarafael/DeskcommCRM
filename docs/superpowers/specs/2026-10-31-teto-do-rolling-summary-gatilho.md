# Teto do `rolling_summary`: adiado, com gatilho

**Estado:** sem código. Nenhum knob existe. Este arquivo registra o gatilho e o desenho para a
decisão não virar carta morta. Frente F do estudo de tokens de 31/10/2026.

## Por que não agora

O resumo acumulado (`lead_checkpoints.rolling_summary`) se estabiliza sozinho: o maior medido
tinha 1.831 caracteres, e o p95 do último checkpoint por contato era 1.179. Um teto hoje não
corta nada e custaria uma chamada de modelo a mais por turno para nada. O knob
`ROLLING_SUMMARY_MAX_TOKENS` só nasce no mesmo PR da implementação, porque knob sem consumidor é
evento sem consumer (anti-pattern 3).

## Gatilho

Implementar quando o p95 do último checkpoint por contato passar de **2.500 caracteres**. A
medição, só leitura, roda na instalação e não depende de quem lê este arquivo lembrar o número:

Por `seq`, não por `created_at`: `created_at` pode empatar, e `seq` é a ordem que o agente usa
para ler o último checkpoint (`latestCheckpoint`, `lib/agent-engine/agent/inbound-turn.ts`).

```sql
with u as (
  select distinct on (organization_id, contact_id) length(rolling_summary) l
  from lead_checkpoints
  order by organization_id, contact_id, seq desc
)
select percentile_cont(0.95) within group (order by l) from u;
```

## Desenho (quando o gatilho disparar)

- Um pedido extra ao modelo barato, **só** quando o resumo passa do teto, no fechamento do
  turno (`fecharOTurno`, `lib/agent-engine/agent/abertura/checkpoint.ts`).
- A versão condensada só é aceita se parsear, ficar menor e **preservar todo token com dígito**
  (data, valor, telefone, número de pedido). Falhou qualquer um, fica o original.
- `commitments`, `objections`, `next_action` e `declaracao` nunca são trocados: só o
  `rolling_summary`.
- Teste de fechamento do turno: resumo acima do teto sai menor com os dígitos intactos; resumo
  condensado que perde um dígito é recusado e o original fica.
- O knob `ROLLING_SUMMARY_MAX_TOKENS` nasce DESLIGADO, e desligado o fechamento é byte a byte o
  de hoje.
