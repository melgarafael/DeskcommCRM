---
impacto: nada_mudou
secao: corrigido
titulo: A instalação não morre mais no fim, numa VPS que nunca teve tarefas agendadas
---

Numa VPS recém-provisionada — que nunca teve nenhuma tarefa agendada, o estado
normal de quem contrata uma máquina nova — o instalador **morria no fim, sem mensagem nenhuma**, logo depois de ativar as automações.

O que acontecia: o comando que lê as tarefas agendadas "reclama" quando não há
nenhuma, e essa reclamação derrubava o script inteiro. A ironia é que a tarefa
**já tinha sido gravada** nesse ponto: a instalação estava correta e parecia ter
quebrado.

Agora o instalador entende que "não existe nenhuma tarefa ainda" é uma resposta
normal e segue até o fim, com a mensagem de sucesso.

Achado por um contribuidor de fora, que instalou numa VPS limpa e viu.
