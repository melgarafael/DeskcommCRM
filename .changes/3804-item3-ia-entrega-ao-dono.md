---
impacto: capacidade_nova
secao: adicionado
titulo: A IA, ao passar a conversa para humano, entrega a quem é o dono
---

O item 3 da #3804: numa agência, a Andreia vende e o card vai para o pós-venda
com ela como responsável; quando o cliente volta a falar e a IA passa o
atendimento a um humano, a conversa ia para uma **pessoa fixa** (a mesma para a
equipe toda) ou para o rodízio — a venda da Andreia caía no colo de outra pessoa,
que não sabe o que foi combinado.

Agora a organização pode ligar, em `organizations.settings.atendimento.
destino_do_handoff`, o MESMO objeto que a ação de atribuir já aceita
(`{ modo: "destino", destinos, fallback }`), e o handoff chama a MESMA função —
`resolverDestinoDoAtribuir` — com a MESMA régua de vínculo (membro ativo, não
`viewer`). Não há segunda função nem segunda ordem de preferência: responsável do
negócio → dono da carteira → fallback obrigatório.

Sem a chave (ausente, `modo` diferente, valor torto), nada muda: nenhuma leitura
de negócio ou contato, nenhuma escrita, e o comportamento de hoje segue byte a
byte. É jsonb, então **não houve migration**.
