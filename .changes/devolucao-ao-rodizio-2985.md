---
impacto: capacidade_nova
secao: adicionado
titulo: A conversa entregue pelo rodízio e não respondida pode voltar para a fila
---

Quando o rodízio entregava uma conversa a um atendente que não respondia, o cliente ficava parado com ele. Agora a empresa pode definir um prazo, de 5 minutos a 3 horas, no campo `unanswered_return_minutes` da configuração de atendimento pela API. Passado o prazo sem nenhuma resposta humana, a conversa volta para a fila e o rodízio a entrega a outra pessoa disponível. Quem não respondeu fica fora daquela conversa por 24 horas. Se não houver mais ninguém disponível, ela espera na fila. Depois de duas devoluções, aquela conversa não volta mais para a fila sozinha. Só entram entregas das últimas 3 horas: conversas antigas não voltam todas de uma vez. Num número com atendente de destino padrão, o destino padrão continua valendo e a conversa volta para a mesma pessoa. Vem desligado e ainda não tem tela. A atualização acrescenta uma rotina leve a cada 5 minutos, que não faz nada enquanto o prazo estiver desligado. Nada a fazer na atualização.

Proposto e implementado por @webtecnica (#2988, issue #2985).
