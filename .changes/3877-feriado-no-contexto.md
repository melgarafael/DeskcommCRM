---
impacto: capacidade_nova
secao: corrigido
titulo: O agente passa a saber quando hoje ou amanhã é feriado nacional
---

Em 2 de novembro de 2026 — Finados, feriado nacional — o agente respondia
"atendemos hoje até as 18h" e chegava a convidar a pessoa a ir até a loja, com a
empresa fechada. O motivo não era o modelo: o turno recebia o horário de
funcionamento da semana e o dia da semana, mas nada dizia que aquele dia é
feriado. O calendário brasileiro já existia no sistema (é o mesmo usado no prazo
da LGPD); ele só não chegava ao atendimento.

Agora o bloco de contexto do turno traz o fato, logo depois do relógio: se hoje
é feriado, se amanhã é feriado, ou — nos dias comuns — a negativa explícita de
que nenhum dos dois é. Com o fato na mão, o agente não promete o expediente
normal no feriado e não convida ninguém a ir até a loja sem confirmar com a
equipe. Nos dias comuns nada muda.

A data é sempre a do fuso da organização, então às 21h de um feriado o agente
ainda está falando do feriado, e não do dia seguinte, como aconteceria se a data
fosse lida em UTC. Organização cujo país não é o Brasil não recebe feriado
brasileiro no contexto.

Nada muda para quem já usa o sistema além do que o agente passa a saber: não há
migração, não há configuração nova, e nenhum envio passa a ser bloqueado em
feriado — o agente recebe o fato e decide com ele. Empresa que abre no feriado
continua atendendo normalmente.

Feriados municipais e estaduais cadastráveis e o aviso de fora do horário
considerar feriado ficam para depois.

Contribuição de @webtecnica (#3877).
