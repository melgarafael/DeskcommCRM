---
impacto: nada_mudou     # nada_mudou | capacidade_nova | exige_acao
secao: corrigido        # adicionado | alterado | corrigido
titulo: O agente de IA responde no WhatsApp bem mais rápido
---

O tempo entre a mensagem do cliente e a resposta do agente estava em 55-67
segundos, a maior parte gasta em polling e classificadores auxiliares que
rodavam em série sem precisar. Quatro ajustes independentes reduzem esse
tempo sem mudar nenhuma decisão de guardrail, sem risco de duplicar ou
perder mensagem, e sem exigir nada do operador:

- o drain do event_log escoa lotes cheios sem esperar o intervalo ocioso e
  faz polling mais rápido quando está de fato ocioso;
- a coalescência de rajada (debounce) passa a renovar a janela de um job já
  pendente em vez de esperar um debounce fixo depois de CADA mensagem;
- o atraso "humano" antes de enviar desconta o tempo que o turno já gastou
  processando, em vez de somar por cima;
- o classificador de estágio do funil e o classificador anti-jailbreak, que
  são independentes um do outro, passam a rodar em paralelo em vez de em
  série.
