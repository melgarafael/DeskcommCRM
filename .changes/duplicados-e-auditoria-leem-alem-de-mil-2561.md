---
impacto: nada_mudou
secao: corrigido
titulo: Duplicados de contatos e exportação de auditoria não param mais em 1.000 linhas
---

A tela de duplicados de contatos e o CSV de auditoria liam no máximo 1.000 linhas, mesmo quando prometiam mais: a exportação anunciava até 10.000 registros e saía com 1.000, e a lista de duplicados dizia que tinha varrido todos os contatos quando só os 1.000 mais antigos tinham sido lidos. A causa é o teto de 1.000 linhas por resposta do banco, que corta a leitura sem avisar. Agora as duas leem em páginas, até o limite de cada uma: a exportação entrega as 10.000 prometidas, e a tela de duplicados só avisa que varreu tudo quando varreu. Nenhum dado era gravado errado antes: era a leitura que parava cedo.

Contribuição de @Tong-bit-art (#2585), a partir da issue #2561 — os dois lugares foram apontados por @hudson-souza-mkt na #2548.
