# O limite de gasto com IA agora vale de verdade

> Para quem opera um SonghaiCRM na própria VPS. Escrito em português comum, sem
> jargão. Se você só quer a resposta curta, ela é: **você não precisa fazer nada.**

## O que estava errado

A tela **Uso de IA › Orçamento** sempre deixou você escrever um limite mensal de
gasto e dizia que a IA pararia ao chegar nele.

Ela não parava. O número que você digitava era guardado num lugar, e a peça do
sistema que decide se a IA pode responder olhava para **outro** lugar — um campo
que nenhuma tela editava. Não era um bug de vez em quando: **nenhuma instalação
estava protegida**, e a tela afirmava o contrário para todas.

Esta versão liga uma ponta na outra.

## O que muda para quem já usa

**Nada, até você decidir o contrário.** A proteção nasce **desligada** em todas
as organizações — inclusive nas que já tinham um número escrito na tela. Aquele
número continua lá, visível, e simplesmente não vale nada até alguém escolher que
ele valha.

Isso é deliberado. O sistema instala esse campo com um valor padrão, então "eu
escolhi US$ 50" e "eu nunca abri essa tela" são indistinguíveis para o banco de
dados. Ligar o limite para todo mundo de uma vez desligaria o WhatsApp de quem
nunca pediu nada.

**A única exceção:** se você tinha um limite configurado por dentro do servidor
(um campo técnico chamado `monthly_budget_cents`, que só quem mexeu no banco à
mão possui), esse limite **continua valendo exatamente como valia**. Ele foi
transferido para o lugar novo, com o mesmo número. Ninguém ganhou uma capacidade
de bloqueio que já não tivesse.

## ⚠️ O ponto que pede sua atenção: o valor é em DÓLAR

O provedor de IA cobra em dólar, e o sistema sempre guardou o número em dólar. A
tela é que escrevia "R$".

Quem lia **"R$ 50,00"** tinha, na verdade, um limite de **US$ 50,00** — cerca de
cinco vezes maior do que imaginava.

**Nada mudou no seu gasto nem no seu limite.** Mudou o rótulo, que agora diz a
verdade: `US$`. Não convertemos a moeda de propósito — converter exigiria o
sistema consultar uma cotação todo dia, o que é mais uma coisa para quebrar num
servidor que é seu.

**Antes de ligar a parada automática, olhe o número.** Se você escreveu "50"
pensando em reais, o que está lá é cinco vezes isso.

## E o gasto que aparece na tela?

Ele também estava errado, e agora está certo. O contador antigo somava **tudo
desde o dia da instalação** e nunca zerava — numa instalação com alguns meses de
uso, o card comparava vários meses de gasto contra um limite *mensal*. Agora o
número é o do **mês corrente**, e é exatamente o mesmo número que decide se a IA
para.

## Como ligar a proteção, se você quiser

Em **Uso de IA › Orçamento**, botão **Editar limite**. São três degraus, e eles
sobem um de cada vez:

1. **Só acompanhar** *(é onde você está)* — a IA nunca para por gasto. Você vê o
   número e decide o que fazer.
2. **Me avisar** — quando o gasto passar da porcentagem que você escolher (80%
   por padrão), abrimos um aviso na Central de avisos. **A IA continua
   respondendo normalmente.**
3. **Parar a IA no limite** — a IA para de responder quando o gasto do mês chega
   no valor.

Não dá para pular do primeiro direto para o terceiro: o sistema recusa. A fase de
aviso existe para você ver o gasto chegar perto antes que ele pare o seu
atendimento.

E, quando você arma a parada, **ela só começa a valer 72 horas depois**. É o
tempo de o aviso chegar até você antes de qualquer conversa parar. Se você tem
pressa e sabe o que está fazendo, marque **"Começar a valer agora"** no mesmo
diálogo.

O limite mínimo para avisar ou parar é **US$ 1,00 por mês**. Abaixo disso não é
orçamento de um atendimento — é erro de digitação, e um erro de digitação não
pode calar a sua IA. Se você quer só acompanhar sem limite nenhum, a opção certa
é **Só acompanhar**.

## O que acontece quando a IA para

Ela não some, e o cliente do outro lado não fica falando sozinho.

As conversas que estavam sendo atendidas vão para a **fila de atendimento
humano**, e um aviso aparece na Central explicando o motivo. Alguém da sua equipe
precisa responder — é o custo da parada, e ele está escrito na própria opção
antes de você escolher.

Para devolver uma conversa ao atendimento automático, use **"Devolver ao automático"** no cabeçalho dela.

**Atenção a esta parte:** aumentar o limite (ou desligar a parada) evita paradas
**novas**. Ele **não** devolve sozinho as conversas que já pararam — cada uma
volta pelo botão, uma a uma.

## Se algo der errado no meio da noite

Existe uma chave de emergência no arquivo `.env` do servidor:

```
AI_BUDGET_ENFORCEMENT=off
```

Com ela, e depois de reiniciar, **nenhum limite para nada**, em nenhuma
organização, independentemente do que estiver escolhido na tela. Há também um
meio-termo, `AI_BUDGET_ENFORCEMENT=avisar`, que rebaixa toda parada a aviso.

A chave só sabe **afrouxar**: ela nunca liga uma proteção que ninguém escolheu. O
valor padrão é `on`, que significa apenas *"respeite o que cada organização
escolheu"* — e, como todo mundo nasce em "Só acompanhar", `on` não liga nada.

Quando a chave está afrouxando, o card na tela **avisa**, com o nome da variável.
Um controle que o servidor ignora em silêncio é pior que controle nenhum.

## Coisas menores que saíram junto

- **O seletor "Ação ao atingir 100%" sumiu.** Ele oferecia "Pausar" e
  "Desabilitar" como se fossem futuros diferentes. Não eram — nada no produto os
  distinguia, e a escolha não tinha efeito nenhum.
- **Os avisos de orçamento agora se apagam sozinhos** quando o gasto volta para
  baixo do limite, quando você aumenta o teto ou quando o mês vira. Antes o
  alerta de "limite atingido" ficava aceso para sempre.
- **Nos painéis de administração**, o alerta de orçamento parou de gritar
  "crítico" sobre um número que não é o do mês; ele agora diz que o valor é
  acumulado e leva direto para a tela de saúde do cliente, que mostra o número
  real.

## Uma limitação que você merece saber

O sistema só sabe calcular o custo de algumas famílias de modelo da Anthropic. Se
você configurou um modelo de outro provedor (pela OpenRouter, por exemplo), o
gasto dele **não entra na conta** — e, se ele for o modelo principal, o limite
pode simplesmente nunca disparar.

Quando isso acontece, o card avisa, na própria tela, que a medição está
incompleta e que a parada pode não acontecer. Enquanto o cálculo de preço não
cobrir todos os modelos, **acompanhe o gasto também no painel do seu provedor de
IA**.

## Precisa fazer alguma coisa no servidor?

Não. Rode o `update.sh` como sempre. Nenhum arquivo precisa ser editado à mão, e
nenhuma variável nova é obrigatória — quem não tiver `AI_BUDGET_ENFORCEMENT` no
`.env` cai no padrão, que é o comportamento descrito aqui.
