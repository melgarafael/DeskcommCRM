# Prova em tela — guias do assistente e changelog da LP

Medido em 2026-09-15 contra `next build` + `next start` do `deskcomm-site` (branch
`feat/guias-e-changelog`, commit `ac55a44`), Chromium via Playwright, lendo o `CHANGELOG.md`
real da `main` do produto (40 versões).

```bash
BASE=http://localhost:3217 OUT=/tmp/telas node evidence/lp-guias-changelog/2026-09-15/prova.mjs
```

| o que | resultado |
|---|---|
| verificações | 533 verdes, 0 vermelhas (`run.txt`) |
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

## As telas

A prova salva dezenas de telas; **oito entraram no repositório**, escolhidas para cobrir os dois
extremos de largura, os três idiomas e os dois formatos de changelog (a listagem e a página de uma
versão). O resto é artefato de build e fica de fora.

| tela | o que ela mostra |
|---|---|
| `evidence/lp-guias-changelog/2026-09-15/telas/home-cabecalho-pt-BR-360.png` | O cabeçalho da home no celular (360px, pt-BR). O botão dos guias encolhe para o ícone `>_` e convive com "Instalar na VPS" sem nada sair da tela nem quebrar linha. |
| `evidence/lp-guias-changelog/2026-09-15/telas/home-cabecalho-es-1280.png` | O mesmo cabeçalho em 1280px e em espanhol — o idioma mais largo, o que estourava a tela em 1024px antes do conserto. Nav, seletor PT/EN/ES, "Guías para devs" com o rótulo inteiro, contagem do GitHub e "Instalar en un VPS", tudo em uma linha de 57px. |
| `evidence/lp-guias-changelog/2026-09-15/telas/guias-pt-BR-1280.png` | A página de guias inteira (captura de página cheia), alcançada pelo botão do cabeçalho. Os seis cartões de guia com o filtro de público, as cinco abas de assistente, os dois jeitos de instalar, o "Mexer num guia" e o FAQ. |
| `evidence/lp-guias-changelog/2026-09-15/telas/guias-instalar-es-360.png` | O bloco "Instalar" no celular, em espanhol, logo depois do clique em copiar: o `curl … \| bash` quebra dentro da caixa em vez de ser cortado (o defeito da rodada anterior) e o botão mostra o "✓" de copiado — a mesma ação cujo texto a prova confere na área de transferência. |
| `evidence/lp-guias-changelog/2026-09-15/telas/changelog-pt-BR-1280.png` | O changelog em pt-BR, aberto pelo link do rodapé da home: as 40 versões publicadas, o cartão da mais recente (v1.27.2) e a barra de filtros — "Todas", "Requer atenção", "Adicionado", "Alterado", "Corrigido" — com a busca ao lado. |
| `evidence/lp-guias-changelog/2026-09-15/telas/changelog-es-360.png` | O mesmo changelog em 360px e em espanhol: moldura traduzida, números intactos e nenhuma rolagem horizontal. É a largura onde a data transbordava 4px da coluna antes do conserto. |
| `evidence/lp-guias-changelog/2026-09-15/telas/versao-1.27.2-en-1280.png` | A página da versão mais recente em inglês. Mostra a decisão do texto em português: o aviso de idioma com o botão "Open in Google Translate" apontando para esta mesma versão, e as notas renderizadas abaixo, no `article` marcado `lang="pt-BR"`. |
| `evidence/lp-guias-changelog/2026-09-15/telas/versao-1.0.0.png` | A v1.0.0, a seção escrita à mão com o formato mais irregular do arquivo: 35 itens em nove domínios, "Requer atenção" à frente dos demais, introdução antes das seções, ids únicos e nenhum `**` cru sobrando no texto. |

## Segunda rodada: o preview da Vercel

Em 2026-09-16 a mesma prova rodou contra o preview do PR na Vercel, com um segredo de bypass
temporário, revogado logo depois. O resultado está em `run-vercel-preview.txt`.

| o que | resultado |
|---|---|
| verificações | 533 verdes, 0 vermelhas |
| versões lidas | 42, com a mais nova v1.28.0 |

A régua do script passou a vir do próprio `CHANGELOG.md`: o número de versões e a mais nova são
lidos na hora, e não escritos à mão.

O preview foi construído com 40 versões. A 1.27.3 e a 1.28.0 saíram depois do build e apareceram
sem nova implantação. As páginas dessas duas versões, que não existiam no build, abriram com 200
nos três idiomas.

Duas coisas vistas no caminho, as duas esperadas:

- **O primeiro acesso depois da janela de 10 minutos devolve a lista antiga e agenda a nova.** A
  página em inglês mostrou 40 na primeira visita. A em espanhol listou a 1.28.0 só no segundo
  pedido. Por isso o passo do `release.yml` repete a sonda em vez de conferir uma vez só.
- **Um script com o número de versões escrito à mão quebra a cada release.** A versão anterior
  deste script reprovou por isso.

## Terceira rodada: o preview do commit final do site

Em 2026-09-16, depois dos consertos da revisão adversarial dos três PRs, a prova rodou de novo
contra o preview do commit `af09d9e` do `deskcomm-site`, com outro segredo de bypass temporário,
revogado logo depois. O resultado está em `run-preview-commit-final.txt`.

| o que | resultado |
|---|---|
| verificações | 533 verdes, 0 vermelhas |
| versões lidas | 43, com a mais nova v1.29.0 |

O script mudou num ponto: o seletor de idioma passou a ser achado pelo `hreflang`, porque o
`aria-label` da navegação de idiomas agora é traduzido e deixou de ser "Idioma" em inglês.

O log desse deploy na Vercel mostra `pnpm run build` rodando o `prebuild` e os 32 testes do site
antes do `next build`.

Não medido: o passo novo do `release.yml`, que só roda num corte de release real.
