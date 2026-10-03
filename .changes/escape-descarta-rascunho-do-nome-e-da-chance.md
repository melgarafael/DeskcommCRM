---
impacto: nada_mudou
secao: corrigido
titulo: Escape no nome e na chance da etapa volta a descartar o rascunho, não a gravar (#2164)
---

Nos dois campos editados no lugar da tela de etapas, `NomeDaEtapa` e `ProbabilidadeDaEtapa`, a tecla Escape restaurava o valor gravado e chamava `blur()` na mesma hora: o `onBlur` que confirma rodava com o rascunho antigo (o `setState` do Escape ainda não tinha aplicado) e gravava justamente o que a tecla devia descartar — o nome saía `Carrinho abandonadoX` e a chance saía `40` no PATCH, medidos na issue. Agora os dois campos usam a mesma marca em `useRef` que o `JanelaDaEtapa` já usava: o Escape liga a marca antes do blur, o confirmar do blur seguinte a consome e não grava. Confirmar sem Escape (Enter ou sair do campo) continua gravando como antes, e o janela de esfriando não mudou. Nada de migration, rota ou texto novo em tela — não é preciso fazer nada na instalação.

Contribuição de @webtecnica (#2172, refs #2164).
