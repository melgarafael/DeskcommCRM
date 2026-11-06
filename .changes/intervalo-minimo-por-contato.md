---
impacto: capacidade_nova
secao: adicionado
titulo: A automação pode esperar um intervalo antes de repetir para o mesmo contato
---

A opção **Rodar no máximo uma vez por contato** resolvia o contato que voltava pelo mesmo anúncio não recebendo a sequência inteira outra vez, mas só de um jeito: para sempre. Quem queria um prazo — "não repetir para este contato por 24 horas" — não tinha como dizer isso.

Agora a edição de uma regra automática tem, ao lado do "uma vez por contato", o campo **Ou não repetir por (horas)**: de 1 a 720 (até 30 dias). Dentro da janela, a mesma pessoa não recebe aquela automação de novo; passado o prazo, ela volta a valer normalmente. O limite é por contato e por regra: o contato que voltou não trava a regra para os outros, e cada regra tem o seu.

As duas opções são excludentes na tela: ligar "uma vez por contato" desliga o intervalo, e o campo fica desabilitado enquanto a caixa estiver marcada.

Todo mundo começa sem intervalo, e deixar o campo vazio mantém as regras exatamente como estão hoje — inclusive as que já usam o "uma vez por contato". A aba Atividade registra quando a janela impediu uma execução, com o próprio motivo, e essa linha diz que a regra volta a valer — diferente da linha do "uma vez por contato", que é definitiva.

Nenhuma ação é necessária na atualização.
