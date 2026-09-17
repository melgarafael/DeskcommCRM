# A moldura do logo no tema escuro — prova em tela do PR #659

As imagens e medições desta pasta são o lastro da afirmação feita no PR **#832** (lote 3 da
triagem de 14/set): a moldura clara atrás do logo enviado **resolve o logo que some no tema escuro,
e não mexe em nada de quem não enviou logo** — a condição literal com que o dono do produto aprovou
a mudança (*"desde que não quebre o visual que já existe e está consolidado há meses"*).

Medido por ferramenta (`getComputedStyle`, `getBoundingClientRect`), num build de produção, com o
mesmo script (`medir-fachada.mjs`) aplicado a **dois** builds: o estado **anterior** ao #659 e o
atual. Nada aqui foi medido a olho.

## O que cada arquivo prova

### Com logo enviado — a moldura existe só no tema escuro

- `fachada-com-logo-dark.png` + `fachada-com-logo.json` — no escuro, o contêiner do logo tem
  fundo `rgb(255, 255, 255)`, padding `[8, 12, 8, 12]` e sombra: a moldura está pintada e contém o
  logo.
- `fachada-com-logo-light.png` — no claro, o mesmo contêiner tem fundo transparente e padding zero:
  a moldura é só do tema escuro.
- `ANTES-fachada-com-logo-dark.png`, `ANTES-fachada-com-logo-light.png` e `ANTES-fachada-com-logo.json` — o estado anterior ao #659. No escuro,
  o logo azul-marinho fica **quase invisível** sobre o fundo quase-preto: é o defeito que o PR
  resolve.

### Sem logo enviado — nada se move, nos dois temas

- `fachada-sem-logo-dark.png`, `fachada-sem-logo-light.png` e `fachada-sem-logo.json` — a marca própria do produto
  aparece **sem** moldura: nenhum ancestral da cadeia tem fundo claro.
- `ANTES-fachada-sem-logo-dark.png`, `ANTES-fachada-sem-logo-light.png` e `ANTES-fachada-sem-logo.json` — o mesmo, antes do #659.

A comparação entre `fachada-sem-logo.json` e `ANTES-fachada-sem-logo.json` é a prova da condição do
dono: a posição e o tamanho da marca e do cartão de acesso são **idênticos até a fração de pixel**,
nos dois temas.

**O preço, medido e não escondido:** para quem **tem** logo enviado, o cartão de acesso desce 8 px
no tema escuro — o padding vertical da moldura num bloco centrado. É a troca que o autor declarou no
próprio PR.

## O que estas imagens NÃO provam

- **A barra lateral** — que é a superfície principal do #659 — **não foi medida em tela**. Esta pasta
  cobre só a tela de entrada (a fachada). A medição foi feita com o daemon do Docker indisponível,
  e a fachada é a única superfície que resolve a marca sem banco; a barra lateral exige sessão.
- A prévia da tela de marca, a camada da **organização** (tudo foi pela camada da instalação), a
  barra recolhida, e navegadores além do Chromium.
- Contraste real de pixel: está provado que a moldura foi pintada e contém o logo, não que um logo
  específico ficou legível.

## Como refazer

A prova que fica, e que roda no CI, é a spec `tests/e2e/logo-moldura-no-tema-escuro.spec.ts`,
registrada em `SPECS_PARTE_3` do `.github/workflows/e2e.yml`. Ela cobre as três superfícies.

`medir-fachada.mjs` é o script que produziu os JSON desta pasta contra um `next start` já buildado,
**sem banco** — ele existe porque o Docker estava travado no dia. Não é gate e não substitui a spec;
fica aqui como proveniência das medições acima.
