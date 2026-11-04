---
impacto: nada_mudou
secao: corrigido
titulo: A credencial reserva do canal oficial no .env vale só para o número dela
---

O canal oficial do WhatsApp procura primeiro a credencial salva na própria
conexão. Quando não achava um token legível ali, usava o par
`META_PHONE_NUMBER_ID`/`META_SYSTEM_USER_TOKEN` do `.env` para qualquer
conexão, e a mensagem saía pelo número do `.env`, não pelo número da conexão.

Agora a reserva do `.env` vale só para a conexão do número que está no próprio
`.env`. Uma conexão de outro número sem token legível fica sem credencial: a
mensagem fica na fila como canal não conectado, o "digitando" e o download de
mídia não acontecem, a saúde do canal mostra que falta credencial e a
sincronização de modelos responde que falta o token. Nada sai por outra
credencial.

Você não precisa fazer nada. A instalação de um número só configurada pelo
`.env` continua funcionando igual, e quem conectou pela tela já usa a
credencial salva na conexão. Se uma conexão aparecer sem credencial depois de
atualizar, reconecte o número em Conexões.
