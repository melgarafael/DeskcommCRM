---
impacto: nada_mudou
secao: corrigido
titulo: Publicar acende logo depois de Salvar rascunho, sem recarregar a página
---

Depois de **Salvar rascunho** na tela do agente, o botão Publicar continuava
apagado com "Salve o rascunho antes de publicar" — e Salvar seguia aceso — até
alguém recarregar a página. Acontecia também ao editar a descrição e o
`inbound_debounce`. Quem não sabe recarregar não consegue publicar o agente, que
é o primeiro passo do produto.

Duas causas, as duas de comparação:

1. **Réguas diferentes.** A tela respondia "salvar mudaria alguma coisa?"
   comparando o formulário com o que está gravado — mas o servidor não grava o
   payload cru: `versionShapeSchema` faz `.trim()` no prompt e completa
   `trigger_config` com `include_tags`/`exclude_tags`/`include_pipeline_ids`/
   `exclude_pipeline_ids` (`.default([])`). Comparar sem passar os dois lados
   pela mesma régua acusava alteração para sempre. Ao recarregar, o formulário
   passava a ser hidratado do que estava gravado e os lados ficavam iguais por
   construção — daí o defeito "sumir" no reload.
2. **O que a sessão acabou de gravar.** `props.draft` vem do server component e
   só muda quando a página é buscada de novo. Entre o salvamento e o refresh, a
   tela não tinha rascunho nenhum para publicar. A ação devolve
   `version_id`/`version_number`, então a tela passa a saber o que gravou — e
   isso só vale com `res.ok`: falha no salvamento não acende Publicar nem limpa
   a marca de alteração pendente.

Provado por componente (`tests/unit/publicar-acende-depois-de-salvar-o-rascunho.test.tsx`),
com os três lados: salvar acende Publicar e apaga Salvar; editar de novo inverte;
falha no salvamento não mente; recarregar com rascunho gravado já nasce com
Publicar habilitado.
