---
impacto: capacidade_nova
secao: alterado
titulo: O atendimento automático responde em menos tempo
---

Três mudanças no caminho entre a mensagem chegar e a IA responder, todas
medidas numa instalação real cujo atendimento levava 42 segundos de mediana:

Os dois classificadores auxiliares do turno — o de etapa do funil e o
anti-jailbreak — passam a rodar ao mesmo tempo, e não um depois do outro. Eram
3,3s mais 3,9s antes de o turno começar a ser gerado; agora custam o mais lento
em vez da soma.

A varredura de eventos novos, quando a instalação está parada, passa a rodar a
cada 3 segundos em vez de 15. Era o que a primeira mensagem de cada conversa
esperava só para virar trabalho: as seis medidas ficaram de 3,0 a 12,1 segundos
paradas, média de 7,6 — metade da soneca. Quem prefere o banco mais silencioso
sobe `CRM_DRAIN_IDLE_INTERVAL_MS` de volta.

E os processadores de eventos em segundo plano — mídia, follow-up, automações,
notificações — voltam a rodar dentro do worker. Todos os catorze estavam
desligados no boot porque o gerador de PDF da LGPD não carregava naquele
ambiente e derrubava o registro inteiro junto; agora ele só é carregado quando
um export de LGPD realmente acontece. Antes disso, esses eventos sobreviviam
apenas pelo processamento agendado de um minuto.

Nenhuma ação é necessária ao atualizar.
