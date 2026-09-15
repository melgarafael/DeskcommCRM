---
impacto: exige_acao
secao: corrigido
titulo: Automação com condição "contém" passa a funcionar nas tags
---
Numa automação, a condição "contém" sobre tags só disparava quando o texto digitado era idêntico à tag, maiúsculas incluídas: a regra "tag adicionada contém Google" não rodava para a tag "google" nem para "Google Ads". Agora "contém" vale por tag e não diferencia maiúsculas, igual ao que o mesmo operador já fazia em campos de texto. Crédito: @rafaelbatistazz.

## Requer atenção

Revise as automações que usam "contém" sobre tags (tag adicionada, tags do contato, tags do lead). Elas passam a disparar em mais casos: uma condição "contém vip" agora também pega a tag "vip ouro", e "contém google" pega "tráfego google". Nos campos de tag o editor de regras só oferece "contém", então quem precisa de correspondência exata deve escrever um texto que não seja prefixo de outra tag, ou renomear as tags parecidas.
