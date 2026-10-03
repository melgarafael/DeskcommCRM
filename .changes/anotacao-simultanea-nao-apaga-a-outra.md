---
impacto: nada_mudou
secao: corrigido
titulo: Campos diferentes gravados ao mesmo tempo no mesmo negócio não se apagam mais
---

Quando duas gravações dos campos personalizados de um mesmo negócio chegavam juntas, por exemplo quem atende salvando a ficha no dossiê enquanto o assistente anotava pelo MCP um campo que a ficha não mostrava, a segunda gravava por cima da primeira e um dos campos sumia. Não aparecia erro nenhum: o dado simplesmente não estava mais lá.

Agora a soma dos campos acontece dentro do banco, numa única gravação. A segunda espera a primeira terminar e soma sobre o que ela gravou, então os campos de cada uma ficam. A rota que move o negócio de etapa já tinha proteção própria e não muda.

Um caso continua: a ficha do dossiê salva todos os campos que mostrava quando foi aberta. Se alguém, ou o assistente, mudou um campo que a ficha já mostrava enquanto ela estava aberta, quem salva por último vence. Esse ajuste é do formulário e segue à parte.

Nada muda ao atualizar e não há nada a configurar. A migration é idempotente e não mexe em dado existente.

Contribuição de @paulolimajr77 (#2009).
