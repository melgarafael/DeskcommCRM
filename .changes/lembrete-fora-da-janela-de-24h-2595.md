---
impacto: nada_mudou
secao: corrigido
titulo: O lembrete de compromisso não é mais dado como enviado quando o canal não pode entregá-lo
---

Nos canais com janela de 24 horas (como o Instagram), uma mensagem livre só é entregue se o cliente escreveu nas últimas 24 horas. O lembrete de agenda escolhia o primeiro canal conectado, marcava o aviso como enviado e só depois mandava; fora da janela, a entrega era recusada e o compromisso ficava como avisado sem ter sido. Agora o lembrete só usa um canal que pode entregar naquele momento: se o primeiro não pode, ele tenta o próximo canal conectado; se nenhum pode, o aviso não é marcado como enviado, o motivo fica registrado no log do agendador e a próxima rodada tenta de novo — quando o cliente escrever, o lembrete sai. Em canais sem janela de 24 horas nada muda. Nada precisa ser feito ao atualizar. Contribuição de @webtecnica (issue #2595).
