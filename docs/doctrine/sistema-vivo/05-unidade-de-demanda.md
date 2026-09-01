# 5. A unidade de demanda

> O objeto central do sistema é o problema, não a pessoa e não a conversa.

---

# Princípio

## 5.1 A unidade do propósito precisa existir no modelo

O propósito é resolver demandas (capítulo 2). Portanto **a demanda tem que ser uma entidade de primeira classe** — com identidade própria, ciclo de vida e desfecho.

Se ela não existe no modelo de dados, três coisas acontecem, todas silenciosas:

1. **O sistema não consegue medir o próprio propósito**, porque o denominador natural (uma demanda resolvida) não é contável.
2. **O invariante 4 não pode ser verificado.** "Nenhuma demanda sem próximo passo" exige enumerar demandas abertas. Sem a entidade, você enumera *conversas* abertas — que não é a mesma coisa e erra nos dois sentidos.
3. **O histórico se fragmenta.** O que aconteceu com um problema fica espalhado entre conversas, canais e responsáveis, e só existe reconstituído na cabeça de quem estava lá.

## 5.2 Por que pessoa e conversa não bastam

**Pessoa é a errada** porque a mesma pessoa tem vários problemas ao mesmo tempo, com estados e desfechos diferentes. Um cliente com um pedido atrasado e uma dúvida de cobrança não tem "um estado" — tem dois. Modelar por pessoa força o sistema a escolher qual dos dois ele enxerga.

**Conversa é a errada** por três razões:

- Um problema atravessa **vários canais**. Começou no chat, seguiu por e-mail, terminou no telefone: é um problema, três conversas.
- Uma conversa contém **vários problemas**. A pessoa pergunta do pedido e aproveita para perguntar do plano.
- A conversa termina quando alguém para de escrever; **o problema termina quando é resolvido.** São eventos diferentes, e a distância entre eles é exatamente onde as demandas morrem sem que ninguém veja.

Uma métrica ancorada em conversa é, além disso, **enganável**: encerrar cedo melhora todos os indicadores por conversa sem resolver nada.

## 5.3 Anatomia de uma demanda

O conjunto mínimo, e cada campo com sua razão:

| Elemento | Por quê |
|---|---|
| **Identidade** | Referenciável por humano e por sistema |
| **Solicitante** | Quem tem o problema — não necessariamente quem escreveu |
| **Abertura** | Quando entrou, e por qual canal e evento |
| **Assunto / tipo** | Base da agregação e do roteamento |
| **Estado** | Onde está no ciclo, com transições válidas declaradas |
| **Dono corrente** | Automação ou pessoa nomeada. **Nunca vazio** |
| **Próximo passo** | O que acontece a seguir e quando — o invariante 4 vive aqui |
| **Prazo** | Contra o qual a espera é medida e comunicada |
| **Desfecho** | Como terminou, incluindo o encerramento pela própria pessoa |
| **Vínculos** | Conversas, mensagens, registros e ações que pertencem a ela |

Dois campos merecem atenção especial.

**Dono nunca é vazio.** Demanda sem dono é a definição operacional de "vai morrer". Se ninguém assumiu, o dono é a automação, e isso é uma decisão registrada — não um vazio que ninguém nota.

**Próximo passo é campo, não é consequência.** Se ele é derivado de outra coisa, ele desaparece nos casos em que a derivação falha, que são exatamente os casos em que ele importa.

## 5.4 As cardinalidades

```
pessoa 1 ── N demanda
demanda 1 ── N conversa      (o problema atravessa canais)
conversa 1 ── N demanda      (uma conversa pode abrir mais de um problema)
demanda 1 ── N responsável   (ao longo do tempo, com histórico de posse)
demanda 1 ── 1 desfecho      (terminal, e um só)
```

A relação demanda↔conversa é **muitos-para-muitos**, e resistir a isso é a fonte de metade dos problemas de modelagem nesse domínio. Tentar forçar um-para-um obriga a escolher entre perder o problema que atravessa canais ou perder o segundo problema levantado na mesma conversa.

## 5.5 Desfechos, e o encerramento pelo cliente

Os desfechos precisam ser **enumerados e terminais**. E a lista precisa incluir os que não são vitória:

- Resolvido
- Convertido (quando o desfecho é comercial)
- Não procede / fora de escopo
- **Encerrado pela pessoa** — ela decidiu que acabou
- Perdido / desistência
- Expirado sem resposta

O quarto item é o mais importante e o mais esquecido. **O sistema não pode ser o único a decidir que uma demanda acabou.** Se pudesse, ele fecharia por conveniência: encerrar por inatividade é a forma mais fácil de melhorar todos os números sem melhorar nada.

Já "expirado sem resposta" é um desfecho **legítimo e ruim**. Deve ser contável e vigiado. Um sistema onde essa contagem é zero não está saudável — está mal instrumentado.

## 5.6 Como migrar sem parar tudo

Introduzir a entidade de demanda num sistema que já roda sobre pessoa e conversa. O caminho de menor risco, em quatro passos:

**1. Criar a entidade ao lado, sem tirar nada.** Ela nasce apontando para o que já existe. Nada quebra.

**2. Derivar o passado por regra explícita.** Uma demanda por conversa com desfecho conhecido, uma por caso já aberto. A regra fica escrita: histórico derivado por regra é honesto; histórico derivado por adivinhação vira dado que ninguém sabe se pode usar.

**3. Passar a criar no ponto de entrada real.** Toda demanda nova nasce da entidade, e não é mais derivada. A partir daqui os números novos são confiáveis.

**4. Migrar os consumidores um a um** — invariante 4, painéis, índice de atrito. E só então a conversa deixa de ser tratada como unidade.

O erro a evitar é o passo 2 com adivinhação. Um histórico reconstruído por heurística contamina todas as comparações futuras, e ninguém vai lembrar disso daqui a seis meses ao comparar dois trimestres.

---

# Aplicação de referência — SonghaiCRM

**O que já existe:** contatos e leads como entidades; conversas e mensagens; estágios de funil com máquina de transições; linha do tempo de atividades por lead; e **casos** — que hoje modelam o atendimento humano aberto a partir de um handoff.

**O caso é o embrião certo.** Ele já tem abertura, dono, estado, vínculo com conversa e desfecho. O que falta para ele ser a unidade de demanda: nascer de **toda** entrada — não só de handoff —, aceitar mais de uma conversa e mais de um canal, e ter o próximo passo e o prazo como campos próprios.

**No desenho original isto já estava previsto.** O diagrama traz "Jornada do Problema" acima de "Jornada do Cliente" — e a de cima ficou em branco. O sistema modelou a jornada do cliente (conhece → interesse → contato → relacionamento → fechamento) e ainda não modelou a jornada do problema, que é a que o propósito promete resolver.

**Dependências:** o denominador do Índice de Atrito (capítulo 3) e a verificação do invariante 4 dependem desta entidade. É a mudança de maior porte do manual, e é a que fica mais cara a cada mês — todo consumidor novo escrito sobre "conversa" é mais um a migrar depois.
