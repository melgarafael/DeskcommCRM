---
impacto: nada_mudou
secao: corrigido
titulo: O provisionamento do Supabase lê as chaves em qualquer ordem e não perde mais a senha do banco
---

Na instalação, o passo que busca as chaves de API do projeto novo lia a resposta
da Management API por POSIÇÃO: procurava `anon` e, só no que vinha depois dela,
`api_key`. Quando a API do Supabase passou a devolver `api_key` antes de `name`,
a leitura passou a voltar vazia e a instalação morria no passo 5 com "Não
consegui ler anon/service_role" — num projeto que já estava criado e de pé. A
leitura agora é por objeto, e a ordem dos campos deixou de importar.

O estrago maior era o outro lado. A senha do banco é gerada no começo e a API
não a devolve depois, então quem morria no passo 5 ficava com um projeto
ocupando uma das duas vagas do plano grátis e sem a credencial à mão. A senha
passa a ser gravada em `.env.supabase-provision` (só leitura pelo dono, 600)
antes de o projeto ser criado; quando um passo falha, a mensagem diz onde ela
está; e uma segunda tentativa reaproveita a mesma senha em vez de gerar outra.
