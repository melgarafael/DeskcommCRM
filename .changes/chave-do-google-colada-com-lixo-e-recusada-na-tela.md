---
impacto: nada_mudou
secao: corrigido
titulo: A chave secreta do Google colada junto com o resto do arquivo é recusada na hora, com instrução, em vez de só falhar depois ao conectar
---

Ao cadastrar as credenciais do Google Agenda da instalação, era fácil colar, no campo
da chave secreta, o valor JUNTO com o resto da linha do arquivo de credenciais do Google
— algo como `GOCSPX-...","redirect_uris`. O campo aceitava, guardava os caracteres a mais,
e o erro só aparecia bem mais tarde, quando alguém tentava conectar a agenda: o Google
respondia que a chave era inválida, uma mensagem que apontava para o Google e não para a
colagem. Como a chave é guardada cifrada e nunca volta a aparecer na tela, não havia como
reler e descobrir o engano.

Agora a tela avisa na hora, assim que a chave digitada tem uma aspa, vírgula ou espaço
— as marcas de uma colagem que veio junto com o resto do arquivo —, e explica o que fazer:
copiar só o valor que começa com `GOCSPX-`, sem nada colado depois. Uma chave correta
continua funcionando exatamente como antes. Crédito: @Aleshan-dev.
