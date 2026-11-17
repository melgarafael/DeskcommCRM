---
impacto: capacidade_nova
secao: adicionado
titulo: O teto de respostas por conversa passa a ser configurável pela empresa
---

O teto que impede dois robôs de conversarem sozinhos existia, mas só se ajustava no arquivo de configuração da instalação — uma empresa não podia apertar o próprio limite sem reiniciar o servidor. Agora ele se configura por empresa, em Configurações › Anti-ban: quantas respostas automáticas cabem numa janela, a largura da janela em minutos e quanto tempo a conversa fica pausada ao bater o teto.

No padrão nada muda para quem não configurou: 20 respostas da IA por conversa em 60 minutos, com a conversa pausada por 60 minutos ao estourar. Quem atende de forma mais conversada sobe o número; quem faz prospecção aperta. O disparo de campanha não é afetado — o teto conta só as respostas a mensagens recebidas, e o disparo continua com o teto dele.

Ao bater o teto, a resposta não sai, a conversa é pausada pelo mesmo caminho do botão de pausar a IA (o atendente devolve para a IA quando quiser, sem perder nada) e um aviso abre na Central. Pausar pode ser desligado — aí a resposta continua barrada e o aviso continua abrindo. O tempo de pausa é limitado (no máximo 24 horas) e nunca desfaz uma pausa mais longa que alguém já tinha feito à mão.

A conferência "Parar a conversa que virou pingue-pongue" da ficha do agente explica o que a trava protege e onde ajustá-la, em português e espanhol.

Contribuição de @webtecnica, a partir da issue #4590.
