---
impacto: capacidade_nova
secao: adicionado
titulo: As condições das automações ganham "não contém", "está vazio", "está preenchido", comparação por número/data e o grupo "qualquer uma"
---

Uma regra de automação só sabia perguntar "é", "não é" e "contém", e sempre exigia TODAS as condições ao mesmo tempo. Agora a tela oferece, além desses, os operadores "não contém", "está vazio", "está preenchido", "maior que", "maior ou igual a", "menor que" e "menor ou igual a", e um seletor por grupo que combina por "todas as condições" ou "qualquer uma das condições". O recorte por número e por data funciona: em texto, a comparação de maior/menor usa a ordem do próprio texto, o que faz a data no formato ISO-8601 (`2026-09-14`) ordenar certo.

A semântica de campo que a pessoa não preencheu ficou explícita: `neq` ("não é") deixou de ser verdade quando o campo está ausente — era o defeito que fazia "crianças ≠ 0" disparar para quem nem tinha o campo preenchido. Quem quer "não preencheu" usa "está vazio"; quem quer "não é X e está preenchido" combina "está preenchido" com "não é". As regras JÁ gravadas continuam avaliando igual: a lista simples de antes vale como "todas". Nada muda no banco.

Contribuição de @webtecnica (refs #2727).
