# 8. Aplicação

> Como isto vira decisão de código, e não um documento que todo mundo elogia e ninguém usa.

---

# Princípio

## 8.1 O checklist

Responda **antes** de declarar uma peça pronta. Cada pergunta é a forma interrogativa de um invariante.

```
Living System Checklist — <nome da peça>

[ ] 1. Quem me alimenta?          → aresta de entrada; fonte real, confiável
[ ] 2. Quem eu alimento?          → aresta de saída; "ninguém" = ilha
[ ] 3. Que registro eu emito?     → atividade/auditoria/evento
[ ] 4. Onde eu apareço na tela?   → registro só no banco é registro morto
[ ] 5. Por qual porta se chega?   → ter tela ≠ ser alcançável
[ ] 6. Qual meu anti-morte?       → próximo passo garantido, ou justificativa
[ ] 7. Onde se configura?         → ver + mudar + o que aparece se faltar
[ ] 8. Qual a continuidade?       → automação↔humano, nas duas direções
[ ] 9. Qual meu laço de retorno?  → o que muda no sistema quando eu erro
[ ] 10. Atualizei o mapa?         → peça nova entra com ≥2 arestas
```

**Como responder mal (e é o padrão):** responder o que a peça *poderia* fazer. A resposta válida nomeia o artefato concreto — o consumidor real, a tela real, o registro real. "Vai aparecer no painel" não é resposta; "aparece na linha do tempo do lead, renderizada pelo componente X" é.

**Quando "nenhum" é aceitável:** para as perguntas 6 e 9, com justificativa escrita. Uma peça de leitura pura não tem anti-morte, e está tudo bem — o que não pode é a ausência passar sem ser notada. **Dívida declarada não é defeito; dívida presumida é.**

## 8.2 Receita — implementar uma peça nova

**1. Localize antes de criar.** Antes da primeira linha, descubra de quem a peça recebe e quem ela deve alimentar. Metade das ilhas nasce de desconhecimento do que já existe, não de descuido.

**2. Escreva as duas arestas primeiro.** Entrada e saída antes da lógica interna. Se você não consegue nomear as duas, a peça ainda não tem lugar no sistema — e implementá-la agora só adia a descoberta.

**3. Declare o registro no mesmo commit da mutação.** Registro adicionado depois nunca é adicionado. É o item que mais some entre a intenção e o merge.

**4. Leve a peça até a tela.** Uma peça que funciona e não aparece falha sem culpado — pior do que não existir, porque consome confiança.

**5. Dê a porta.** Registre o destino na navegação. Alcançável só por URL é alcançável por ninguém.

**6. Nomeie o laço.** O que muda no sistema quando essa peça acerta? E quando erra? Se a resposta é "nada", ela é uma esteira, e você acabou de criar trabalho que não se corrige sozinho.

**7. Atualize o mapa.** Arquitetura que mudou sem o mapa refletir é uma ilha de informação — o próprio invariante 3, aplicado à documentação.

## 8.3 Receita — desilhar uma peça existente

Quando você encontra uma ilha (e vai encontrar):

1. **Meça antes de opinar.** Quem chama? Quem lê? Verificação por ferramenta, não por memória. A resposta costuma surpreender nas duas direções.
2. **Encontre o consumidor natural.** Quase sempre já existe alguém que deveria estar lendo aquilo e não sabe que existe.
3. **Prefira uma aresta real a duas decorativas.** Uma conexão que muda comportamento vale mais que duas que só existem no diagrama.
4. **Se não há consumidor, o caminho é remover.** Peça viva sem consumidor é dívida com aparência de recurso. Remover é uma resposta legítima e frequentemente a certa.

## 8.4 Gate mecânico ou gate de hábito

A decisão mais importante para a doutrina sobreviver — e ela tem um critério único:

> **A propriedade é enumerável a partir do repositório?**

| | Gate mecânico (teste no CI) | Gate de hábito (checklist, revisão) |
|---|---|---|
| **Quando** | A propriedade é derivável por varredura | A propriedade exige julgamento |
| **Exemplos** | Toda tela tem porta · todo destino aponta para rota existente · a ordem da cadeia crítica não mudou | Essa peça faz sentido? · esse dado muda alguma decisão? · o resumo é útil para o humano? |
| **Força** | Não cansa, não tem opinião, não esquece | Alcança o que nenhuma varredura alcança |
| **Fraqueza** | Só vê o que é enumerável | Erra por cansaço, pressa e excesso de confiança |

**Onde a propriedade é enumerável, o teste vence o hábito — sempre.** Não é questão de disciplina: é que a varredura por arquivo não tem opinião e não se convence do contrário.

E vale registrar o padrão observado na prática: quando um gate mecânico é ligado num sistema que já rodava sob gate de hábito, ele costuma encontrar violações que revisões manuais repetidas não encontraram. A revisão manual concorda com a expectativa de quem revisa; a varredura, não.

**Como ligar um gate que nasceria vermelho:** congele a dívida existente numa lista de exceções — cada uma com justificativa escrita — e faça o gate reprovar apenas o que é novo. Um gate que nasce vermelho é desligado na primeira sexta-feira. E o gate viaja no mesmo commit da correção que o torna verde.

## 8.5 Anti-padrões

Sinais de que a peça está morta ou vai morrer:

| Sinal | O que significa |
|---|---|
| "É só um CRUD de X" | Provável ilha. X vivo tem métrica, registro, destino de escalada e linha do tempo |
| Mutação sem registro emitido | Invariante 3. Registre ou justifique |
| Dado na tela que não muda decisão | Invariante 5. Ruído compete com o que importava |
| Demanda aberta sem próximo passo | Invariante 4. Algo vai morrer sem ninguém ver |
| Peça nova ausente do diagrama | Mapa desatualizado é ilha de informação |
| Escalada que entrega o registro cru | Invariante 2. Transferiu o custo, não o contexto |
| Configuração só alterável no banco | Invariante 6. O mecanismo não é operável |
| Decisão automática sem sinal de retorno | Invariante 7. Uma esteira, não um sistema |
| "Vamos medir depois" | Nunca. A instrumentação some entre a intenção e o merge |

## 8.6 Adotar isto num sistema novo

Ordem mínima. Do 1 ao 5 é meio dia, e é o que separa ter doutrina de a doutrina estar valendo.

**1. Declare o propósito em estado terminal.** Não em atividade (capítulo 3.2). Nada mais funciona sem isto — o índice não tem alvo e as métricas ganham por serem fáceis de coletar.

**2. Escolha a unidade de demanda.** O que é uma "coisa a ser resolvida" no seu domínio (capítulo 5). Ela será o denominador de tudo.

**3. Nomeie a fronteira de autoridade.** Quem executa, quem julga, quem governa (capítulo 4). Escreva o que a automação **nunca** decide sozinha.

**4. Ligue um gate mecânico.** Um só — o mais barato que reprove de verdade. Doutrina sem gate é intenção.

**5. Escreva o par eficiência/dano.** Para cada métrica que já existe, a contra-métrica que denuncia seu custo (capítulo 3.3). É a intervenção mais barata do manual.

Depois disso, o checklist de 8.1 em toda peça nova.

## 8.7 O modo de falhar da própria doutrina

Doutrina morre de três jeitos, e vale reconhecê-los cedo:

**Inflação.** A lista de invariantes cresce até ninguém conseguir responder a todos, e aí ninguém responde a nenhum. Defesa: o teste de admissão do capítulo 2 — dá para verificar? a violação é defeito? Se não, vai para a doutrina de código.

**Divergência.** O texto diz uma coisa, o sistema faz outra, e ambos seguem em frente. Isso é pior que doutrina ausente: produz decisão errada com confiança, tomada por quem leu o texto como lei. Defesa: quando o comportamento correto diverge do texto, **corrija o texto na mesma sessão**.

**Cerimônia.** O checklist é respondido no automático, com respostas que não nomeiam nada. Defesa: exigir artefato concreto em cada resposta, e tratar "nenhum" como resposta legítima quando justificada — porque é a permissão de dizer "nenhum" que impede a invenção de respostas bonitas.

---

# Aplicação de referência — SonghaiCRM

**Onde o checklist é cobrado:** item "Living System Checklist" do Definition of Done (`CLAUDE.md`) e a skill `sistema-vivo` (`.claude/skills/sistema-vivo/SKILL.md`), que o injeta em toda sessão de implementação.

**Gates mecânicos ligados:**

| Gate | Propriedade enumerável que ele guarda |
|---|---|
| Completude de navegação | Toda tela tem porta; todo destino aponta para rota existente |
| Forma da cadeia de envio | Ordem, tamanho, versão e unicidade dos gates críticos |
| Isolamento entre organizações | Nenhum vazamento de dado entre inquilinos |

**Ferramentas de orientação antes de implementar:** o grafo determinístico do repositório (`graphify-out/`) para descobrir de quem a peça recebe e quem ela deve alimentar; os diagramas curados (`docs/architecture/`) como mapa vivo, cuja fonte da verdade são os arquivos de dados, não as imagens.

**Doutrinas irmãs que não são substituídas por esta:** a de schema e migrações (`CLAUDE.md`), a de restrição de canal (`../restricao-de-canal.md`) e a de separação entre fala e operação (`../separacao-fala-e-operacao.md`). Este manual trata de **conectividade e vida**; as outras tratam de correção em eixos específicos. Rode os dois.
