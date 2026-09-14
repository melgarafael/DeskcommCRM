---
impacto: capacidade_nova
secao: corrigido
titulo: A atualização confere as regras de acesso do banco antes de dizer que deu certo
---

A atualização mexe nas regras que separam uma empresa da outra dentro do banco. Se uma delas sumisse no caminho, o sistema voltava dizendo "concluída com sucesso" e as telas apareciam **vazias** — sem erro nenhum, indistinguível de "não há nada aqui". Custou um dia inteiro numa instalação real, com o funil vazio.

Agora a atualização **confere as regras uma a uma** no fim e diz quantas encontrou. Se faltar alguma, ela **não sobe o sistema** e diz exatamente quais faltam: um sistema fora do ar é um problema visível que se resolve em minutos; um sistema no ar sem essas regras não parece problema nenhum.

Durante a parte do banco, o sistema fica parado por alguns segundos — é isso que impede a regra de sumir.
