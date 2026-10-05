---
impacto: capacidade_nova
secao: adicionado
titulo: Em Portugal, o relatório de acesso do titular passa a trazer as alíneas do art. 15.º e a ligação para o data.json
---

Numa organização com país Portugal, o PDF de acesso ganha a secção "Informações exigidas pelo art. 15.º, n.º 1". A alínea e) traz os direitos de retificação, apagamento, limitação e oposição. A f) traz a autoridade de controlo (CNPD, com o site). A h) descreve os assistentes de IA que estão no ar: quem responde automaticamente e quem só sugere respostas para uma pessoa decidir. Se nenhum estiver no ar, diz que não há assistente a responder. As alíneas a), c) e d) (finalidades, destinatários e prazo de conservação) saem como "não informado pelo controlador", porque ainda não há tela para preenchê-las (#2356).

O e-mail ao titular passa a levar também a ligação para o `data.json`, com a mesma validade do PDF. Esse ficheiro leva todas as mensagens do titular, e não só as 100 mais recentes. As outras secções têm um número máximo de registos, e as que atingiram esse número vêm listadas em `secoes_no_limite`. Por isso o relatório não chama a cópia de "completa".

O que NÃO muda: no Brasil, o e-mail, o PDF e o `data.json` saem exatamente como antes, e o worker nem pede a ligação do `data.json`.

Contribuição de @webtecnica (#2354, Refs #2340).
