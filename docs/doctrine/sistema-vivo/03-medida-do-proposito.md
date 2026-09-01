# 3. A medida do propósito

> Um sistema converge para o que ele mede, não para o que ele declara.

Este é o capítulo mais importante do manual. Todos os outros descrevem como construir; este descreve como saber se o que você construiu faz o que você prometeu.

---

# Princípio

## 3.1 A armadilha da métrica de atividade

O propósito de um sistema é o que ele faz (capítulo 1.3). E o que ele faz converge, com o tempo, para aquilo que é medido — porque a medida é o que orienta prioridade, o que aparece em reunião, o que define o que é considerado melhoria.

Daí a armadilha mais comum em software de atendimento e vendas:

| O que se mede | O que se otimiza | O que acontece |
|---|---|---|
| Mensagens respondidas | Volume de respostas | Um sistema que responde muito e resolve pouco |
| Tempo até a primeira resposta | Velocidade de acusar recebimento | "Olá! Já vou verificar" em 2 segundos, e nada depois |
| Taxa de conversão | Insistência | Mais vendas fechadas e relacionamento queimado |
| Conversas atendidas | Encerramento precoce | Conversa fechada rápido, problema não resolvido |

Nenhuma dessas métricas é errada. Todas são **atividade**, e atividade é o que sobra quando ninguém definiu desfecho.

O ponto que dói: um agente automatizado que insiste seis vezes converte mais e destrói relacionamento. **Nos painéis convencionais ele aparece como o melhor agente do sistema.** Nada denuncia, porque o dano não tem coluna.

## 3.2 A regra: propósito em estado terminal

> Defina o propósito como um **estado final**, não como uma atividade.

- Ruim: "responder mensagens", "automatizar atendimento", "engajar leads".
- Bom: "venda fechada", "problema resolvido", "agendamento cumprido", "encerrado pelo cliente".

Estado terminal tem três propriedades que atividade não tem: é **verificável** (aconteceu ou não), é **contável** (vira denominador), e é **honesto** (não se pode fingir desfecho com esforço).

Tudo o mais deriva daí. Sem essa definição, não existe índice, não existe alvo, e a próxima métrica proposta em reunião vence por ser a mais fácil de coletar.

## 3.3 Toda métrica de eficiência precisa de uma contra-métrica de dano

Esta é a regra prática que impede o sistema de se otimizar contra si mesmo.

**Toda medida que empurra o sistema a fazer mais de alguma coisa vem acompanhada da medida que denuncia o custo dessa coisa.** Elas são publicadas juntas, no mesmo painel, com o mesmo destaque. Nunca separadas — separadas, a de eficiência vence sempre, porque é a que sobe.

| Métrica de eficiência | Contra-métrica de dano |
|---|---|
| Taxa de conversão | Turnos até o desfecho · opt-outs |
| Automação (% sem humano) | Pedidos explícitos de humano · reabertura |
| Velocidade de resposta | Repetições da mesma pergunta pelo cliente |
| Volume atendido | Abandono após a última mensagem do sistema |
| Redução de custo por conversa | Tempo humano por desfecho |

Se você só puder implementar uma ideia deste manual, implemente esta. Ela é intervenção em **fluxo de informação** — o degrau mais barato e mais potente da escada de alavancagem (capítulo 1.9) — e não exige mudar uma regra sequer do sistema.

## 3.4 O Índice de Atrito

Quando o propósito declarado é "menor atrito possível para os dois lados", atrito precisa de número. Caso contrário o propósito é decoração: ele não pode ser perseguido, comparado nem defendido.

**Atrito é tudo que a pessoa gastou além do necessário para chegar ao desfecho.** Tempo, repetição, espera, esforço de explicar de novo, esforço de cobrar.

### Componentes do lado do cliente

| Sinal | O que denuncia | Como se obtém |
|---|---|---|
| **Turnos até o desfecho** | Ineficiência da conversa | Contagem de mensagens até estado terminal |
| **Repetições da mesma pergunta** | O sistema não entendeu — o cliente reformulou | Similaridade entre mensagens do cliente na mesma demanda |
| **Tempo até a primeira resposta *útil*** | Distingue acusar recebimento de resolver | Primeira resposta que muda o estado da demanda |
| **Pedidos explícitos de humano** | Confiança perdida na automação | Detecção no texto + acionamento de handoff |
| **Espera não comunicada** | O pior tipo de espera | Intervalos sem mensagem acima do prazo prometido |
| **Abandono** | A última mensagem é do sistema e a pessoa sumiu | Demanda sem desfecho e sem resposta após N |
| **Opt-out** | Atrito máximo — a pessoa pediu para sair | Sinal de descadastro |
| **Reabertura** | O desfecho anterior era falso | Nova demanda sobre o mesmo assunto em janela curta |

### Componentes do lado da empresa

| Sinal | O que denuncia |
|---|---|
| **Intervenções humanas por desfecho** | Quanto a automação realmente absorveu |
| **Tempo humano por desfecho** | O custo real, não o custo de licença |
| **Retrabalho** | Demandas que voltaram para a fila humana |
| **Vetos por execução** | Quanto o sistema precisou ser contido de si mesmo |
| **Espera na fila humana** | O gargalo verdadeiro (capítulo 4) |

### As quatro regras de construção

Um índice mal construído é pior que nenhum, porque tem aparência de rigor.

**1. Nunca some unidades diferentes sem normalizar.** Minutos e contagens não se somam. Normalize cada componente contra sua própria distribuição histórica (percentil, ou desvio em relação à mediana) antes de agregar.

**2. O agregado nunca aparece sozinho.** Todo índice é exibido com seus componentes ao lado. Índice sem detalhamento é um número que ninguém sabe o que fazer com — violação direta do invariante 5.

**3. O denominador é o desfecho, não a conversa.** "Turnos por conversa" premia encerrar cedo. "Turnos por problema resolvido" não tem como ser enganado sem resolver de verdade.

**4. Declare a régua junto do número.** Todo valor publicado carrega o período, o escopo e a versão da definição. Índice cuja definição mudou sem aviso destrói a única coisa que ele tinha: comparabilidade no tempo.

## 3.5 A pergunta que valida qualquer painel

Para cada número exibido, uma pergunta:

> **Se este número piorar 20%, o que alguém faz de diferente amanhã de manhã?**

Sem resposta concreta, o número não pertence ao painel. Ele pode continuar existindo no banco — mas ocupar atenção humana é um privilégio que se conquista mudando decisão.

## 3.6 Contra a otimização local

Cada área maximizando o próprio indicador produz um resultado pior do que ninguém maximizando nada. Vendas bate meta empurrando cliente errado; suporte afoga; a saída sobe; vendas precisa vender mais. Cada um está certo localmente e o conjunto perde.

A defesa estrutural é ter um número no topo que **pertence ao sistema inteiro** e ao qual as métricas de área se subordinam explicitamente. No caso deste manual: desfechos alcançados, com o Índice de Atrito ao lado.

Se as métricas de área podem melhorar enquanto o número do topo piora, o desenho de métricas está errado — não as áreas.

---

# Aplicação de referência — SonghaiCRM

**Propósito em estado terminal, já declarado:** venda fechada · suporte resolvido/concluído · agendamento feito. É a base do índice; a definição existe desde o desenho original do sistema.

**Dados que já existem e ainda não viram índice:** contagem e direção de mensagens por conversa; carimbos de tempo de cada mensagem; acionamentos de handoff; vetos dos gates de envio, com motivo e trilha durável; opt-out por detecção de descadastro; estágio e desfecho do lead; atividade por lead na linha do tempo.

**O que exige instrumentação nova:** *primeira resposta útil* (hoje só existe primeira resposta); *repetição da mesma pergunta* (exige comparação semântica entre mensagens do cliente na mesma demanda); *abandono* (exige a definição de janela por canal); *reabertura* (depende da unidade de demanda do capítulo 5).

**A ordem correta:** o denominador do índice é o desfecho por **demanda**, e a demanda ainda não é entidade de primeira classe (capítulo 5). Um índice construído sobre "conversa" nasce enganável pela regra 3 acima. Caminho pragmático: começar com os componentes que não dependem do denominador — vetos, opt-out, pedidos de humano, tempo humano — e completar o índice quando a unidade de demanda existir.
