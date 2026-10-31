---
impacto: nada_mudou
secao: corrigido
titulo: "O título de um compromisso que já existe passa a ser editável"
---

O título de um compromisso criado com texto livre (#3766) ficava travado no que foi digitado na criação: mandar um `title` novo para a rota de alteração devolvia uma recusa genérica, porque o campo era descartado antes da validação, e a função de transição aplicava a mudança por uma lista fechada de campos que não incluía o título. Agora o título é um campo editável como a anotação interna e o convidado.

Título vazio é recusado com uma mensagem que aponta o campo — a edição não volta ao nome do tipo sozinha, porque o tipo pode ter mudado desde a marcação e trocar o texto por outro que ninguém escolheu seria pior que recusar. A mudança de título também marca o compromisso para ser reenviado ao Google, então o evento remoto acompanha a edição em vez de revertê-la na sincronização seguinte.

Nada muda na configuração da VPS; a atualização aplica uma migration que substitui a função de transição.

Crédito: @webtecnica (#3776).
