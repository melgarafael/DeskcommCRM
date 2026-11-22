---
impacto: nada_mudou
secao: corrigido
titulo: A janela de manutenção da atualização é lida no fuso do servidor, e não mais no fuso do contêiner
---

Com `SYSTEM_UPDATE_WINDOW` configurada, o app decidia quando o pedido agendado podia ser dado como abandonado lendo a hora no fuso do próprio processo — que no contêiner é UTC —, enquanto o `agent.sh` lê o relógio de parede do servidor, em UTC−3. Nas horas em volta da meia-noite os dois discordavam por três horas: o app liberava o fechamento do pedido às 23h20 e a janela só abria às 2h00, e nesse intervalo um segundo clique cancelava o agendamento que a janela existe para proteger.

Agora a janela é lida num fuso declarado, `America/Sao_Paulo` por padrão (o mesmo do `date +%H:%M` do agente), e o fuso do processo não entra mais na conta: um `TZ` trocado no contêiner não move a janela em silêncio. Quem instala num servidor de outro fuso declara `SYSTEM_UPDATE_WINDOW_TZ` com a zona do servidor. Nada muda para quem não usa a janela.

Crédito: @webtecnica (#4504).
