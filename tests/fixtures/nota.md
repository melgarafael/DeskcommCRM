# Referências do "sem grupo é a lista de hoje" (#3245)

Estes dois arquivos foram GERADOS, não escritos à mão: são o `outerHTML` do
componente ANTES desta mudança (`git show HEAD:` dos arquivos), renderizado com
a mesma fixture de respostas rápidas que o teste usa (`tests/unit/grupos-sem-grupo-e-a-lista-de-hoje.test.tsx`).
O `_r_X_` no lugar dos contadores `_r_<n>_` é a única normalização: eles são
gerados por render (React) e mudam a cada montagem, não a cada mudança de
markup — comparar sem normalizar mediria o contador, não a tela.

- `respostas-rapidas-lista-plana-antes-dos-grupos.html` — o `<ul>` da lista de
  respostas da tela `/app/templates` (arrastar e soltar incluídos).
- `respostas-rapidas-barra-plana-antes-dos-grupos.html` — a barra de recursos
  do Inbox.

A prova: com `grupos` vazio, o componente de hoje tem de produzir EXATAMENTE
este HTML. Quando a lista plana mudar de propósito, a referência é regerada —
o que o teste impede é a mudança SILENCIOSA.
