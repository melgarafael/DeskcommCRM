---
impacto: nada_mudou
secao: corrigido
titulo: Um agente pausado não cala mais o número quando há outro agente no ar nele
---

Com mais de um agente publicado no mesmo número, o atendimento escolhia o de maior prioridade sem olhar se ele estava pausado. Se o escolhido estivesse pausado, a mensagem do cliente ficava sem resposta, mesmo havendo outro agente ativo publicado no mesmo número. O contorno era mexer na prioridade à mão.

Agora quem está no ar vem sempre antes de qualquer agente pausado, e a prioridade só desempata entre agentes no mesmo estado. Quando todos os agentes do número estão pausados, o número continua sem resposta automática, como antes. Nada muda na configuração.
