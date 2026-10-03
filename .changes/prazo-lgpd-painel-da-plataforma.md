---
impacto: nada_mudou
secao: corrigido
titulo: O painel da plataforma para de marcar "Vencido" na véspera do prazo, e a contagem de "Vence em" passa a contar até o fim do dia
---

Em **Admin › LGPD**, o selo de risco e a coluna "Vence em" liam o prazo como um
**instante**, e o prazo é um **dia**. O efeito, medido com um prazo no dia 05/10:

- o selo dizia **Vencido** a partir das 22h do dia **04/10** — quando o prazo ainda
  era o dia seguinte;
- a coluna dizia **1h em atraso** nessa mesma hora, e **12h em atraso** às 9h da
  manhã do dia 05/10, quando o prazo ainda vencia naquele dia.

Agora os dois leem o dia que o motor contou. O selo só fica **Vencido** depois que
o dia do prazo acaba, e a coluna mostra as horas que faltam até o fim dele — "1d
restantes" na véspera, "12h restantes" às nove da manhã do dia do prazo e "0h
restantes" na última hora. Nenhuma palavra nova entra na tela: as quatro formas de
antes continuam as quatro de agora, e o que muda é a hora a que cada uma aparece.

Um ganho que vem junto: o selo da plataforma e o balde da lista da organização
passam a marcar "vencido" **no mesmo instante**. Antes um contava dias e o outro
conta milissegundos, e os dois discordavam — o que é a pior forma de erro num
painel de quem decide o que cobrar primeiro.

Continua como estava, e é do motor e não da leitura: as três horas entre o fim do
dia do prazo no relógio do servidor e a meia-noite no relógio do Brasil. As telas de
detalhe, a coluna de prazo da organização e o alerta do painel da instalação ainda
usam a regra antiga, e estão nomeadas na lista de dívida do teste que vigia os
consumidores do prazo. Nada é preciso fazer na instalação.
