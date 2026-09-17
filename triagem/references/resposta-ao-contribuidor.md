# Resposta ao contribuidor

> Puxe nos passes 1 e 10, e no 12-ter quando só parte de um PR entrou. Este reference é o **como falar**; o que medir está em
> `complemento-do-ci.md`.

O objetivo não é ser simpático. É que a pessoa saiba exatamente onde está, o que foi medido, e o que
falta — e que nada do que ela leia seja cobrança por algo que ninguém contou a ela.

---

## Acolhida (passe 1) — em minutos, sem uma linha de avaliação

**Ela sai sozinha em PR de fork**, por `.github/workflows/acolhida.yml`, em minutos e sem depender
de alguém estar triando — que era o gargalo real: a taxa de recusa aqui é zero, o que custava era o
tempo até alguém olhar. O passe 1 humano só escreve isto quando o robô não escreveu (PR interno, ou
o workflow desligado); e o robô desiste sozinho se já houver qualquer âncora `triagem-de-pr:v1:` no
PR — inclusive a sua.

Duas frases do molde abaixo o robô **não pode** dizer, e é por isso que o texto dele não é cópia
literal: "acabei de liberar" (ele não libera — aprovar run de fork é executar código de fora nos
nossos runners, e está recusado por escrito no cabeçalho do workflow) e um prazo negociado caso a
caso (ele promete "em até um dia útil", fixo). Mudar o texto aqui sem mudar lá faz as duas versões
divergirem; `tests/unit/acolhida-nao-toca-no-fork.test.ts` guarda o essencial do lado de lá.

Três informações, nesta ordem. Nada além.

```markdown
<!-- triagem-de-pr:v1:pass=1 -->
Recebido, @<login> — obrigado por isto.

Uma coisa vai parecer erro seu e não é:

- Os workflows ficam parados esperando liberação no primeiro PR de quem nunca contribuiu — política
  do GitHub, não sua. **Acabei de liberar**, o CI já está rodando.

Quando eles terminarem, o que trava o merge são só os checks marcados **Required** no seu PR — é essa
lista que vale, não qualquer outro vermelho que apareça. No terminal, `gh pr checks <número> --required`
mostra os obrigatórios que **já reportaram**, e só esses: enquanto um deles não rodou, ele não aparece
ali. Se um reprovar, a saída dele diz o que falta; se não estiver claro, me diga aqui — não feche o PR.

Vou revisar de verdade — rodando os gates e reproduzindo o comportamento, não só lendo o diff — e
volto com o resultado <prazo>. Se eu achar algo, venho com a medição junto, nunca com um "acho que".
```

**Por que a acolhida não avalia:** é isso que a torna segura de ser automática. Ela não pode estar
errada sobre o mérito porque não fala do mérito. Um "parece ótimo!" postado antes de medir é a
semente do carimbo — e carimbo é pior que silêncio, porque lava.

**Prazo:** prometa o que você cumpre. Se não souber, diga "hoje ainda" ou "até amanhã", não uma hora
exata.

---

## Veredito (passe 10)

Estrutura, e cada parte tem função:

1. **O que o PR faz**, em uma frase, na sua leitura. Serve para ele corrigir você se você entendeu
   errado — antes de discutir a solução.
2. **O que você mediu**, com o comando e a saída. Não "testei e funciona": *o comando, e o que ele
   imprimiu*.
3. **O que você NÃO mediu.** Obrigatório. É o campo que separa medição de relato.
4. **O que falta, se falta** — cada item com a medição que prova o defeito, anexada.
5. **O crédito**, pelo nome, do que ele achou ou mediu.

### As três regras duras

**Creditar pelo nome.** Se o PR revelou um buraco no projeto, diga isso em voz alta: *"seu PR fez a
gente descobrir que X"*. É a coisa mais forte que se pode dizer a alguém que contribuiu de graça.

**Nunca cobrar como descuido um gate que não está documentado.** Hoje o CONTRIBUTING pede coisas que
o CI não afere, e o CI exige coisas que o CONTRIBUTING não menciona — dá para marcar o checklist
inteiro de boa-fé e ser reprovado por algo que nunca se soube que existia. Quando isso acontecer:

> "O `lint:channels` reprovou aqui, e isso não estava no CONTRIBUTING — falha nossa, não sua. Já
> corrigi a documentação neste PR: <link>. O que ele quer é <explicação em uma frase>."

**Nunca pedir sem medição anexada.** Se você não reproduziu, não é pedido — é pergunta, e vai
redigida como pergunta. Já mandamos um contribuidor consertar um bug que não existia na `main`; ele
teria escrito código para um defeito inexistente. Uma correção pública custa menos que isso, mas o
certo é medir antes.

---

## Quando o veredito é SEGURAR

O tom não muda. O que muda é que o bloqueador precisa ser **acionável**: arquivo, linha, o defeito, e
**como reproduzir**. Se ele não consegue reproduzir com o que você escreveu, o bloqueador não está
pronto para ser publicado.

E diga o que **não** é bloqueador, para ele não gastar tempo com o que já está bom.

```markdown
<!-- triagem-de-pr:v1:pass=10 -->
Medi, e tem um bloqueador — o resto está bom e eu digo o que está bom, para você não mexer à toa.

**Bloqueia:** `hostgator-setup-kit/install.sh:412` — o script termina com "Instalação concluída"
mesmo quando o site não responde de fora, porque a sonda roda dentro do contêiner. Reproduzi assim:
<comando> → <saída>. Num produto que a pessoa instala sozinha, isso é o pior desfecho: ela não
descobre que quebrou.

**Não bloqueia, e é bom:** <o que está certo>.

**Sugestão, se fizer sentido pra você:** <opção>. Mas o desenho é seu — se preferir outro caminho,
me diz que eu meço o seu.
```

---

## Quando só parte do PR entrou

O PR parcialmente incorporado fica aberto só se o que sobrou tem destino (decisão do dono em
16/09/2026; passe 12-ter). O comentário começa igual nos dois casos — **o que entrou**, com o link, e
**o que não entrou**, com o motivo de cada parte — e muda no fim:

- **O resto tem destino** (decisão pendente, acompanhamento planejado, espera por resposta dele,
  destino de extensão): diga qual, e que é por isso que o PR continua aberto. PR aberto sem destino
  escrito lê como esquecido.
- **O resto foi descartado:** o PR fecha — por quem tem a autoridade de fechar naquela rodada
  (fronteira do `TRIAGEM.md`); sem ela, o comentário diz o que entrou e o fechamento vai para o
  relatório ao mantenedor. O motivo é sobre a parte, não sobre
  ele — por exemplo, *"serve à sua instalação e não a todas"*, ou *"a `main` já resolve isto de outro
  jeito, aqui"*.

O crédito não depende do desfecho: o que entrou está nos commits com ele como autor. Diga isso, com
o link — é o que ele vai procurar no próprio perfil.

```markdown
<!-- triagem-de-pr:v1:pass=12-ter -->
Parte deste PR entrou na `main`, nos commits com você como autor: <o que entrou> — <link>.

**O que não entrou, e por quê:** <a parte> — <o motivo, com a medição quando houver>.

<!-- se o resto tem destino -->
Por isso o PR continua aberto: <o destino — a decisão que falta e de quem ela é, o acompanhamento
planejado, ou o que eu preciso de você>.

<!-- se o resto foi descartado, e só quando quem escreve tem a autoridade de fechar nesta rodada -->
Por isso estou fechando o PR. Fechar aqui só registra que o resto não entra; o que entrou está
dentro, com o seu nome.
```

---

## Proibido

| não escreva | por quê |
|---|---|
| "Ótima contribuição!", "Boa pergunta!" como abertura | filler; a pessoa quer o resultado |
| "Só faltou você rodar os testes" | provavelmente ele rodou os que estavam documentados |
| pedido sem medição | pode ser fantasma |
| tom de correção ou de aula | ele não trabalha aqui |
| link para o Discord interno | é um beco sem saída para quem é de fora — mande para **Discussions** |
| prometer prazo que você não cumpre | a promessa não cumprida custa mais que o silêncio |

---

## O número que a triagem reporta

**Tempo entre abrir o PR e a primeira resposta humana.** É a única métrica de acolhimento que
mede o que a triagem controla.

Que creditar medição faça o contribuidor voltar é **hipótese** — ninguém perguntou a ele. Não escreva
como se fosse fato. O teste mais barato para converter a hipótese em dado é literalmente perguntar,
e vale a pena fazê-lo com quem já voltou.
