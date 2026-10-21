---
impacto: nada_mudou
secao: corrigido
titulo: As campanhas respeitam o intervalo do número também quando dividem números no rodízio
---
Quando duas campanhas compartilhavam um número no rodízio, esse número podia mandar duas mensagens de campanha no mesmo minuto, uma de cada campanha. E se o assistente tinha acabado de responder alguém por aquele número, a campanha podia sair logo em seguida, sem esperar o intervalo mínimo entre mensagens que você configurou para o número. Agora cada número manda no máximo uma mensagem de campanha por rodada, seja ele o principal ou um dos vinculados, e só depois de cumprido o intervalo dele. Um número que ainda está no intervalo, ou que já mandou nesta rodada por outra campanha, fica fora do rodízio só nessa rodada: a campanha usa outro número dela que esteja livre e, se não houver nenhum, tenta de novo na rodada seguinte. Isso vale também quando esse número é o principal da outra campanha. Duas campanhas com o mesmo número principal continuam como antes: a mais antiga tem a vez em cada rodada. Nada a fazer na atualização.
