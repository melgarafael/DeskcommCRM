---
impacto: nada_mudou
secao: corrigido
titulo: O atalho do card sem o dado aparece desabilitado e diz qual campo falta
---

O atalho do card (issue #3487) só aparecia quando todos os marcadores do modelo
de link tinham valor no negócio ou no contato. Faltando um — o `{{erp_id}}` de um
cliente cadastrado pela metade, o telefone ainda não preenchido — o botão
simplesmente não existia na lateral do negócio, e quem atende concluía que o
atalho nunca tinha sido configurado. A issue pede o contrário: o botão fica,
desabilitado, dizendo o que falta.

Agora cada atalho configurado aparece na faixa. O que resolve todos os marcadores
continua abrindo — `https` em aba nova com `noopener noreferrer`, `tel:` direto no
softphone. O que não resolve fica como botão desabilitado, com o motivo ao lado
do rótulo: "Falta o campo erp_id" quando é dado do cliente, ou "O endereço deste
atalho não é aceito" quando o modelo é recusado pela allowlist de esquema. Link
quebrado continua não existindo: nenhum `<a href>` nasce sem todos os marcadores
resolvidos, e `tel:` sem número suficiente também não vira link. Funil sem
atalho configurado continua sem faixa nenhuma. Contribuição de @webtecnica
(#3487).
