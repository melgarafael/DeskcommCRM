---
impacto: nada_mudou
secao: corrigido
titulo: O pedido de atualização agendado para a janela de manutenção não é mais cancelado por um segundo clique
---

Com `SYSTEM_UPDATE_WINDOW` configurada, o pedido feito fora da janela fica de pé até ela abrir — é assim que o agente do host agenda a atualização para a madrugada. Mas a tela de atualização fechava qualquer pedido com mais de 15 minutos como "Run abandonado: o agente do host não reportou o desfecho a tempo", então um segundo clique no meio da tarde cancelava, em silêncio, a atualização que rodaria de madrugada. Agora o prazo só começa a contar quando a janela abre, e quem clica de novo recebe a resposta certa: o pedido continua agendado e não foi cancelado. Instalação sem janela configurada não muda em nada.

No Inbox, a recarga pedida pelo tempo real passou a refazer só a primeira página da lista (antes refazia todas as páginas já carregadas, uma atrás da outra) e a conversa aberta recebe a mensagem no lugar, sem busca: mensagem nova entra no topo, confirmação de enviada/entregue/lida é mesclada pelo id. Com seis páginas carregadas, cada mensagem recebida custava seis requisições da lista; agora custa uma.

Crédito: @webtecnica, que mediu as duas portas (#4334, #4325).
