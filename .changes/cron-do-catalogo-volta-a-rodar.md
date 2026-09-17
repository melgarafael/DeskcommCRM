---
impacto: nada_mudou
secao: corrigido
titulo: A atualização diária da lista de modelos de IA voltou a rodar
---

Numa instalação nova, a tarefa que atualiza todos os dias a lista de modelos de inteligência artificial disponíveis era recusada pelo próprio sistema e não fazia nada. O instalador cria dois segredos diferentes para as tarefas agendadas, e essa tarefa — só ela, entre as vinte e quatro — aceitava apenas um deles, enquanto o agendador usa o outro. Como a saída dessas chamadas não é guardada, a recusa diária não aparecia em lugar nenhum.

Você não precisa fazer nada: nenhuma configuração muda e nenhum segredo precisa ser trocado. A tarefa passa a ser aceita como as demais.

Também saiu do projeto o arquivo de agendamento que só servia a uma plataforma de hospedagem que o produto não usa, junto com a exigência de mantê-lo atualizado a cada tarefa nova. A lista que vale continua sendo a do agendador que acompanha a instalação, e ela segue protegida: tarefa sem agendamento, ou agendamento apontando para tarefa que não existe, continuam reprovando na verificação automática.
