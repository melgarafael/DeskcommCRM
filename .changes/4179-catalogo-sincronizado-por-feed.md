---
impacto: capacidade_nova
secao: adicionado
titulo: Catálogo sincronizado pelo feed da revenda, como módulo opcional desligado de fábrica
---

Quem administra o servidor pode ligar, em Recursos opcionais, o módulo Catálogo sincronizado por feed. Ligado, a tela de Produtos de cada empresa ganha a seção Catálogo por feed: a pessoa cola o endereço do feed (JSON ou CSV) que o sistema de estoque da revenda publica, confere o que vai mudar e sincroniza. A partir daí, a cada 2 horas o servidor busca o feed, cria o produto novo, atualiza preço e estoque do que mudou e desativa o que saiu do feed, sem apagar nenhum produto. Um feed vazio, ou sem nenhum item reconhecível, não desativa nada.

A seção mostra a última leitura e o que ela fez. Quando a leitura falha três vezes seguidas, abre um aviso na Central, que some sozinho na primeira leitura que der certo.

Desligado, que é o padrão, nada muda: a seção não aparece, a rota responde como inexistente e nenhum feed é buscado, nem o de uma empresa que tenha cadastrado o endereço antes de o módulo ser desligado. Nenhuma ação é pedida a quem opera a instalação.

Crédito: @webtecnica, que escreveu a sincronização (#4179, issue #3587).
