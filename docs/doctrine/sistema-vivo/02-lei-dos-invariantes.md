# 2. A lei dos invariantes

> As sete propriedades que toda peça precisa ter para estar viva.

Um invariante não é uma boa prática. É uma propriedade que **vale sempre**, cuja violação é um defeito, e para a qual existe uma verificação. Se você não consegue escrever a verificação, ainda não é um invariante — é uma intenção, e intenções não sobrevivem a seis meses de pressão de prazo.

Este capítulo é o espelho comentado de [`../sistema-vivo.md`](../sistema-vivo.md). A lei é lá; aqui está o porquê de cada uma e a armadilha que cada uma tenta evitar.

---

# Princípio

## O princípio-raiz

> Chegou uma demanda — alguém interessado ou alguém com um problema — e o sistema é **responsável pela linha do tempo inteira dessa demanda até a resolução ou o encerramento declarado pela própria pessoa.**

Nada pode morrer no sistema por falta de resolução, de resposta, ou porque ninguém viu que havia algo ali precisando de atenção.

Onde a automação termina, começa uma continuidade contextualizada para o humano. Onde o humano termina, há um input estruturado para a automação retomar. Onde ambos param, há histórico legível do que foi feito.

Os sete invariantes são a decomposição verificável dessa frase.

---

## Invariante 1 — Nada é ilha

**Toda peça tem no mínimo uma aresta de entrada e uma de saída no grafo do sistema.**

A peça de origem é um polvo: recebe e distribui. Uma feature que só recebe, ou só emite, e não alimenta nada, está morta por definição.

*A armadilha que isto evita:* o CRUD disfarçado de funcionalidade. "Sistema de atendentes" como tela de cadastro de usuários é uma ilha. Atendente **vivo** é atribuição + carga + capacidade + métrica + relatório + log de atividade + destino de handoff.

*Verificação:* a peça aparece no mapa de arquitetura com ≥2 arestas reais — não decorativas.

*O que este invariante **não** garante:* que exista ciclo. Uma esteira linear tem todas as peças com entrada e saída e mesmo assim nada volta. Isso é o invariante 7.

## Invariante 2 — Continuidade nas duas direções

**Automação → humano:** quando a automação para (handoff, veto, incerteza), o humano recebe **contexto pronto para continuar** — um resumo do que aconteceu e por quê, não o registro cru.

**Humano → automação:** quando o humano para (responde, atribui, agenda), fica um **input estruturado** que a automação lê para retomar com contexto.

*A armadilha:* implementar o roteamento e chamar de handoff. Passar a conversa adiante não é continuidade; é transferência de custo. Se o humano precisa ler cinquenta mensagens para entender onde está, o sistema não entregou nada — só mudou o portador do problema.

*Verificação:* existe o payload de continuidade **nas duas direções**, não só o roteamento.

*Nota:* este invariante cobre a *qualidade* da passagem. Ele não cobre a *carga* — o que acontece quando o humano não dá conta. Ver capítulo 4.

## Invariante 3 — Log universal e visível

**Toda mutação relevante gera atividade — e aparece na tela.**

Não basta gravar. Registro que existe só no banco é registro morto: ninguém o consulta, ele não muda decisão nenhuma, e continua custando armazenamento e complexidade.

*A armadilha:* confundir auditoria com observabilidade. Auditoria responde "quem fez o quê" para quando alguém perguntar. Observabilidade responde "o que está acontecendo agora" para quem precisa agir. Os dois são necessários e **não são o mesmo artefato**.

*Verificação:* a mutação emite atividade **e** existe um lugar na interface onde ela é lida como parte da linha do tempo.

## Invariante 4 — Nenhuma demanda sem próximo passo

**Follow-up não é uma feature de agendamento; é o mecanismo anti-morte.**

O invariante operacional: para toda demanda aberta existe **(a)** um próximo passo definido e visível, ou **(b)** uma resolução/encerramento registrado. Uma demanda sem nenhum dos dois é um vazamento — o sistema falhou na missão.

*A armadilha:* achar que o silêncio é neutro. Não é. Silêncio é a forma mais comum de perda, e é invisível por construção: ninguém reclama de um atendimento que simplesmente parou.

*Verificação:* a lista de demandas abertas sem próximo passo tem que ser consultável. Se ela não pode ser consultada, o invariante não está sendo verificado — está sendo assumido.

## Invariante 5 — Informação com propósito

**Todo dado exibido responde: por que estou vendo isto, e o que faço a seguir.**

Traz insight e direção, não só estado. Um número na tela que não muda nenhuma decisão é ruído — e ruído tem custo: ele compete por atenção com o número que importava.

*A armadilha:* o painel de vaidade. Números que sobem, que todo mundo gosta de ver, e que nenhum deles altera o que alguém faria hoje.

*Verificação:* cada elemento de dado tem um "e daí?" — leva a uma ação, uma priorização ou um alerta.

## Invariante 6 — Toda configuração tem superfície

Os invariantes 3 e 5 cobrem o que **aconteceu** e o que se **vê**. Este cobre o que está **valendo**.

**Nenhum mecanismo pode depender de estado configurável que não tenha: tela para ver, tela para mudar, e caminho visível de falha.** Um mecanismo operável apenas por quem lê o banco não é operável.

*A armadilha:* o mecanismo invisível que funciona. Ele é pior do que não existir — quando falha, falha sem culpado, e ninguém sabe sequer onde procurar.

*Verificação:* para todo estado configurável existe (a) leitura na interface, (b) escrita na interface, e (c) a ausência de configuração vira alerta ou aviso — nunca um retorno mudo no worker.

*Corolário — tela sem porta não conta.* Ter tela e ser alcançável são coisas diferentes. Um destino a que só se chega digitando a URL é alcançável por ninguém.

## Invariante 7 — Todo laço se fecha

**Toda decisão automatizada tem um retorno mensurável que altera decisão futura.**

Para cada decisão que o sistema toma sozinho — responder, escalar, agendar, priorizar, avançar um estágio — existe um sinal de desfecho que volta e muda o comportamento seguinte: uma métrica que altera prioridade, um caso que vira conhecimento, um padrão que vira proposta de mudança.

*A armadilha, e ela é sutil:* os invariantes 1 a 6 podem estar todos satisfeitos num sistema que **não aprende nada**. Cada peça com entrada e saída, todos os registros gravados, todas as telas no lugar — e ainda assim uma esteira: a informação entra, atravessa, sai, e nada volta para mudar o que acontece amanhã.

A pergunta que expõe: **quando o sistema erra, o que muda nele?** Se a resposta é "fica registrado", o registro é um estoque morto. Registro é memória, e memória sem ninguém lendo é só custo de disco.

*Verificação:* para cada classe de decisão automatizada, nomeie o sinal de retorno e onde ele é consumido. "Nenhum" é uma resposta válida apenas com justificativa escrita — e é dívida declarada, não ausência de defeito.

*Distinção importante:* fechar o laço **não** significa que o sistema se altera sozinho. Um laço pode terminar numa proposta que um humano aprova. O que o invariante proíbe é o laço que termina em lugar nenhum.

---

## A regra do tempo (correção de um erro comum)

Uma formulação que parece invariante e não é:

> ~~"Todas as áreas do sistema devem funcionar em tempo real."~~

Tempo real é excelente para **observação** — o humano vendo o sistema operar ao vivo é o que torna a governança possível. Para **ação**, é uma armadilha: loop de reforço com delay curto demais oscila, e agir na velocidade da máquina contra um humano do outro lado é perseguição, não atendimento.

A formulação correta:

> **Observação em tempo real. Ação no tempo apropriado ao humano do outro lado.**

Não é preciosismo. Invariantes mal escritos viram decisão errada meses depois, tomada por alguém que leu a doutrina como lei — inclusive por quem a escreveu. Capítulo 6 desenvolve.

---

## O que deliberadamente **não** é invariante

Uma lista de invariantes que cresce sem controle deixa de ser cobrada. Estas três são regras boas, e não estão aqui de propósito:

- **Cobertura de testes.** É meio, não propriedade do sistema. Vira invariante disfarçado de número e envelhece mal.
- **Padrões de nomenclatura e estilo.** Importam, mas pertencem à doutrina de código, e um gate automático já os cobra sem consumir atenção humana.
- **Escolhas de stack.** Contingentes por definição. Doutrina que fixa framework morre com o framework.

O teste para admitir um invariante novo: **é possível escrever a verificação?** e **a violação é um defeito, não uma preferência?** Se as duas respostas não forem sim, ele vai para a doutrina de código, não para cá.

---

# Aplicação de referência — SonghaiCRM

**Onde a lei é cobrada:**

| Camada | Artefato | Garante |
|---|---|---|
| Mentalidade | Skill `sistema-vivo` | Injeta o checklist em toda feature |
| Gate de sessão | Item "Living System Checklist" no DoD (`CLAUDE.md`) | Nenhuma task fecha sem responder |
| Mapa vivo | `docs/architecture/` + `graphify-out/` | Peça nova aparece com ≥2 arestas |
| CI (mecânico) | `tests/unit/navegacao-completude.test.ts` | Tela sem porta reprova o build |

**Estado por invariante:**

| # | Invariante | Estado |
|---|---|---|
| 1 | Nada é ilha | Vigiado por hábito + mapa |
| 2 | Continuidade nas duas direções | Vivo — resumo de handoff contextual vai ao inbox humano |
| 3 | Log universal e visível | Vivo — `event_log`, `api_audit_log`, `crm_lead_activities` renderizada no inbox |
| 4 | Nenhuma demanda sem próximo passo | Vivo — motor de follow-up + Radar de Risco |
| 5 | Informação com propósito | Vigiado por hábito |
| 6 | Configuração tem superfície | Vivo, com gate mecânico de navegação |
| 7 | **Todo laço se fecha** | **Parcial** — o flywheel existe e fecha o laço do agente; as demais classes de decisão ainda não declaram retorno |

O invariante 7 entra como **dívida declarada**, não como propriedade em vigor. Declarar é o que impede que ele seja assumido como verdadeiro em revisão futura — e é exatamente o que o próprio invariante 5 exige de qualquer estado do sistema.
