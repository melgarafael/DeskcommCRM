---
impacto: nada_mudou
secao: corrigido
titulo: As telas de entrar e de verificação em duas etapas não ficam mais presas em "Verificando"
---

Digitar um código na verificação em duas etapas podia deixar a tela parada em **"Verificando…"** para sempre: sem mensagem, sem explicação, e sem permitir uma segunda tentativa, porque o campo do código fica bloqueado enquanto a tela acha que ainda está verificando. A única saída era recarregar a página, justamente no momento em que a pessoa está tentando entrar.

A tela não tinha limite de espera: ela chama o servidor e só sai do estado "verificando" quando a resposta chega. **Por que a resposta às vezes não chega ainda não foi identificado.** O que muda aqui é uma defesa: a tela deixa de esperar para sempre.

O mesmo valia para as **nove** telas de autenticação: entrar, entrar com Google, criar conta, esqueci a senha, redefinir senha, código de recuperação, recuperar organização, a verificação em duas etapas e ligar a verificação em duas etapas. Todas esperavam sem limite.

Agora, passados 20 segundos sem resposta, a tela diz que a resposta do servidor não chegou, devolve o botão e oferece **Recarregar a página**. A frase é deliberadamente diferente de "código inválido" ou "senha incorreta": estourar o tempo não prova que o que foi digitado estava errado, e a ação pode ter acontecido do outro lado. O caminho é recarregar, e não enviar de novo, porque um segundo envio ficaria na fila atrás do primeiro, que não respondeu.

Quem usa o sistema com a rede boa não vê diferença nenhuma: as mensagens de recusa continuam as mesmas, e o acerto continua entrando direto.

Contribuição de @LeonardoMarcelo (#2429).
