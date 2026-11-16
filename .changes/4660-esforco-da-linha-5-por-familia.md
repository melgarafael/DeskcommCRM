---
impacto: nada_mudou
secao: corrigido
titulo: Quem liga o esforço de raciocínio da OpenAI volta a receber resposta no GPT-5 e na linha 5.1 a 5.6
---

Com `OPENAI_REASONING_EFFORT` ligado, o valor escolhido era enviado como estava para o GPT-5, o GPT-5 Mini e o GPT-5 Nano, que não aceitam `none`, e `minimal` ia assim para toda a linha GPT-5.1 a 5.6, que não aceita esse valor. A OpenAI recusava a chamada e o agente não respondia — no turno, no rascunho e no fechamento.

Agora o pedido de velocidade vira o esforço mais rápido que cada família aceita: `minimal` no GPT-5, no GPT-5 Mini e no GPT-5 Nano, e `none` do GPT-5.1 ao GPT-5.6. Os valores que o modelo já aceitava continuam passando intactos, e o comportamento da linha GPT-6 não muda. Nenhuma ação é necessária na atualização.

Contribuição de @webtecnica (#4673).
