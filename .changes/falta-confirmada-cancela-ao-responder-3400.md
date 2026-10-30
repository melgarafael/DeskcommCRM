---
impacto: nada_mudou
secao: corrigido
titulo: "Follow-up de falta confirmada: a resposta do paciente encerra a sequência, como a tela mostrava"
---

No gatilho **Falta confirmada pela equipe**, o interruptor "Cancelar se o lead responder" aparecia ligado e travado, mas o valor não era gravado. Para o sistema, o fluxo não cancelava. O paciente respondia "quero remarcar" e o convite seguinte da sequência saía mesmo assim, por cima do atendimento.

Agora a tela grava o valor ao salvar o gatilho. Os fluxos de falta já salvos sem ele também passam a cancelar na primeira resposta, sem precisar abrir nem salvar de novo. Quem gravou `cancel_on_reply: false` de propósito (pela API ou por importação) continua com o que escolheu, enquanto não salvar o gatilho de novo pela tela, que nesse gatilho só oferece o ligado.

Crédito: @webtecnica (conserto) e @marcelovolei15 (relato, #3400).
