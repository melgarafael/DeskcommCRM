---
impacto: capacidade_nova
secao: corrigido
titulo: O botão "Reativar" de tipo de agendamento passa a funcionar
---

Em Configurações › Agenda, um tipo de agendamento desativado mostra o botão
"Reativar" — e ele **nunca funcionou**, desde que a tela existe. Clicar devolvia
sempre o mesmo erro: "Nenhum campo para alterar." Quem tinha desativado um tipo
por engano ficava sem saída pela tela: só criando outro com nome diferente, já
que o nome original continuava ocupado pelo tipo desligado.

A causa era um campo que o servidor descartava em silêncio. A tela pedia para
ligar o tipo de volta usando a mesma porta que altera nome, duração e
responsável — e essa porta não conhece o campo "ativo", então recebia um pedido
que, do lado dela, não mudava nada.

Agora reativar tem porta própria no servidor, com a mesma exigência de papel do
desativar (gerente ou administrador), e fica registrado na trilha de auditoria
como "tipo reativado" — separado de uma alteração comum de campo, para que um
tipo religado não se confunda com um tipo que teve a duração mudada.

Você não precisa fazer nada para adotar. Desativar continua igual, e nenhum
compromisso já marcado é afetado.
