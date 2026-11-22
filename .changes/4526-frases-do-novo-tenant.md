---
impacto: nada_mudou
secao: corrigido
titulo: A coluna "o que ele nunca faz" do onboarding mostra o estado real de cada conferência, com o caminho para ligar
---

A tela de novo tenant mostrava "E nunca vai fazer" com itens que eram títulos de
proteção ("Respeitar quem pediu para parar"): o título da coluna colado no
primeiro item lia o contrário do que a conferência faz, e a lista misturava
"Não prometer…", "Conferir…", "Deixar…" e "Só oferecer…" — quatro formas
verbais. Agora as colunas são "O que ele já sabe fazer" e "O que ele nunca faz",
com todo item no infinitivo descrevendo a ação proibida ("Prometer preço ou
prazo por conta própria", "Insistir com quem pediu para parar"). As duas listas
continuam saindo da cadeia de conferências que roda de verdade, com os mesmos itens e na
mesma ordem — nada saiu da tela, e o teste novo reprova se um item
sumir ou se a fala do onboarding deixar de casar com um gate da cadeia.

E a coluna passa a dizer o estado REAL de cada conferência nesta empresa. Numa
organização recém-criada, quatro delas vêm desligadas — a afirmação
clínica, a restrição comercial, a promessa semântica (que só liga com
`PROMISE_SEMANTIC_ENABLED=true`) e a conferência de fato (que depende da tarefa
do Jev). Elas aparecem marcadas como "desligada nesta organização", com o
caminho para ligar: as três do painel em IA › Agentes › Confere antes de
enviar, e a de fato em IA › Provedores de IA › cartão do Jev. As outras
rodam sempre e seguem sem marca. Nenhum padrão de guardrail mudou: o conserto é
da tela, que deixou de prometer proteção que a instalação não tem. Contribuição
de @webtecnica (#4526, #1041).
