---
impacto: nada_mudou
secao: corrigido
titulo: Duplicar o mesmo agente duas vezes não colide mais no nome
---
Duplicar o mesmo agente duas vezes tentava gravar o mesmo nome as duas vezes,
`"Suporte (cópia)"`: a segunda batia no índice `ai_agents_name_unique`
(organização + nome) e a tela devolvia **500**. Agora o nome da cópia é o
primeiro **livre** da organização — `"Suporte (cópia)"`, `"Suporte (cópia 2)"`,
`"Suporte (cópia 3)"` —, e o nome do original nunca é reusado.

A numeração não pula: se `"Suporte (cópia 2)"` existe e `"Suporte (cópia)"` não,
a próxima cópia é `"Suporte (cópia)"`. Duplicar um agente cujo nome **já é cópia**
continua a mesma linhagem: `"Suporte (cópia)"` duplicado vira
`"Suporte (cópia 2)"`, não `"Suporte (cópia) (cópia)"`. O teto de 120 caracteres
do nome continua valendo — com o original no limite, o sufixo come o fim do
nome e a cópia continua aceita pelo schema.

Os nomes considerados são só os da própria organização: outra empresa com o
mesmo nome não empurra a numeração da sua.

Limite conhecido: a escolha do nome é uma leitura antes do INSERT, então duas
duplicações **simultâneas** do mesmo agente ainda podem escolher o mesmo nome e
a segunda terminar em 500. O PR #3970, que ainda não está na `main`, transforma
essa colisão residual em 409 com a frase de nome repetido.
