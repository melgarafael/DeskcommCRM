---
impacto: nada_mudou
secao: corrigido
titulo: A documentação deixou de dizer que o sistema roda numa plataforma que ele não usa
---

Vários textos do projeto — o guia de quem contribui, os runbooks de operação, as especificações e até uma mensagem de erro do próprio sistema — afirmavam que o CRM era publicado e testado numa plataforma de hospedagem gerenciada. Isso deixou de ser verdade: o produto é instalado na sua própria infraestrutura, e é lá que ele opera.

Nada muda no que você roda hoje. O que muda é o que você lê: a mensagem que aparece quando falta uma variável agora manda ajustar o `.env` da instalação, em vez de um painel que você não tem; os procedimentos de trocar chave do WhatsApp e de rotacionar credenciais passam a descrever o `.env` e a recriação dos contêineres; e o texto que quem contribui recebe ao abrir um pedido de mudança deixa de anunciar um resultado de verificação que não existe mais, e diz onde olhar o que de fato trava a entrada do código.

O agendador de tarefas para quem instala sem cron próprio continua existindo e funcionando igual — só deixou de ser descrito como coisa de uma plataforma específica.
