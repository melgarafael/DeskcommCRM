---
impacto: nada_mudou
secao: corrigido
titulo: A reação com emoji logo depois de um texto não impede mais a IA de responder a esse texto
---

Quando o cliente mandava um texto e, segundos depois, reagia com um emoji a uma mensagem anterior, o texto podia ficar sem resposta da IA. O sistema via a reação como a mensagem mais recente da conversa e deixava a resposta para a vez dela, mas a reação não aciona a IA. Num caso medido na versão 1.109.0, no WhatsApp pela API oficial, o texto chegou às 20:01:21, a reação às 20:01:29, a conversa ficou sem resposta e nada apareceu na Central de avisos.

Agora, na hora de decidir se o texto ainda precisa de resposta, a reação não conta mais como mensagem nova e deixa de impedir a resposta ao texto. O mesmo vale para a reação que chega enquanto a IA ainda prepara a resposta: antes, o que a IA tinha pronto era descartado e ninguém respondia depois. E, quando o cliente escreve de novo nesse intervalo, uma reação antiga na conversa não faz mais a IA mandar duas respostas seguidas, uma delas já desatualizada. Nenhuma ação é necessária na atualização.

Crédito: correção de @tabaterral, medição de @hebervalverde (#2797).
