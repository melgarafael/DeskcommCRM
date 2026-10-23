---
impacto: nada_mudou
secao: corrigido
titulo: A recusa da inscrição de push aparece na tela, e o interruptor não fica ligado mentindo
---
Quando o servidor recusava a inscrição de push do aparelho — por exemplo, quando o endereço de push não é de um serviço conhecido — a tela de Notificações não dizia nada: o interruptor de Push ficava ligado, a pessoa achava que ia ser avisada, e nenhum aviso chegava com o site fechado. Agora, quando a inscrição é recusada, a tela mostra a recusa do servidor e o interruptor volta a ficar desligado, porque de fato nada foi gravado. A inscrição aceita continua exatamente como antes. Nada a fazer na atualização.

E o mesmo valia para os outros caminhos em que nada é inscrito, que antes passavam calados. Quando o próprio navegador recusa criar a inscrição, ou devolve uma inscrição incompleta, o interruptor desliga e a tela diz qual foi o motivo. Quando o navegador não registra o service worker, a tela avisa que, com o site fechado, aquele aparelho não recebe aviso, e o interruptor continua ligado: no navegador de computador o aviso com a aba aberta segue funcionando. Quando a instalação ainda não tem o par de chaves do Push (VAPID), o interruptor também continua ligado, e quem explica é o aviso que a página já mostra: com o site aberto o aviso chega, com ele fechado não, e como conseguir as chaves. Quando o motivo é só uma preferência da pessoa (a permissão não concedida ou o canal de push desligado), o interruptor continua como está.

Contribuição de @webtecnica (#3157, #3164).
