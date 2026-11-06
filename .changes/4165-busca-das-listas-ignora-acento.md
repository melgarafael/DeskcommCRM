---
impacto: nada_mudou
secao: corrigido
titulo: A busca de quatro telas passa a ignorar acento
---

Quatro buscas do produto comparavam texto com `toLowerCase().includes(...)`, que
ignora maiúscula e minúscula e **não** ignora acento. Quem digitava rápido e sem
acento ficava com a lista vazia e concluía que o item não existia: `pos-venda`
não achava o agente "Atendimento Pós-venda", `promocao` não sugeria a etiqueta
"Promoção" no lote do funil, `sao joao` não achava o negócio "Padaria São João"
no Cold call e `exclusao` não achava a empresa "Exclusão Fiscal" no filtro da
Auditoria.

As quatro passam a usar a mesma régua da busca do Inbox — `termoSemAcento`, de
`lib/inbox/termo-de-busca.ts` — nos DOIS lados da comparação, o termo digitado e
o texto do item. Não há régua nova: normalizar só o termo não resolveria, porque
"São João" continua não contendo "sao joao".

O filtro saiu de dentro de cada componente para uma função pura em `lib/`, com
teste ao lado (`filtrarAgentes`, `filtrarEtiquetas`, `filtrarLigacoes`,
`filtrarOpcoes`), no desenho que o #4078 fixou para a busca do encaminhamento.
A tela continua decidindo status, etapa, titular e limite de sugestões.

Nada muda para quem já usa o sistema, e nenhuma ação é necessária na VPS: a busca
por telefone do Cold call, o filtro vazio mostrando a lista inteira e o filtro
por status dos agentes continuam como estavam.
