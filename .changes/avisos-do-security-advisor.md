---
impacto: nada_mudou
secao: corrigido
titulo: O banco deixa de acusar os avisos de segurança do painel do Supabase
---
O painel de segurança do Supabase (Security Advisor) apontava dois avisos numa instalação nova. Sete funções do banco não tinham o caminho de busca fixo, e uma delas, a que descobre de qual empresa é um número de telefone recebido na central de voz, podia ser chamada por qualquer usuário logado, de qualquer empresa. Agora as sete têm o caminho fixo e essa função só é chamada pelo próprio servidor, como o produto já fazia. Nada muda no uso: o atendimento por voz continua achando a empresa e o agente certos. Não é preciso fazer nada na instalação: a atualização aplica a correção sozinha.

Contribuição de @usebeehub (#2125).
