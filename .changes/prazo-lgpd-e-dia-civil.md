---
impacto: nada_mudou
secao: corrigido
titulo: O prazo de uma solicitação LGPD passa a sair no dia certo no e-mail ao DPO, e a lista deixa de marcar "Vencido" na véspera
---

O prazo que o produto calcula é um **dia útil** do calendário do país, contado a partir do dia em que o pedido entrou. O valor gravado é a meia-noite UTC desse dia — e quem lia esse valor redesenhava o instante no fuso de quem estava lendo, o que jogava o prazo um dia para trás em toda instalação brasileira. O efeito era visível em três lugares: o **e-mail de alerta que vai para o DPO** anunciava o vencimento com a data do dia anterior e dizia "1 dia(s) em atraso" no próprio dia do prazo; a **lista de solicitações** classificava a linha como "Vencido" a partir das 21h do dia anterior ao prazo, com quase um dia pela frente; e o **painel da instalação** acendia o alerta de LGPD em risco na mesma hora.

Agora o e-mail ao DPO traz a data do dia que foi contado, e o selo da lista e a contagem de atraso do e-mail passam a ler o dia, não o instante. No Brasil, o pedido passa a contar como vencido às 21h do **próprio** dia do prazo, e não mais às 21h do dia anterior; as três horas que sobram vêm de o prazo ser contado no relógio UTC e ficam para um próximo conserto. O que estava certo continua igual: o dia útil contado, os feriados do país da organização e o recebimento em fim de semana ou feriado, que continuam começando no próximo dia útil. Nada é preciso fazer na instalação, e nenhuma solicitação existente muda de prazo — as que já foram gravadas passam a sair na data correta no e-mail e no selo da lista.

Ainda seguem a régua antiga, e são o próximo conserto: o alerta "LGPD em risco" do painel da instalação; o selo de risco e o aviso de pedidos vencidos na página de LGPD da administração da instalação; e o texto de prazo nas telas de detalhe, na coluna de prazo da lista e na contagem de horas da administração.
