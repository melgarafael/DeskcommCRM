---
impacto: nada_mudou
secao: corrigido
titulo: Instalação com o banco na própria VPS deixa de mostrar as chaves do banco na tela
---

O instalador oficial do Supabase escreve na tela cada chave que gera, entre
elas a chave mestra do banco e a senha do Postgres. Quem instalava com o banco
na própria VPS via essas chaves no terminal, e elas ficavam no histórico de
quem gravava a sessão ou mandava um print pedindo ajuda.

Agora a tela mostra só os passos da instalação. A saída completa fica em
`.runtime/supabase-setup.log`, que só o root lê. Instalações que já existem não
mudam, porque esse passo só roda na primeira instalação.
