# 6. O tempo do sistema

> Tempo real é propriedade do canal de observação. No canal de ação, é uma decisão de engenharia.

---

# Princípio

## 6.1 A confusão que parece um requisito

Uma frase que aparece em quase toda especificação ambiciosa:

> ~~"Todas as áreas do sistema devem funcionar em tempo real."~~

Ela mistura duas coisas que têm exigências opostas.

**Observar** em tempo real é quase sempre bom. É o que torna a governança possível: o humano vê o sistema operando, percebe o desvio enquanto ele acontece e pode intervir antes do dano. O limite é a atenção humana, não a técnica.

**Agir** em tempo real é frequentemente ruim. Loop de reforço com delay curto demais oscila (capítulo 1.4). E agir na velocidade da máquina contra uma pessoa do outro lado não é eficiência — é pressão.

A formulação correta:

> **Observação em tempo real. Ação no tempo apropriado ao humano do outro lado.**

## 6.2 Os três relógios

Todo sistema que atende pessoas opera com três relógios simultâneos, e confundi-los é a origem da maioria dos erros de tempo.

| Relógio | Escala | Governa |
|---|---|---|
| **Do sistema** | milissegundos a segundos | Processamento, propagação de evento, atualização de tela |
| **Da pessoa atendida** | segundos a dias | Ritmo de conversa, tempo para decidir, tolerância a espera |
| **Do operador** | minutos a horas | Turno de trabalho, capacidade de fila, expediente |

**A regra de acoplamento:** cada saída do sistema é regida pelo relógio de quem a recebe — nunca pelo relógio de quem a produz.

Uma atualização de painel corre no relógio do sistema. Uma mensagem ao cliente corre no relógio dele. Uma atribuição de tarefa corre no relógio do operador. Um sistema que envia mensagem no relógio da máquina produz a experiência de estar sendo perseguido por um robô — que é exatamente o que ele é.

## 6.3 Delay deliberado é um recurso de projeto

Contra a intuição de engenharia, boa parte da qualidade de um sistema de relacionamento vem de **atrasos escolhidos de propósito**:

- **Espaçamento entre mensagens** — porque uma pessoa não recebe cinco mensagens em dois segundos de outra pessoa.
- **Janela de atendimento** — porque mandar mensagem de madrugada custa mais do que ganha, mesmo que o sistema esteja acordado.
- **Espera antes de responder a uma sequência** — a pessoa costuma mandar três mensagens seguidas; responder à primeira é responder à pergunta errada.
- **Adiamento do follow-up** — a diferença entre lembrete e cobrança é só o intervalo.
- **Janela de arrependimento** — o intervalo entre decidir e efetivar, no qual um humano ainda consegue cancelar.

Cada um desses atrasos é uma escolha de produto com razão declarada. **Delay sem razão declarada é lentidão; delay com razão declarada é desenho.** A diferença aparece na revisão: um você defende, o outro alguém "otimiza" no trimestre seguinte por parecer desperdício.

## 6.4 A regra da interruptibilidade

> **O sistema nunca deve ser mais rápido do que o humano consegue interromper.**

Se uma decisão automática vira efeito irreversível no mundo antes que uma pessoa consiga cancelá-la, a autoridade humana do capítulo 4 é ficção — ela existe no organograma e não no relógio.

Isso não significa colocar aprovação humana em tudo. Significa que **quanto mais irreversível o efeito, maior o intervalo entre a decisão e a consumação**. É uma escala, não um interruptor:

| Efeito | Reversibilidade | Intervalo apropriado |
|---|---|---|
| Atualizar um painel | Total | Imediato |
| Registrar uma nota interna | Alta | Imediato |
| Mudar estado de uma demanda | Média (auditável, reversível) | Imediato com registro |
| Enviar mensagem a uma pessoa | **Nenhuma** | Espaçado, com veto antes |
| Ação com efeito financeiro | Nenhuma | Confirmação explícita |

A coluna que decide é a do meio. Repare que "enviar mensagem" é irreversível — não existe desfazer. Todo sistema que trata envio como operação comum está tratando o irreversível como reversível.

## 6.5 Tempo real como direito do observador

Onde tempo real é inegociável: **na visão do humano sobre o que o sistema está fazendo.**

O motivo é o invariante 4. Se a informação de que algo está parado chega com atraso, o mecanismo anti-morte chega atrasado junto — e a demanda morre no intervalo. Painel que atualiza a cada hora é um painel que descobre o problema uma hora depois de ele importar.

Isso vale especialmente para:

- **Fila e espera** — o número que dispara o loop de equilíbrio do capítulo 4.
- **Falha de operação** — o que quebrou tem que aparecer enquanto ainda é reversível.
- **Conversa ao vivo** — o humano precisa poder assumir no meio, não depois.

## 6.6 A honestidade do prazo

Um sistema que promete tempo tem que cumprir ou avisar. Não há terceira opção aceitável, e a segunda é muito mais barata do que parece.

**Espera comunicada custa uma fração da espera silenciosa.** A pessoa que sabe que vai esperar duas horas espera duas horas. A pessoa que não sabe nada desiste em vinte minutos e conta para os outros — e a diferença entre as duas não está no tempo, está na informação.

Consequência de projeto: o sistema precisa **conhecer o próprio prazo real** — não o prometido no material de vendas, o medido. E precisa disparar comunicação quando vai ultrapassá-lo, antes que a pessoa perceba sozinha. Isso é fluxo de informação (capítulo 1.9): a alavanca mais barata que existe, mais uma vez.

---

# Aplicação de referência — SonghaiCRM

**Onde a doutrina do tempo já está materializada:**

| Mecanismo | Relógio que respeita |
|---|---|
| Espaçamento mínimo entre envios, com variação aleatória | Da pessoa atendida — e proteção do canal |
| Janela horária por fuso, evitando domingo | Da pessoa atendida |
| Aquecimento progressivo de número novo | Do canal externo |
| Follow-up agendado para momento futuro combinado | Da pessoa atendida |
| Atualização ao vivo de inbox e quadro | Do observador |
| Recuperação de envio travado, com aviso na central | Do operador |

**A correção que este capítulo faz na doutrina anterior.** A formulação original — "todas as áreas possíveis do sistema devem funcionar em realtime" — está substituída pela regra de 6.1. O sistema já se comportava assim na prática: existe throttle, janela e aquecimento, todos deliberados. O texto é que dizia outra coisa, e texto que diverge do comportamento é o que produz a decisão errada quando alguém novo o lê como lei.

**Dívida declarada:** o sistema não comunica prazo real. Não há mecanismo que informe a pessoa quando a espera vai ultrapassar o esperado — item 6.6 e o mais barato de todos os apontados neste manual.
