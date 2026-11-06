---
impacto: nada_mudou
secao: corrigido
titulo: A busca da janela Encaminhar acha o contato digitado sem acento
---

Na janela **Encaminhar**, a busca ignorava maiúsculas, mas não acento: digitar
`joao` não achava "João", e o atendente rolava a lista inteira atrás do
contato. Agora `joao` acha "João" e `conceicao` acha "Conceição", com a mesma
regra da busca do Inbox — que também cobre letras como ñ, ü, ø e ß.

Contribuição de @bfs2021 (#4078, issue #4072).
