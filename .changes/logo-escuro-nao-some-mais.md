---
impacto: nada_mudou
secao: corrigido
titulo: "Logo escuro/colorido não some mais no tema escuro"
---

Um logo pensado para fundo claro (a maioria do que se sobe em `/admin/marca`
e `/app/settings/marca`) ficava ilegível no tema escuro: o fundo da barra
lateral e da tela de entrada é quase preto (`--color-surface` escuro), e um
logo escuro sobre quase-preto não tem contraste nenhum.

Agora a barra lateral, a tela de entrada e a prévia da própria tela de marca
mostram o logo sobre um chip branco arredondado quando o tema é escuro — a
mesma lógica que já existe para o texto dos botões, aplicada ao logo. No tema
claro nada muda: o chip só aparece quando o fundo por trás dele é escuro.

Quem já tinha um logo pensado para fundo escuro (raro, mas possível) passa a
ver uma moldura branca de sobra em vez de nada — troca aceita, porque o pior
caso "moldura desnecessária" é sempre melhor que o pior caso "logo invisível".
