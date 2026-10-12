---
impacto: nada_mudou
secao: corrigido
titulo: As telas de entrar e de verificação em duas etapas não ficam mais presas em "Verificando"
---

Digitar um código errado na verificação em duas etapas podia deixar a tela parada em **"Verificando…"** para sempre: sem mensagem, sem explicação, e sem permitir uma segunda tentativa — porque o campo do código fica bloqueado enquanto a tela acha que ainda está verificando. A única saída era recarregar a página, justamente no momento em que a pessoa está tentando entrar.

A causa não era o código errado. Era a tela não ter limite de espera: ela chama o servidor e só sai do estado "verificando" quando a resposta chega. Se a resposta demorasse — a verificação fala duas vezes com o serviço de autenticação e ainda registra a tentativa na auditoria antes de responder —, a espera não terminava nunca.

O mesmo valia para **todas** as telas de autenticação: entrar, entrar com Google, criar conta, recuperar senha, redefinir senha, código de recuperação, recuperar organização e ligar a verificação em duas etapas. Todas esperavam sem limite.

Agora, passados 20 segundos sem resposta, a tela diz que não conseguiu concluir e libera os campos para tentar de novo. A frase é deliberadamente diferente de "código inválido" ou "senha incorreta": estourar o tempo não prova que o que foi digitado estava errado — a verificação pode ter acontecido do outro lado.

Quem usa o sistema com a rede boa não vê diferença nenhuma: as mensagens de recusa continuam as mesmas, e o acerto continua entrando direto.
