---
impacto: capacidade_nova
secao: adicionado
titulo: O negócio criado pelo agente guarda qual item do banco externo o cliente escolheu
---
Quando o cliente diz que tem interesse em um item que o agente achou no banco externo (um imóvel, um produto), o negócio criado no funil passa a levar a referência desse item, na descrição e num campo próprio, para o vendedor continuar de onde o robô parou. Se o mesmo cliente repetir o interesse no mesmo item, o sistema não abre outro negócio: devolve o que já está aberto e deixa uma nota na linha do tempo. Um negócio já ganho ou perdido não impede um novo interesse.

O funil e a etapa do negócio saem da receita do item: o agente só informa o código do item, e a organização escolhe o destino uma vez, na tela de receitas. Antes de abrir o negócio, o sistema confere no banco externo que o item existe. Se o código não corresponder a nenhum item, o negócio não é aberto, e o agente é orientado a consultar de novo em vez de dizer ao cliente que registrou o interesse.
