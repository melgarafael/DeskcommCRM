---
impacto: correcao
secao: corrigido
titulo: A conferência de fato do Jev passa a valer também no "Sugerir resposta" do modo assistido
---

A camada que confere se o agente afirma um fato do negócio que não está no material consultado (#2231) só rodava no envio automático. No modo assistido, em que o "Sugerir resposta" gera um rascunho e uma pessoa aprova o envio, o rascunho passava sem essa conferência, e a tarefa "Conferir afirmações de fato" do Jev nunca tinha o que observar. Medido numa instalação v1.80.0: 533 rascunhos e nenhuma observação dessa tarefa. Agora o rascunho e o "Testar" passam pela mesma conferência do envio real. Quem decide continua sendo o estado da tarefa: desligada, nada muda; só observando, o rascunho sai e a observação é gravada; decidindo, o fato contradito ou sem base aparece como impedimento no rascunho, em vez de sair para o cliente depois de aprovado. A resposta já aprovada por uma pessoa não é conferida de novo. Nenhuma mudança de banco e nada a fazer na VPS.

Contribuição de @rogercampel (fecha #2923).
