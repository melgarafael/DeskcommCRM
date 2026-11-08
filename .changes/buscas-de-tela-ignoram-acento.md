---
impacto: nada_mudou
secao: corrigido
titulo: As buscas de agentes, etiqueta em lote, Cold Call e auditoria acham o texto digitado sem acento
---

Quatro buscas de tela comparavam o texto digitado com o da lista dobrando só a
caixa: quem digitava `pos-venda` não achava "Atendimento Pós-venda", `promocao`
não achava a etiqueta "Promoção" (e a pessoa criava uma segunda, quase igual),
`sao joao` devolvia a fila do Cold Call vazia com "Padaria São João" nela, e
`clinica acao` não achava "Clínica Ação" no filtro da auditoria.

Agora as quatro passam os DOIS lados pela mesma régua da busca do Inbox —
`termoSemAcento` —, que ignora caixa e acento (inclusive ñ, ü, ø e ß). A busca
por telefone do Cold Call não muda: dígito não tem acento.
