---
impacto: nada_mudou
secao: corrigido
titulo: O sistema não fica mais preso em "Algo deu errado" quando o Supabase repete requisições antigas
---

Uma instalação inteira ficou dois dias mostrando "Algo deu errado" em todas as
telas. O banco estava saudável; o que travou foi a camada de API do Supabase: o
gateway dela repetia sem parar oito requisições antigas do motor de follow-up
que terminavam em erro, e essas repetições ocuparam todas as conexões da API.
Sem conexão livre, a API não conseguia nem se preparar para atender, e passou a
responder "indisponível" para tudo, inclusive para a tela inicial.

Agora o banco reconhece uma requisição que o gateway está repetindo há mais de
cinco minutos e a recusa de um jeito que o gateway não repete. O loop morre na
hora e a API volta sozinha. Nada muda para quem usa o sistema, e você não
precisa fazer nada ao atualizar: a proteção entra com o próprio `update.sh`.
