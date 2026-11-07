---
impacto: nada_mudou
secao: corrigido
titulo: A busca da lista de agentes volta a achar nomes acentuados digitados sem acento
---

Em Agentes de IA, digitar `pos-venda` não achava "Atendimento Pós-venda": a
filtragem ignorava caixa, mas não acento, e a lista ficava vazia como se o
agente não existisse.

Agora os dois lados da busca (o termo digitado e o nome da lista) passam pela
mesma régua de acento do Inbox (`termoSemAcento`), em uma função pura testada à
parte, seguindo o desenho do PR #4078 da janela Encaminhar.
