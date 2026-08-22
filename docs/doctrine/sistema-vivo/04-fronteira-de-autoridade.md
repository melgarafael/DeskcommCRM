# 4. Fronteira de autoridade

> Quem decide o quê entre automação, humano e sistema — e por onde o propósito vaza.

---

# Princípio

## 4.1 Separe por autoridade, não por tarefa

A divisão intuitiva é por tarefa: *a automação faz X, o humano faz Y*. Ela envelhece mal, porque a fronteira de capacidade se move a cada modelo novo, e o desenho inteiro precisa ser refeito.

A divisão que dura é por **tipo de autoridade**:

| Papel | Autoridade | Formulação |
|---|---|---|
| **Automação** | Executa | Conduz o processo até onde consegue e onde não há restrição |
| **Humano** | Julga | Decisor final: cria estratégia, resolve o que a automação não pode, analisa, otimiza, define quem vê o quê |
| **Sistema** | Governa | Fornece recursos, mostra o ocorrido, impõe limites, permite a intervenção humana |

Isso não é organograma; é onde cada tipo de erro é contido. E sobrevive ao avanço da capacidade: quando a automação passa a conseguir mais, ela ganha mais **execução** — nunca mais **julgamento**. A fronteira não se move; o volume dentro dela sim.

A frase operacional: **a automação propõe, o sistema valida, o humano decide o que sobra.**

## 4.2 Amplificar variedade na fala, atenuar na ação

Direto da lei de Ashby (capítulo 1.6). O que chega do mundo tem variedade praticamente ilimitada — uma pessoa pode dizer qualquer coisa, de qualquer jeito, em qualquer ordem. Nenhuma lista de regras absorve isso.

Portanto: **alta variedade na entrada, baixa variedade na ação.**

```
    entrada          interpretação        decisão         ação
  (ilimitada)  →  (alta variedade)  →  (validação)  →  (enumerável)
                   modelo generativo     determinística   conjunto fechado
```

A interpretação precisa de um componente de variedade equivalente à do mundo — hoje, um modelo generativo. A ação precisa ser um **conjunto fechado e verificável** de coisas que o sistema pode fazer, cada uma validada antes de acontecer.

Três regras que decorrem disso:

**1. O efeito colateral é sempre explícito.** A automação não age escrevendo texto livre; ela age chamando uma ação nomeada. Texto que não passou pela ação declarada não vira efeito no mundo — é descartado. Isso torna o conjunto de efeitos possíveis enumerável, e portanto auditável.

**2. A validação é do sistema, não do modelo.** Toda ação proposta passa por validação determinística: o payload é conferido contra um esquema estrito, a transição de estado contra a máquina de estados, o envio contra a cadeia de gates. Recusa vira **erro instrutivo de volta para o modelo** — que é como o sistema ensina sem depender de o modelo lembrar da regra.

**3. Comportamento crítico é determinístico, sempre.** Onde o erro é caro ou irreversível — dinheiro, promessa contratual, exclusão de dado, envio externo — a decisão é código, não modelo. O modelo pode *marcar* que algo aconteceu; quem valida e grava é a máquina.

Isto é a arquitetura em dois níveis do sistema imune (1.6): filtro barato e rápido na frente, especialista caro atrás — e nada do especialista alcança o mundo sem passar por um portão determinístico.

## 4.3 O handoff é o ponto de maior risco do sistema

O handoff parece a solução: quando a automação não dá conta, o humano assume. Na prática é **por onde o propósito vaza**, e por três razões que se somam.

**Primeira: é uma troca de regime de tempo.** A automação responde em segundos e é observável. A fila humana responde em horas e é opaca. A pessoa sai de um regime e entra em outro sem ser avisada — e a queda de qualidade percebida é atribuída ao sistema inteiro.

**Segunda: é onde o custo se acumula.** Tudo que a automação não absorveu vai para o recurso de menor capacidade e maior custo do sistema. **A fila humana é um estoque** — e estoque sem gestão de fluxo transborda (capítulo 1.4).

**Terceira: é o menos governado.** Quase todo sistema define *quando* escalar e quase nenhum define *o que fazer quando não há para quem escalar*. A regra de entrada existe; a regra de saturação, não.

## 4.4 Governança de carga

Se a fila humana é um estoque, ela precisa de um **loop de equilíbrio**: um mecanismo que, ao ultrapassar um limite, muda o comportamento do sistema em vez de continuar empilhando.

As quatro respostas possíveis, em ordem de preferência:

**1. Priorizar** — reordenar a fila por risco de perda e valor, não por chegada. É a mais barata e nunca é ruim.

**2. Comunicar honestamente** — quando a espera vai passar do prometido, avisar antes que a pessoa perceba sozinha. Espera comunicada custa uma fração da espera silenciosa; é o item de atrito mais barato de eliminar que existe.

**3. Redistribuir** — usar disponibilidade real, não atribuição nominal. Isso exige que o sistema saiba quem está livre, o que exige o invariante 6.

**4. Elevar o critério de escalada** — devolver à automação o que ela consegue fazer com risco aceitável, explicitamente e com registro. É a última, porque troca qualidade por vazão, e essa troca precisa ser uma decisão visível — nunca um efeito colateral silencioso da saturação.

O que **não** é resposta aceitável: enfileirar e torcer. É o padrão da indústria e é o oposto do invariante 4 — uma demanda enfileirada sem previsão nem próximo passo já está morrendo, apenas devagar.

## 4.5 Degradação honesta

Quando o sistema não consegue cumprir o padrão, ele tem duas saídas: **fingir** ou **declarar**.

Fingir custa mais. A pessoa descobre de qualquer forma — pela espera, pela resposta genérica, pela promessa não cumprida — e descobre no pior momento possível, que é depois de já ter confiado.

A regra:

> **Falhe fechado na ação, aberto na informação.**

Na dúvida sobre agir — não aja: o custo de uma ação errada e irreversível é maior que o de uma ação não tomada. Na dúvida sobre informar — informe: o custo de uma pessoa mal informada é sempre maior que o de uma pessoa informada de algo desconfortável.

O erro clássico é o inverso: agir por não saber o suficiente para parar, e calar por não ter certeza. Isso produz sistemas que fazem besteira em silêncio.

## 4.6 O humano precisa de superfície, não só de fila

Se o humano é o decisor final, o sistema precisa dar a ele o que decisor final precisa — e não apenas uma caixa de entrada:

- **Ver o que aconteceu** sem reconstruir a conversa (invariante 2).
- **Ver o que está valendo** — qual configuração, qual agente, qual regra produziu aquilo (invariante 6).
- **Interromper** — poder tomar a conversa a qualquer momento, e o sistema respeitar imediatamente.
- **Corrigir na origem** — se o comportamento está errado, o caminho para mudar a regra deve ser visível a partir do lugar onde o erro apareceu. Ver o erro e não saber onde consertar é a forma mais comum de doutrina virar frustração.

O item mais esquecido é o último. Ele transforma cada erro observado em uma melhoria possível — e é, na prática, o invariante 7 chegando ao humano.

---

# Aplicação de referência — SonghaiCRM

**Os três papéis, como desenhados:** o humano atendente (juiz e decisor final: cria estratégia, resolve o que a IA não pode, analisa métricas, otimiza os agentes, administra permissões); a IA (executa a conversão de etapas até onde consegue e onde não há restrição); o Sistema Operacional (fornece recursos, mostra o ocorrido, cuida da governança, permite a interação do humano com os processos gerados).

**A atenuação de variedade, onde ela mora:**

| Camada | Mecanismo |
|---|---|
| Ação nomeada | Enviar mensagem é sempre uma chamada de ferramenta; texto direto do modelo é descartado |
| Validação de payload | Esquema estrito por ferramenta — campo extra vira erro instrutivo, nunca descarte silencioso |
| Máquina de estados | Grafo fixo de estágios no código; regressão e salto são recusados com ensino |
| Cadeia de envio | Gates em ordem constante e versionada, com veto instrutivo e trilha durável |
| Teto de custo | Verificado antes de qualquer byte sair para o provedor |
| Fechamento de turno | Imposto pelo runtime — não depende de o modelo lembrar de chamar |

**O que está vivo no handoff:** resumo contextual montado para o humano (resumo corrente, compromissos, objeções, próxima ação), entregue ao inbox e não a um registro. Palavra-chave sentinela e detecção de pedido de humano acionam a passagem.

**O que falta — dívida declarada:** não existe loop de equilíbrio sobre a carga da fila humana. Não há limite que mude o comportamento do sistema quando a fila cresce, nem comunicação automática de prazo real ao cliente, nem devolução explícita à automação sob saturação. O sistema sabe *quando* escalar e não sabe *o que fazer quando não há para quem*. Este é o vazamento de maior impacto sobre o propósito declarado, e o capítulo 3 não consegue medi-lo enquanto a espera na fila humana não for instrumentada.
