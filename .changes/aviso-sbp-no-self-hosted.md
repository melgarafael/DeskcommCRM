---
impacto: nada_mudou
secao: corrigido
titulo: Instalação com o Supabase na própria VPS, ou com um Supabase próprio, deixa de pedir um token do Supabase na nuvem
---

Quem instalava com o banco na própria VPS via, no meio da instalação, o aviso
"sem SUPABASE_ACCESS_TOKEN" e a instrução de buscar um token `sbp_...` em
supabase.com. Esse token é do Supabase na nuvem e não serve para o Supabase da
VPS, onde os e-mails de acesso já ficam configurados pelo próprio instalador.

Agora, nessa instalação, o passo dos e-mails confere que eles já usam os modelos
do CRM e diz isso; se ainda não usarem, manda rodar o `update.sh`. A primeira
atualização sem o token também deixa de mandar ao painel do Supabase na nuvem:
ali o endereço dos e-mails já é configurado pelo instalador.

Quem usa um Supabase próprio, fora do kit, também deixa de ser mandado buscar o
token: a instalação ensina as variáveis do GoTrue, e a primeira atualização
pede para conferir `SITE_URL` e `ADDITIONAL_REDIRECT_URLS` no `.env` do Supabase
dele — mas quem nunca atualizou sem o token ainda vê o texto antigo uma última
vez, na atualização que traz este conserto (ela ainda roda o `update.sh`
anterior). Com o Supabase na VPS, o texto antigo já não sai nessa atualização.
Quem usa o Supabase na nuvem continua recebendo o aviso do token, que ali
é o passo certo. Não é preciso fazer nada.
