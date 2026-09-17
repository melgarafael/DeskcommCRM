# Doutrina de Versionamento

> Lei sobre o **número**: quem o decide, com que régua, e o que ele promete a quem já
> instalou. Complementa [`packaging.md`](./packaging.md), que trata de **como** o artefato
> chega ao disco do cliente — aqui trata-se de **o que o número diz** sobre o que chegou.
> Amarrada ao Definition of Done (`CLAUDE.md`).

| Se você quer… | Vá para |
|---|---|
| decidir se sua mudança é patch, minor ou major | §A régua |
| saber por que não é você quem escolhe o número | §Ninguém escolhe o número |
| escrever o fragmento que o seu PR precisa trazer | §O fragmento |
| saber qual versão está publicada agora | §A versão em vigor |

---

## O princípio-raiz

A pergunta que decide o número **não é** *"o que mudou no código?"*. Tudo muda — essa
pergunta não separa nada, e uma régua que não separa nada devolve sempre a mesma resposta.

A pergunta é:

> **"O que o dono da VPS precisa fazer?"**

Porque o número não é um rótulo de esforço nem um troféu de tamanho: é uma **promessa
operacional** para alguém que vai rodar `bash update.sh` sem ler o diff, num servidor onde o
WhatsApp da empresa dele está atendendo cliente agora.

Quem lê o número é o operador, não o autor. A régua tem que ser escrita da cadeira dele.

---

## A régua

| O que acontece com quem já roda | Número |
|---|---|
| Não precisa fazer nada, e **nada que funcionava mudou de forma** | **patch** — `1.6.0` → `1.6.1` |
| Não precisa fazer nada, mas **ganhou capacidade nova** | **minor** — `1.6.1` → `1.7.0` |
| **Precisa agir**: editar `.env`, rodar comando, ou algo que existia sumiu / mudou de forma | **major** — `1.7.0` → `2.0.0` |

A linha de baixo não é escolha nossa: ela já é lei em `CLAUDE.md`, na doutrina de packaging
e no [ADR 0001](../adr/0001-packaging-e-distribuicao.md) — *bump que exige edição manual não
entra; vira issue com plano de migração e vai para uma major*. Esta doutrina apenas estende
a mesma lógica para baixo, para a faixa onde **todas** as releases do projeto realmente caem.

### Por que "comportamento visível" NÃO é a régua

Esta é a régua que estava em vigor, e ela é a causa mecânica do problema que originou este
documento. Escrita em voz alta no commit de release da v1.6.0 (`e9df4bae`):

> *"MINOR porque muda comportamento visível ao cliente final."*

**Um conserto de bug, por definição, muda comportamento visível ao cliente final.** Sob essa
régua todo conserto é minor, e o número perde a capacidade de distinguir "consertamos o que
estava quebrado" de "o sistema faz algo novo". Medido no histórico: **seis minors e duas
patches em trinta dias**, com `v1.4.0` → `v1.6.0` em três dias.

O caso da v1.6.0 é o mais instrutivo, porque o número **estava certo** — aquela versão trazia
os formulários do Respondi, capacidade nova de verdade. Ele estava certo **pelo motivo
errado**, justificado pelo conserto e não pela adição. Régua que acerta por acidente erra na
próxima.

### O teste de uma linha

Antes de escolher, escreva a frase que o operador vai ler na tela de atualização:

- *"Você não precisa fazer nada."* → **patch**
- *"Você não precisa fazer nada; agora o sistema também faz X."* → **minor**
- *"Antes de atualizar, você precisa…"* → **major**

Se a terceira frase é verdadeira, o número é major **mesmo que a mudança seja pequena** — o
custo que ele mede é o do operador, não o do autor.

---

## Ninguém escolhe o número

O número é **calculado** a partir do que os PRs declararam, nunca digitado por quem está
cortando a release. Isso não é preferência de estilo: é o que torna **impossível** a colisão
entre duas sessões de trabalho paralelas.

Enquanto a escolha era humana, ela dependia de ler `git tag` e somar um — e duas sessões que
leem a mesma lista no mesmo dia chegam ao mesmo número. O resultado medido está no commit
`ac9472c5`, escrito pela sessão que descobriu o estrago por acaso:

> *"A 1.4.1 está no CHANGELOG e NÃO tem tag."*

Uma sessão escreveu a seção da versão e nunca criou a tag. Como a tela de atualização mostra
**a seção da versão-alvo**, os dois avisos da 1.4.1 — um deles instruindo o operador a apagar
a conexão que estava funcionando — teriam desaparecido para quem pulasse direto para a 1.5.0.

Com o número derivado, a pergunta *"qual é a próxima versão?"* deixa de ter dono e passa a
ter **resposta**: é função do conjunto de fragmentos acumulados, e duas sessões que rodem o
cálculo obtêm o mesmo resultado porque olham para o mesmo conjunto.

### A tag nasce no CI

`git tag` na máquina de alguém é o ponto onde o número deixa de ser revisável. A tag é criada
pelo CI, a partir de um PR de release, e **só de um commit contido na `main`**.

Três razões medidas, todas com consequência no parque instalado:

1. **A tag é o gatilho de atualização de todo mundo.** `hostgator-setup-kit/agent.sh` faz
   `git fetch --tags` e `hostgator-setup-kit/update.sh` puxa a imagem **por número**. Tag
   errada não é erro cosmético de changelog: é o seletor do que cada VPS baixa.
2. **Uma tag `v*` de qualquer branch move o canal `stable`.** O workflow de publicação não
   testa se o commit está na `main`.
3. **Mover uma tag já publicada quebra a VPS e mente sobre o motivo.** O `git fetch --tags`
   do `update.sh` recusa a tag movida (`would clobber existing tag`) e sai com erro — que o
   script relata como *"não consegui falar com o GitHub"*. O operador fica no código antigo
   procurando um problema de rede que não existe.

Daí a regra que a doutrina de packaging já enuncia e esta reforça: **versão publicada é
imutável**. Corrige-se com `X.Y.Z+1`, nunca republicando o mesmo número.

---

## O fragmento

Todo PR que muda comportamento traz um arquivo em `.changes/`, e é ele que declara o impacto
e escreve o texto que o operador vai ler.

```markdown
---
impacto: nada_mudou     # nada_mudou | capacidade_nova | exige_acao
secao: corrigido        # adicionado | alterado | corrigido
titulo: A IA avisa o cliente antes de chamar uma pessoa
---

Quando o atendimento automático parava e a conversa ia para a fila humana, o
cliente não recebia mensagem nenhuma: ele falava, e ninguém respondia.
```

**O campo é o efeito, não o número** — e essa escolha é a régua inteira. Pedir
`impacto: minor` convidaria de volta exatamente o erro que este documento existe para
corrigir, porque "minor" é a *resposta*, e responder a resposta é o que se faz quando não
se tem a pergunta. `nada_mudou` não tem como ser respondido errado por quem sabe o que
fez. O número sai de `BUMP_DO_IMPACTO`, em `lib/release/fragmento.ts`, e a régua está
presa por valor no teste ao lado — inverter a tabela reprova o CI.

Quando `impacto: exige_acao`, o fragmento traz também um bloco `## Requer atenção` com o
que o operador precisa fazer; sem ele o fragmento é recusado, e o contrário também
(aviso com impacto mais brando). Quem emite o `### ⚠️ Requer atenção` que a tela procura é
o montador, uma vez só.

Para conferir o que os fragmentos de agora produziriam, sem escrever nada:

```bash
pnpm release:conferir
```

Três propriedades, e cada uma resolve um defeito medido:

- **Um arquivo por PR, nome único.** Dois PRs paralelos criam dois arquivos diferentes, e o
  conflito de merge deixa de ser possível *por construção*. Medido: **oito merges** com
  conflito real no `CHANGELOG.md`, todos concentrados em 25–26/08 — a mesma janela dos três
  minors em três dias.
- **Escrito por quem fez a mudança, quando fez.** O texto para de ser reconstruído do `git
  log` dias depois por quem não estava lá. Medido: **13 de 45** commits entre a v1.5.0 e a
  v1.6.0 não têm eco na seção da versão.
- **O impacto é declarado, não inferido.** Derivar de mensagem de commit não funcionaria
  aqui: medido, 94,4% dos commits sem merge seguem Conventional Commits, mas apenas 2,2% dos
  merges — e há **zero** marcações de breaking change em 2.639 commits, o que tornaria major
  inderivável.

### Por que não uma ferramenta pronta

`release-please` e `semantic-release` montam o changelog a partir de mensagens de commit.
Aqui isso não serve, e a razão é do produto, não de gosto: **o `CHANGELOG.md` é tela.**
`lib/system/changelog.ts` extrai a seção de uma versão e a rota de sistema a entrega ao dono
da VPS. É prosa longa em português — média de cerca de cem linhas por versão — escrita para
quem não leu o diff. Nenhum gerador produz isso a partir de `fix(scope): ...`.

O que se adota dessas ferramentas é a **ideia** — fragmento por PR, número derivado, release
por PR acumulativo —, não o gerador de texto.

---

## A versão em vigor

Não está escrita aqui, e isso é deliberado: afirmação de versão envelhece a cada release, e
foi assim que `AGENTS.md` passou seis minors dizendo `1.0.0`. Comando não envelhece:

```bash
git ls-remote --tags --refs origin 'refs/tags/v*' \
  | sed 's#.*refs/tags/v##' | awk '!/-/' | sort -V | tail -1
```

O `awk '!/-/'` descarta prerelease e tag de fork — o repositório carrega `v1.1.1-jmpo.1` e
`jmpo/v1.4.0`, que existem para **não** colidir com a numeração daqui.

E o `package.json` **não** é a fonte: ele segue em `0.1.0`, de propósito. A fonte é a tag
`v*` mais a seção do `CHANGELOG.md`.

---

## A vitrine

Toda versão publicada aparece na página de changelog da LP, nos três idiomas:
[deskcomm.com.br/changelog](https://www.deskcomm.com.br/changelog),
[/en/changelog](https://www.deskcomm.com.br/en/changelog) e
[/es/changelog](https://www.deskcomm.com.br/es/changelog), cada versão com página própria
(`/changelog/X.Y.Z`). É lá que quem ainda não instalou — e quem decide se atualiza — lê o que
mudou sem abrir o GitHub.

**Enquanto as três páginas não responderem 200, o parágrafo acima descreve o alvo e não o estado.**
Elas nascem num PR do repositório `deskcomm-site`, e o corte depende delas: com a vitrine fora do
ar, o passo abaixo reprova **toda** release depois de 35 tentativas, cerca de meia hora de espera. Quem for cortar confere
antes — o comando não envelhece, a frase envelheceria:

```bash
for p in /changelog /en/changelog /es/changelog /guias; do
  echo "$p: $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://www.deskcomm.com.br$p")"
done
```

Quatro `200` e esta seção vale como está escrita. Qualquer `404` e a ordem é a inversa: a vitrine
entra no ar primeiro, o corte depois.

**Ninguém escreve release no site.** A LP (repositório `deskcomm-site`) lê o `CHANGELOG.md` da
`main` e revalida a cada 10 minutos. Então a regra de quem corta release não é "lembre de
atualizar a LP" — regra que não protege quem a escreve —, e sim:

1. **A seção entra no `CHANGELOG.md` pelo caminho normal** (fragmentos → PR de release). Uma
   seção que chegou à `main` de outro jeito também aparece: a LP lê o arquivo, não as Releases
   do GitHub. Foi o que salvou a v1.20.0, cuja tag foi criada à mão e nunca ganhou Release.
2. **O cabeçalho da seção é contrato.** `## [X.Y.Z] — AAAA-MM-DD`, subseções em `###`. O leitor
   da LP (`deskcomm-site/lib/changelog.ts`, outro repositório) usa a mesma expressão que
   `tests/unit/release-chega-na-lp.test.ts` cobra aqui. Mudar o formato é mudar os dois
   repositórios no mesmo movimento.
3. **O corte confere a consequência.** O último passo do job `cortar-tag` —
   *"A versão aparece na página de changelog da LP?"* — procura o link da versão nas três
   páginas em 35 tentativas, cerca de meia hora (até ~47 min se o site responder devagar), e **reprova** o job se ela não aparecer. Vermelho ali não quer
   dizer que a versão não saiu (tag, Release e imagens já foram conferidas antes); quer dizer
   que a vitrine não mostra, e isso se conserta na LP.
4. **O texto é escrito em português.** Em inglês e espanhol a página traduz a moldura, avisa que
   as notas estão em português e oferece a tradução do navegador. Traduzir a seção a cada
   release fica fora até existir quem revise a tradução — nota de versão com erro de tradução
   num `⚠️ Requer atenção` é pior que nota em outra língua.

Se o passo falhar, a ordem de investigação é: a LP responde? → o `CHANGELOG.md` da `main` tem a
seção com o cabeçalho certo? → o formato mudou sem o leitor da LP mudar junto?

**Depois de consertar a LP, não re-rode o job para conferir.** Um "Re-run failed jobs" roda no
mesmo commit, onde a tag já existe: a guarda de idempotência do passo `pendente` grava
`cortar=nao`, e este passo — como o das imagens — aparece como pulado. O job fica verde sem ter
olhado a LP. A conferência depois do conserto é à mão, com o laço de `curl … | grep -c` de
`triagem/TRIAGEM.md` (seção "Depois do merge, a versão sai"), nos três caminhos: `/changelog`,
`/en/changelog` e `/es/changelog`.

Três coisas fazem essa conferência à mão mentir, e as três mentem no sentido do susto:

- **Não basta trocar a URL.** O `href` procurado carrega o prefixo da própria página —
  `/en/changelog/X.Y.Z` na inglesa, `/es/changelog/X.Y.Z` na espanhola. Procurar o link do pt nas
  outras duas devolve 0 **com a versão listada**. O passo do `release.yml` monta o padrão com
  `${p}` justamente por isso; o laço da receita monta igual.
- **0 também é o que a página inexistente devolve.** Num 404 o corpo não tem o `href`, e o
  `grep -c` conta 0 igualzinho a uma página que existe e ainda não listou a versão — dois
  desfechos opostos com o mesmo número. Por isso a receita imprime o `http=` ao lado da contagem,
  e o passo do `release.yml` nomeia o status de cada página que faltou antes de reprovar.
  `http=404` é a vitrine fora do ar, e repetir não conserta.
- **Com `http=200`, 0 na primeira volta não é veredito.** A página revalida a cada 10 minutos e lê
  o `CHANGELOG.md` pelo `raw.githubusercontent.com`, que guarda outros 5: a versão aparece em até
  ~15 min, e é o próprio acesso que agenda a regeneração. Repita antes de concluir que a vitrine
  não mostra — é a mesma razão pela qual o passo do `release.yml` repete a sonda 35 vezes, e não
  duas.

---

## Os invariantes

1. **O número responde ao operador, não ao autor.** A pergunta é sempre o que ele precisa
   fazer.
2. **Ninguém digita o número.** Ele é calculado a partir dos fragmentos declarados.
3. **A tag nasce no CI, de commit contido na `main`.** Nunca da máquina de alguém.
4. **Versão publicada é imutável.** Conserto é `X.Y.Z+1`; nunca republicar o mesmo número.
5. **Todo PR que muda comportamento traz seu fragmento.** Sem ele, o texto que chega ao
   operador é reconstruído por quem não estava lá — ou não chega.
6. **Bump não pode exigir edição manual de arquivo na VPS.** Se exigir, é major e vem com
   plano de migração.
7. **Toda versão publicada aparece na vitrine.** A LP lê o `CHANGELOG.md`; o corte confere
   que ela chegou, nos três idiomas, e reprova quando não chegou.
