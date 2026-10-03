---
impacto: nada_mudou
secao: corrigido
titulo: O link de "esqueci a senha" da instalação single-server passa a abrir a troca de senha
---

Numa instalação single-server, o GoTrue mandava os e-mails de acesso no modelo padrão do Supabase, e o clique em "esqueci a senha" terminava na tela de login com "link inválido". Como não existe troca de senha estando logado, quem perdia a senha ficava fora do sistema. Agora o `.env` do Supabase recebe os dois modelos do app (`https://SEUDOMINIO/email-templates/recovery` e `/email-templates/confirmation`), e o override do kit os entrega ao serviço `auth`. O link sai com `token_hash` e `/login/reset` abre.

Quem instala agora recebe as duas chaves pelo `install-single-server.sh`. Quem já instalou recebe pelo `update.sh`, que as grava a partir do `SITE_URL` do Supabase antes de subir o `auth` de novo. Nas duas pontas, um modelo que o operador já tenha apontado é preservado.

Contribuição de @webtecnica (#2153), sobre o diagnóstico de @brunno-soaress na #2109.
