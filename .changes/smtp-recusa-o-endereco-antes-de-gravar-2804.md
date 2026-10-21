---
impacto: nada_mudou
secao: corrigido
titulo: O servidor de e-mail recusa um endereço inválido antes de salvar, e diz o que corrigir
---

Ao salvar o servidor de e-mail em Administração › Servidor de e-mail, o endereço é conferido antes de gravar. Antes, um endereço com sublinhado no nome — o caso de quem aponta para um contêiner Docker na própria VPS, como `supabase_inbucket_deskcomm-crm` — só era recusado pelo banco, e o aviso na tela mostrava o texto do Postgres ("violates check constraint"). Agora a recusa vem antes, em português (e em espanhol para quem usa o sistema nesse idioma), explicando o que o endereço aceita e o que fazer no lugar do sublinhado: usar o endereço IP do contêiner ou um apelido sem sublinhado. Endereço de domínio normal continua igual, e deixar o campo vazio continua valendo como "esta instalação não usa servidor próprio". Se a gravação falhar por outro motivo, o aviso na tela fala do que aconteceu sem repetir o texto do banco.

Contribuição de @webtecnica (#3227), a partir da issue #2804.
