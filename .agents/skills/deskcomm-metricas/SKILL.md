---
name: deskcomm-metricas
description: Guia de análise das métricas de uma instalação do DeskcommCRM como um analista de dados experiente — conversão, funil, tempo de resposta, handoff, follow-ups, custo de IA, motivos de perda, horários de pico — lendo o banco por consultas agregadas sem dado pessoal. Use SEMPRE que alguém perguntar "como está o desempenho", "o agente está vendendo?", "por que a conversão caiu", "quanto estou gastando com IA", "onde o funil trava", "quantos atendimentos", "que horas os clientes mais falam", pedir relatório, dashboard ou análise estratégica das conversas, ou quiser saber se vale otimizar o prompt. Declara a régua de cada número, o fuso e o que não foi medido.
metadata:
  publico: dono do negócio, agência, operador
  leitura: SQL agregado via SUPABASE_DB_URL (pooler), nunca texto de mensagem
---

# Analisar as métricas de uma instalação

O produto mostra números em várias telas — Desempenho, Radar de risco, Uso e orçamento, Evolução
da IA, Execuções, Atividades — e cada uma usa a própria régua: "handoff" tem **três definições**
diferentes em três telas; "ganho" é `crm_leads` numa e a transição do agente noutra; um dia é UTC
numa tela e o fuso da organização em outra. Um analista que soma números de telas diferentes
chega a conclusões erradas com cara de precisas. Este guia lê a fonte (o banco), declara a régua
ao lado de cada número e transforma medida em decisão.

## Como você age

- **Pergunta de negócio primeiro, consulta depois.** "A conversão caiu?" vira: qual funil, qual
  período, comparado a quê, medido por qual definição. Sem isso, o número não responde nada.
- **Agregados, nunca o texto.** Você lê contagens, medianas, taxas e enums. Nunca o corpo de
  mensagem, nome, telefone, notas do agente, motivo de perda em texto livre sem tratar. A
  instalação é de terceiros e a LGPD é nativa: o que sai do banco para o modelo é só o que a
  anonimização preserva (ids, datas, estados, valores). `references/acesso-e-lgpd.md`.
- **Régua ao lado do número.** Todo número vem com: período fechado `[de, até)`, fuso, definição
  (qual tabela, qual filtro), e o que ficou de fora (grupos, arquivados, custo sem preço).
- **`null` não é zero.** "Sem dado" e "zero" são respostas diferentes; o produto trata assim e
  você também.
- **Compare com uma referência.** Período anterior, outro agente, outro funil, ou a meta que a
  pessoa disse. Número solto não é análise.
- **Termine em ação.** Cada achado vira uma hipótese e um próximo passo: ajustar prompt (guia
  `deskcomm-prompt`), follow-up, horário do agente, base de conhecimento, equipe, ou "coletar
  mais 2 semanas".

## Passo 0 — onde está o dado e como chegar nele

Não há banco na VPS: o Postgres é o Supabase, alcançado pela connection string `SUPABASE_DB_URL`
do `.env` da instalação (Session pooler). Não existe papel de banco só-leitura no produto — a
string do app enxerga **todas** as organizações da instalação, então toda consulta filtra
`organization_id`. Como obter, o que pedir à pessoa, o que fazer com uma instalação de várias
organizações e a alternativa por MCP: `references/acesso-e-lgpd.md`.

## Passo 1 — a triagem do pedido

Uma pergunta por vez: qual organização (nome → id); período (padrão: últimos 30 dias fechados,
comparados aos 30 anteriores); o que está incomodando (vender menos, demorar, gastar, perder);
qual funil e quais agentes existem (você descobre no banco e confirma). Anote a régua escolhida
antes de rodar qualquer coisa.

## Passo 2 — o panorama (sempre, antes de aprofundar)

Rode o bloco "panorama" de `references/consultas.md`: volume de mensagens recebidas por semana e
por origem de resposta (IA, pessoa, celular), funil por origem com taxa de ganho sobre fechados e
dias até ganhar, estagnação por etapa, handoffs (somando os dois runtimes), custo de IA por
propósito com o furo de preço declarado, follow-ups por desfecho, conversas esperando resposta
agora. Apresente em uma tabela por bloco, com a régua embaixo.

## Passo 3 — aprofunde onde dói

| sintoma | consultas | o que costuma explicar |
|---|---|---|
| "vende menos" | funil por origem; motivos de perda; estagnação por etapa; fluxo entre etapas por ator | etapa gargalo; motivo de perda concentrado (preço, sumiu); origem que caiu |
| "demora / cliente reclama" | 1ª resposta por hora do dia (IA × humano); conversas esperando agora; horários de pico × janela do agente | agente fora da janela nos horários de pico; humano assume e demora |
| "o agente passa tudo para pessoa" | handoffs por agente; vetos por portão; casos por desfecho | prompt manda encaminhar demais; portão de promessa/vocabulário vetando |
| "gasta muito com IA" | custo por propósito/modelo; custo por contato qualificado e por ganho; chamadas sem preço | classificadores em modelo caro; turno com prompt gigante; custo desconhecido em modelo fora da tabela de preços |
| "follow-up não funciona" | desfecho por fluxo/versão; promessas de retorno com resposta em 48 h | esperas longas demais; mensagem genérica; muitos `esgotado` |
| "a base não responde" | consultas ao conhecimento: acertos, quase-acertos, limiar | material não cobre; limiar apertado |

Cada achado: o número, a régua, a comparação, a hipótese, o próximo passo. As armadilhas que
distorcem cada leitura — fuso, `sent_at` × `created_at`, grupos, anonimizados, tetos de linhas,
três definições de handoff — estão em `references/regua-e-armadilhas.md`. Leia antes de afirmar.

## Passo 4 — o relatório

```markdown
# {Organização} — {período} (fuso {tz}) · comparado a {período anterior}
## Em uma frase
## O que está bem (3 números, com régua)
## O que está travando (achado → hipótese → próximo passo)
## Custo de IA (total, por propósito, o que ficou sem preço)
## O que NÃO medi e por quê
```

Grave o relatório onde a pessoa pedir (`relatorio-<org>-<data>.md`). Números na tabela, prosa
curta. Se o próximo passo é otimizar o prompt, passe o bastão ao guia `deskcomm-prompt` com os
achados — ele precisa deles para não otimizar no escuro.

## O que você nunca faz

- Não lê `messages.body`, `lead_checkpoints`, notas, `crm_leads.title`, telefone, nome — nem "só
  para entender". Se a análise exige ler conversas, é o guia de prompt, com amostra mínima e
  consentimento da pessoa.
- Não roda `SELECT *` em tabela com dado pessoal; não copia linhas para arquivo fora da instalação.
- Não escreve no banco. Nunca.
- Não compara número de tela com número de consulta sem declarar que as réguas diferem.
- Não afirma tendência com uma semana de dado: diz que é cedo e quando voltar a medir.
