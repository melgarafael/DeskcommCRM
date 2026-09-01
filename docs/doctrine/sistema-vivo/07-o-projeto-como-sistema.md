# 7. O projeto como sistema

> Os mesmos invariantes valem um nível acima: o projeto que produz o software também é um sistema, e falha pelas mesmas razões.

---

# Princípio

## 7.1 O meta-invariante

Um projeto de software aberto é um sistema com elementos (código, documentação, pessoas), relações (contribuição, adoção, financiamento) e um propósito. Portanto está sujeito aos sete invariantes — e o mais violado, com folga, é o quinto: **informação com propósito**.

A ironia recorrente: equipes constroem observabilidade impecável para o cliente do cliente e **nenhuma para si mesmas**. Elas sabem quantos leads o usuário perdeu, e não sabem quantas instalações do próprio software existem, onde elas travam, ou o que ninguém usa.

> Se você não consegue responder "quantas instâncias estão vivas e onde elas falham", seu projeto viola o invariante 5 no nível meta — e está pilotando no escuro.

## 7.2 Três públicos, três loops distintos

O erro estratégico mais comum é tratar isso como um funil só. São três sistemas com incentivos diferentes, e cada um tem seu próprio atrito.

| Público | O que quer | O que retém | Atrito fatal |
|---|---|---|---|
| **Quem implanta** | Que funcione hoje, na infraestrutura dele | Instalação sem surpresa; primeira semana sem susto | Erro no primeiro deploy |
| **Quem contribui** | Entender rápido e ver o próprio código entrar | Primeira contribuição aceita em pouco tempo | Verificação vermelha que não é culpa dele |
| **Quem patrocina** | Justificar orçamento internamente | Número que cresce e pode ser mostrado | Nenhuma métrica além de popularidade aparente |

Cada um exige um artefato diferente, e nenhum deles é "mais código".

## 7.3 O loop de reforço da adoção — e por que ele fica aberto

Existe um loop de reforço disponível em todo projeto aberto:

```
implantação real → caso de uso concreto → conteúdo → atenção
       ↑                                                  │
       └──────────── mais implantação ←───────────────────┘
```

Ele é o motor inteiro. E **fica aberto por um motivo técnico banal: software auto-hospedado é cego.** Sem sinal de volta, quem constrói não sabe quantas instâncias existem, onde elas quebram, o que foi abandonado na primeira semana. O loop não fecha porque falta o retorno — invariante 7, aplicado ao projeto.

Isso tem três consequências que se acumulam:

1. **A prioridade é adivinhada.** Trabalha-se no que parece importante, e não no que trava gente de verdade.
2. **O patrocinador não tem número.** Popularidade em repositório não converte em orçamento, porque não se traduz em nada que ele mede.
3. **O caso de uso não volta.** Cada implantação bem-sucedida é conteúdo em potencial que ninguém sabe que existe.

## 7.4 Telemetria com integridade

Fechar esse loop exige sinal de volta, e sinal de volta em software auto-hospedado é assunto delicado — merecidamente. Fazer certo é possível, e a diferença está inteira em cinco regras:

1. **Consentimento explícito.** Perguntar na instalação, com a resposta padrão sendo a que o usuário escolheu — não a que favorece quem coleta.
2. **Conteúdo declarado por extenso.** Uma página que lista cada campo enviado, em linguagem comum. Não uma política jurídica.
3. **Desligável por um comando**, documentado no mesmo lugar em que é ativado.
4. **Nada identificável.** Sem dado de cliente final, sem conteúdo de mensagem, sem identificador que reconstrua quem é. Versão, plataforma, funcionalidade acionada, erro ocorrido — e só.
5. **Agregado devolvido ao público.** Quem contribuiu com o dado enxerga o resultado.

A quinta regra é a que transforma coleta em reciprocidade, e ela paga triplo: é a métrica do patrocinador, é o mapa de onde o produto falha, e é conteúdo por si só — um painel público de adoção de um projeto aberto é material de divulgação que se atualiza sozinho.

Sem essas cinco, telemetria é extração, e extração num projeto aberto custa reputação — que é o único capital que ele tem.

## 7.5 O atrito de contribuição

Vale a mesma análise do capítulo 3, aplicada a quem contribui. O desfecho é: **primeira contribuição aceita.** Tudo antes disso é atrito.

Onde ele se acumula, em ordem de mortalidade:

| Atrito | Por que mata |
|---|---|
| **Verificação vermelha por configuração, não por código** | A pessoa conclui que quebrou algo e desiste antes de perguntar |
| **Ambiente que não sobe em uma tentativa** | O custo de entrada excede a curiosidade |
| **Nenhuma tarefa de entrada real** | Sem porta, só quem já conhece o sistema consegue começar |
| **Revisão lenta** | O interesse tem meia-vida curta; uma semana já dissipou |
| **Doutrina implícita** | A contribuição é recusada por uma regra que não estava escrita — e ninguém volta depois disso |

A última é a mais cara e a menos percebida. **Uma doutrina escrita é, entre outras coisas, um instrumento de acolhimento**: ela permite que alguém de fora acerte na primeira tentativa. Doutrina que só existe na cabeça de quem mantém o projeto transforma toda contribuição externa em tentativa e erro — e ninguém tenta duas vezes.

## 7.6 A métrica certa não é a popular

Popularidade em repositório mede intenção, não uso. Alguém marca um projeto e nunca volta.

O desfecho que importa depende do modelo. Para software que se instala:

| Sinal | Mede | Vale |
|---|---|---|
| Estrelas | Intenção momentânea | Pouco |
| Cópias do repositório | Intenção de mexer | Algo |
| **Instalações que sobrevivem à primeira semana** | Uso real | **Muito** |
| **Contribuições aceitas de fora** | Saúde da comunidade | **Muito** |
| Instâncias ativas por período | Retenção | Muito |

Aplique aqui a regra 3.3, do par eficiência/dano: **a contra-métrica da adoção é a mortalidade** — quantas instalações morreram na primeira semana, e por quê. Um projeto que só publica adoção está publicando metade da verdade, e é a metade que não ajuda a melhorar nada.

## 7.7 Sustentação sem cobrar do usuário final

Quando o financiamento vem de terceiros que se beneficiam do crescimento — em vez de assinatura do usuário —, o desenho de incentivos muda e precisa ser explícito:

- O patrocinador precisa de **um número que ele já saiba interpretar**, ligado ao benefício dele.
- O número precisa ser **verificável e publicado**, não uma afirmação de quem pede o patrocínio.
- O interesse do patrocinador precisa estar **alinhado ao do usuário**, não em conflito. Financiamento que empurra o produto para um lado que o usuário não quer corrói a base que o financiava.

O teste de sanidade: **se o produto melhorar muito para o usuário, o patrocinador ganha mais ou menos?** Se ganha mais, o alinhamento é estrutural e o arranjo dura. Se ganha menos, o arranjo tem prazo de validade e é melhor saber disso desde o começo.

## 7.8 A doutrina é o artefato que viaja

Uma observação estratégica, e ela vale para além deste projeto.

**O código é um exemplar. A doutrina é o que se replica.**

Um sistema resolve um domínio; ele compete com todos os outros que resolvem o mesmo domínio. Um método atravessa domínios e não compete com ninguém, porque a categoria costuma estar vazia. Quem se estabelece como arquiteto de sistemas se estabelece por um **texto que outras pessoas passam a usar para pensar** — e o software é a prova de que o texto funciona.

Consequências práticas:

- A doutrina precisa **existir fora** do repositório do produto. Enterrada em uma pasta de documentação, ela só encontra quem já chegou — é uma tela sem porta, no vocabulário do invariante 6.
- Ela precisa ser **aplicável a outro sistema**, o que exige a separação princípio/aplicação (ver o README deste manual). Doutrina que só funciona citando as tabelas do próprio produto nunca foi doutrina.
- O produto passa a ser apresentado como **implementação de referência** do método — não como um produto que por acaso tem um método.

---

# Aplicação de referência — SonghaiCRM

**Modelo:** distribuição aberta, instalação em infraestrutura própria, monetização por patrocínio de empresas que se beneficiam do crescimento da base instalada — notadamente provedores de infraestrutura, cujo produto é vendido por quem sobe a aplicação. O alinhamento passa no teste de 7.7: quanto melhor o produto para o usuário, mais instalações, mais benefício para o patrocinador.

**O que está aberto hoje:**

| Item | Estado |
|---|---|
| Telemetria opt-in | Não existe — o loop de 7.3 está aberto |
| Painel público de adoção | Não existe — patrocinador sem número verificável |
| Verificação em cópia externa do repositório | Parada por padrão — atrito fatal de 7.5, já identificado |
| Tarefas de entrada para quem chega | Não sistematizado |
| Doutrina publicada fora do repositório | Não — este manual é o primeiro passo |

**Ordem de menor custo e maior efeito:** destravar a verificação em cópia externa (dias) → telemetria opt-in com painel público (semana) → publicar a doutrina como artefato próprio (semana). Os três atacam loops abertos distintos e nenhum depende do outro.
