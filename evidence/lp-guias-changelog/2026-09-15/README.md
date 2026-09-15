# Prova em tela — guias do assistente e changelog da LP

Medido em 2026-09-15 contra `next build` + `next start` do `deskcomm-site` (branch
`feat/guias-e-changelog`, commit `ac55a44`), Chromium via Playwright, lendo o `CHANGELOG.md`
real da `main` do produto (40 versões).

```bash
OUT=./telas node prova.cjs      # com o site em http://localhost:3217
```

| o que | resultado |
|---|---|
| verificações | 533 verdes, 0 vermelhas (`run.log`) |
| erros de console e de rede | 0 |
| larguras do cabeçalho | 360, 390, 640, 768, 900, 1024, 1100, 1180, 1280 e 1440 px, nos três idiomas |

O que a prova percorre, como uma pessoa faria:

- **Cabeçalho da home.** Botão dos guias visível e clicável, item nenhum fora da tela, nenhum
  link quebrando linha, e o rótulo certo por largura.
- **Da home aos guias pelo botão.** `lang` e canonical da página, fontes carregadas, filtro de
  público, abas por clique e por teclado, botão de copiar com a área de transferência conferida,
  FAQ e seletor de idioma para a MESMA página.
- **Do rodapé ao changelog.** 40 versões, busca com e sem acento, estado vazio com "limpar",
  filtro "requer atenção", cartão da mais recente, texto marcado `lang="pt-BR"`, aviso e link de
  tradução em en/es, e "versão anterior".
- **Versões escritas à mão.** 1.0.0, 1.2.1, 1.3.0 e 1.6.0: ids únicos, nenhum `**` cru,
  citação, código e introdução.
- **Em toda página.** Nenhuma rolagem horizontal, e nenhum vazamento de `undefined`, `NaN`,
  `null`, `[object Object]` ou `{v}`.

Três defeitos apareceram nas rodadas anteriores e foram consertados antes desta:

- **Espanhol em 1024px.** O cabeçalho passava 29px da tela.
- **Celular.** O comando de instalação ficava cortado.
- **Changelog em 360px.** A data transbordava 4px da coluna. Esse defeito nasceu do conserto de
  outro.

Não medido aqui: o site no ar (a Vercel ainda não tem a branch) e o passo novo do `release.yml`,
que só roda num corte de release real.
