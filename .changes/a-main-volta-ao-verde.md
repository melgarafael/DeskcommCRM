---
impacto: nada_mudou
secao: corrigido
titulo: O aviso de erro da importação de planilha volta ao raio de borda do produto
---

A caixa de aviso da tela de importar leads estava com o canto arredondado pela
metade — 4px em vez dos 8px que o resto do produto usa. É pequeno e é visível:
ela fica ao lado de outros blocos com o raio certo.

A causa é da migração para o Tailwind 4, que mudou o significado de `rounded`
puro. Quem escreveu a tela usou o nome que valia antes.
