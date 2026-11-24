---
impacto: nada_mudou
secao: corrigido
titulo: No computador, o botão "Editar horário" da Equipe deixa de transbordar a própria caixa
---

Em Equipe › Atendimento › Horário, a partir de 1024 px o botão que abre a jornada do atendente era de ícone, com 36 px de largura fixa, e o rótulo "Editar" — visível desde `lg` — não cabia nele: o conteúdo passava 15 px para cada lado da caixa. Agora o botão cresce com o conteúdo a partir de `lg`, com padding, e ícone e rótulo ficam dentro da caixa. No celular nada muda: o botão continua de ícone, com a área de toque de 44 px.
