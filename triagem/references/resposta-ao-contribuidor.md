# Resposta ao contribuidor

> Puxe nos passes 1 e 10. Este reference é o **como falar**; o que medir está em
> `complemento-do-ci.md`.

O objetivo não é ser simpático. É que a pessoa saiba exatamente onde está, o que foi medido, e o que
falta — e que nada do que ela leia seja cobrança por algo que ninguém contou a ela.

---

## Acolhida (passe 1) — em minutos, sem uma linha de avaliação

Três informações, nesta ordem. Nada além.

```markdown
<!-- triagem-de-pr:v1:pass=1 -->
Recebido, @<login> — obrigado por isto.

Duas coisas que vão parecer erro seu e não são:

- O check **Vercel** vermelho ("Authorization required to deploy") é esperado em PR de fork. A `main`
  faz deploy de produção e a Vercel se recusa a construir código de fora, o que está certo. **Ele não
  entra no gate de merge.**
- Os workflows ficam parados esperando liberação no primeiro PR de quem nunca contribuiu — política
  do GitHub, não sua. **Acabei de liberar**, o CI já está rodando.

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
