---
impacto: nada_mudou
secao: corrigido
titulo: O painel da instalação deixa de contar prazo de LGPD a mais e de anunciar atraso na véspera
---

No painel da instalação, o cartão "LGPD em risco" e a lista de alertas mediam o prazo pela meia-noite do servidor, que no Brasil cai às 21h do dia anterior ao vencimento. Por isso o alerta anunciava **"Requisição LGPD vencida"** a partir das 21h da véspera do prazo e continuava assim durante todo o dia do vencimento; agora só anuncia depois que o dia do prazo acaba, junto com o selo da lista e o e-mail ao DPO.

O cartão também contava a mais: um pedido que vencia em cinco dias e meio entrava na janela de cinco dias. Agora a janela olha o fim do dia do prazo, então quem expira dentro de cinco dias entra e quem expira depois fica de fora. Nenhum prazo existente muda, e nada é preciso fazer na instalação.

A data que aparece no alerta passa a ser sempre o dia do prazo, e não mais o que o relógio do servidor mostrasse — medido, o mesmo pedido aparecia como 05/10 num servidor em UTC e 04/10 numa máquina em São Paulo.
