---
impacto: exige_acao
secao: adicionado
titulo: As condições das automações ganham "não contém", "está vazio", "está preenchido", comparação por número/data e o grupo "qualquer uma"
---

Uma regra de automação só sabia perguntar "é", "não é" e "contém", e sempre exigia TODAS as condições ao mesmo tempo. Agora a tela oferece, além desses, os operadores "não contém", "está vazio", "está preenchido", "maior que", "maior ou igual a", "menor que" e "menor ou igual a", e um seletor por grupo que combina por "todas as condições" ou "qualquer uma das condições". O recorte por número e por data funciona: em texto, a comparação de maior/menor usa a ordem do próprio texto, o que faz a data no formato ISO-8601 (`2026-09-14`) ordenar certo.

A semântica de campo que a pessoa não preencheu ficou explícita: `neq` ("não é") deixou de ser verdade quando o campo está AUSENTE — era o defeito que fazia "crianças ≠ 0" disparar para quem nem tinha o campo preenchido. Quem quer "não preencheu" usa "está vazio"; quem quer "não é X e está preenchido" combina "está preenchido" com "não é". A lista simples que já estava gravada continua sendo lida como "todas", e nada muda no banco. O que NÃO é neutro: a regra que já existe com "não é" num campo que pode estar ausente passa a não disparar nesses casos — está no aviso abaixo.

## Requer atenção

Revise as regras que usam "não é" (`neq`) num campo que pode estar AUSENTE (nulo, ou nunca preenchido): elas disparavam quando o campo não estava preenchido e agora não disparam mais. Para voltar a pegar o "não preencheu", troque a condição por "está vazio"; para "não é X e está preenchido", use "está preenchido" junto do "não é X". Em campo cujo valor é texto vazio nada muda — ali o `neq` continua igual.

Não volte para a versão anterior DEPOIS de gravar uma regra "qualquer uma": a versão antiga não conhece o formato de grupo e a leitura das condições dela estoura ao avaliar, o que derruba as automações daquele gatilho inteiro — não só a regra nova. Se precisar voltar, desfaça antes as regras "qualquer uma" pelo formulário.

Contribuição de @webtecnica (refs #2727).
