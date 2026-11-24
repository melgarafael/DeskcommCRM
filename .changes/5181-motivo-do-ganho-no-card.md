---
impacto: capacidade_nova
secao: adicionado
titulo: "Marcar como ganho" no menu do card pede o motivo do funil antes de fechar o negócio
---

O item "Marcar como ganho" do menu do card fechava o negócio com um único clique e sem nenhum motivo: o corpo ia vazio para `POST /api/v1/leads/[id]/win`. O servidor já sabia pedir — com `won_reason_required` ligado no funil ele recusa com `required_fields_missing`, e com `won_reasons` cadastrado ele recusa o texto fora da lista com `won_reason_invalid` —, mas a tela só descobria isso depois do clique, e quem tinha lista cadastrada nunca acertava o motivo por este caminho.

Agora o item abre uma caixa antes de fechar. Funil com lista mostra a LISTA cadastrada, e o valor escolhido vai no corpo como `won_reason`. Funil sem lista mantém o texto livre, que é o contrato do servidor. Com `won_reason_required` desligado, sair sem motivo continua possível ("Fechar sem motivo"); funil sem lista e sem obrigatoriedade continua fechando em um clique, sem caixa nenhuma. A recusa `won_reason_invalid` aparece dentro da própria caixa, ao lado da lista, em vez de virar um toast genérico.

A janela de campos obrigatórios também passou a mostrar a lista: o campo "Motivo do ganho" que a recusa reporta vira o mesmo seletor dos campos personalizados quando o funil tem `won_reasons`, em vez do input de texto que fazia a pessoa digitar o que o servidor ia recusar. Funil sem lista continua com texto livre.

Nada muda na régua do servidor: `encerraDemanda` e `campos-exigidos.ts` ficaram intactos, e a obrigatoriedade continua sendo o opt-in `won_reason_required` por funil. Sem migration — `settings.won_reasons` já existia. Relatórios de motivo de ganho e exportação ficam fora desta mudança.

Referente à issue #5181. Contribuição de @webtecnica.
