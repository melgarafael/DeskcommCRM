# Runbook — as três avaliações que seguram escolhas das frentes de tokens (C, F5, G)

Três mudanças das frentes de tokens já estão no código e **desligadas**. Cada uma
só vira padrão depois de uma avaliação paga. Este runbook diz o que cada
avaliação decide, contra o quê compara, quando aprova, com que corpus, como roda
e quanto custa — antes de gastar um centavo.

| Id | Knob / escolha | O que decide | Ganho se aprovar |
|---|---|---|---|
| **C** | `LLM_TOOL_SCHEMA_SEM_PADRAO=on` | Tirar do esquema das ferramentas o `pattern` que só repete o `format` (uuid, data, e-mail). O modelo continua chamando com argumentos válidos? | −4.014 tok/passo na Nina (−36% das ferramentas) |
| **F5** | `LEAD_CONTEXT_HISTORY_FORMAT=linhas` | Histórico do lead em linhas em vez de JSON. Preserva quem disse o quê, o horário e o remetente de grupo? | ~−375 tok por leitura do histórico |
| **G** | binding do ponto `checkpoint` no modelo econômico | O fechamento do turno no econômico perde mais que o próprio modelo do agente perde de uma execução para a outra? | ~−1,6¢/turno no Sonnet 5 (~−9,5% do gasto total) |

O roteiro é `scripts/avaliar-tokens.ts` (C e F5, e o plano/relatório do G) e
`scripts/avaliar-fechamento.ts` (a execução do G). A parte que decide é pura e
testada sem rede: `scripts/lib/avaliacao-de-tokens.ts` (régua e veredito),
`scripts/lib/corpus-de-avaliacao.ts` (o corpus), `scripts/lib/pedidos-de-avaliacao.ts`
(o pedido de cada conversa, montado pelas funções de produção) e os testes
`tests/unit/avaliacao-de-tokens.test.ts` e `tests/unit/corpus-de-avaliacao.test.ts`.

**Nada aqui foi rodado com rede.** O plano (contagem e custo) roda sem banco e sem
provedor; `executar`, `julgar` e `scripts/avaliar-fechamento.ts` **gastam** e
exigem `--teto-usd` / `TETO_USD`: param, e gravam o que mediram, quando o gasto
chega ao teto.

## C — o esquema sem o `pattern` repetido

- **Braços:** `off` (o esquema de hoje, sem `$schema`) e `on` (sem `pattern` onde há `format`). K = 3 execuções de cada conversa por braço — o desenho.
- **Métricas, por chamada de ferramenta**, gravadas no seam do provedor (é ali que se vê a chamada ANTES da validação do AI SDK, que descarta a entrada inválida sem passar pelo `execute` — por isso o traço do turno nunca a viu): inválidas por 100 chamadas (a régua é o **zod da ferramenta**, o mesmo do servidor, nunca o JSON Schema do fio), inválidas por formato por 100 chamadas com campo de formato, ferramenta inexistente por 100, uuid de aterro por 100; por turno: passos, vetos, e a sequência de ferramentas.
- **Critério (desenho):** passa se nenhum indicador sair da banda off×off. **A operacionalização é PROPOSTA:** banda = [mín, máx] dos 3 `k` do `off`; reprova quando a média dos `k` do `on` passa do máximo (inválidas, inexistentes, aterro, passos, vetos) ou quando a concordância de sequência off×on fica abaixo da menor concordância off×off. Abaixo de **100 chamadas com campo de formato por braço** (PROPOSTA) é INCONCLUSIVO.
- **Prova do braço:** toda execução confere o fio — `off` tem de mandar algum nó com `pattern` e `format`, `on` nenhum. Se não bate, o lote para (`provaDoBraco`).
- **Corpus (30, `CORPUS_C`):** clínica (agenda), imobiliária (visita + funil), loja (funil) e curso. O id do contato copiado do contexto (`contact_id`, `lead_id`), o instante ISO com fuso (`starts_at`, `de`/`ate`), o e-mail que o cliente digita — inclusive em maiúsculas (C07) e sem domínio completo (C09) —, a data em palavras ("depois de amanhã às 8 e meia", "semana que vem, terça"), duas reservas no mesmo turno (C10, C18), participante extra (C03, C20).

## F5 — o histórico em linhas

- **Braços:** `json`, `linhas` e `json_b` (o A/A, **PROPOSTA** — o desenho não tem; sem ele, os ≥95% de sequência igual não têm régua de ruído: o relatório imprime a concordância A/A ao lado, e o veredito segue o desenho). K = 1.
- **Critério (desenho):** sequência de ferramentas igual em ≥95% dos pares json×linhas; taxa de turnos com veto não maior no `linhas`; juiz par a par não-inferior; as sondas sem regressão. **PROPOSTA:** o δ do juiz é 0,10 (limite inferior de 95% de (vitórias linhas − vitórias json)/n ≥ −0,10); "sem regressão" = falhas do `linhas` ≤ falhas do `json` em cada tipo de sonda; mínimo de 60 pares e 60 votos válidos.
- **O juiz** é o próprio modelo do lote, direto no provedor (`julgar`), com a ordem A/B sorteada por conversa e uma transcrição neutra (nenhum dos dois formatos).
- **Corpus (64, `CORPUS_F5`):** as 30 do C (histórico comum, com foto e PDF descritos no histórico — a IA vê o que o cliente manda) + 30 sondas, dez de cada tipo, + 4 controles de quem disse o quê (`SONDAS_DE_CONTROLE`). Cada sonda leva o que a resposta tem de conter e o que não pode conter: quem disse o quê (o endereço do cliente × o da loja), horário relativo ao carimbo (cupom de 24 h dado ontem às 16h × anteontem às 9h; "amanhã às 15h" dito ontem) e remetente de grupo. O teste prova que cada sonda aceita a resposta certa e recusa a errada. Que todo campo vindo de fora (o texto e o nome do participante) vai escapado e nunca abre uma linha a mais no histórico é propriedade do formatador, provada em `tests/unit/historico-em-linhas.test.ts`, e não depende do modelo.
- **Diferença declarada do desenho:** o desenho pedia N ≥ 60 turnos **reais** com a PII na VPS. Aqui o corpus é inventado (aprovado pelo dono), então não há PII — e também não há a distribuição real de conversas.

## G — o fechamento no modelo econômico

- **Braços (por conversa):** `atual` (modelo do agente), `controle` (o modelo do agente de novo, A/A) e `sombra` (o econômico do mesmo provedor: `claude-haiku-5-5` para os Claude, `gpt-6-luna` para os GPT). Cada braço é medido contra o atual pela régua pura de `comparar-fechamentos.ts`.
- **Critério (desenho, δ PROPOSTOS lá e à espera do dono):** limite inferior de 95% do Δ(sombra − controle) ≥ −0,03 em promessas, ≥ −0,05 em prazos, ≥ −0,05 em intenções, ≥ −0,02 em retenção de entidades; `recusado` da sombra ≤ 3%. Mínimos: ≥150 promessas, ≥50 prazos, ≥150 intenções, ≥100 turnos com resumo anterior, ≥300 turnos.
- **O que o offline NÃO mede** (sem juiz LLM): fatos perdidos, contradições, intenções divergentes, próxima ação e `nada_a_declarar`. O veredito diz isso em toda saída.
- **Corpus (160, `CORPUS_G`):** as 30 do C e as 30 sondas do F5, com a resposta que o agente deu, + 100 de fechamento (20 roteiros × 5 clientes): promessa com e sem prazo, "vou verificar e te aviso", pedido de humano, objeção de preço, remarcar × cancelar, espanhol, e-mail, CPF (o de teste) e endereço, retorno agendado, duas promessas no mesmo turno, desistência. Resumo anterior em 83 delas. O plano roda o corpus **2 vezes** (K = 2) para chegar aos 300 turnos do desenho.
- **O pedido não é o de produção inteiro, declarado:** a abertura sai da `buildOpeningMessage` de produção (com o `## Agora`), mas o `system` é só o prompt do agente — os blocos do motor só existem montados pelo turno, com banco — e a fita do turno vai em texto (o corpus do roteiro é de strings). O pedido fica com ~1,2 mil tokens contra os 9,8 mil medidos em produção; um modelo econômico que se perde em contexto longo passa aqui e pode falhar lá. A virada do binding (passo 3 do desenho, 14 dias na própria org) é que cobre isso.
- **Pseudo-réplica, declarada:** os 100 de fechamento variam negócio, nome, valor e prazo, e o texto de cada roteiro é o mesmo; K = 2 repete a conversa. O intervalo de confiança sai **otimista**. Um veredito na beira do critério não é veredito.

## Ambiente

O mesmo da doutrina de QA visual (e da avaliação da parada): Supabase local com o
`supabase/baseline.sql` e o `scripts/bootstrap-owner.ts`. Para C e F5 o turno roda
**dentro do processo do roteiro**, pelo motor de produção em modo prévia
(`runAgentPreview` — o caminho do botão "Testar"): mesma montagem do `system`,
mesmo prefixo de ferramentas, mesma abertura, mesmas travas, nenhum envio. Não
precisa de worker nem de WAHA; precisa do banco local e da tela, para o preparo.
O roteiro **recusa** banco que não seja local.

Preparo, pela tela:

1. Credenciais da OpenAI e da Anthropic cadastradas na organização (o roteiro usa a mais recente ativa do provedor do lote).
2. Quatro agentes de avaliação, um por negócio do corpus, com o prompt de `PERSONAS` (`scripts/lib/corpus-de-avaliacao.ts`) e **exatamente** as capacidades listadas ali — o roteiro confere e recusa agente que não as tem. Retorno (callback) e passagem ligados.
3. Agenda: tipos de atendimento e jornada para a clínica (avaliação, limpeza, clareamento, manutenção) e para a imobiliária (visita), com horários livres entre 04/11 e 30/11/2026. Sem isso `crm_find_free_slots` volta vazio e o C perde a maior parte das chamadas com data.
4. O funil padrão do bootstrap serve para loja, imobiliária e curso.

O modelo de cada lote entra por `--modelo provedor:modelo` no lugar do da versão
publicada; o resto da versão (prompt, capacidades) fica como está. O relógio do
turno é fixo em quarta, 04/11/2026, 10:00 de São Paulo (`AGORA`) — as sondas de
horário só têm resposta certa com ele.

Os preços: `curl -s https://openrouter.ai/api/v1/models > /tmp/precos.json` (sem chave).

## Roteiro

Sempre com `pnpm exec tsx --env-file=.env.local scripts/avaliar-tokens.ts …`.

1. **Plano** (sem rede): `plano --avaliacao C --precos /tmp/precos.json` (idem F5 e G). Imprime, por modelo e braço, execuções, chamadas, tokens e o custo com o cache dos Claude ligado e desligado.
2. **Piloto** (centavos): `executar --avaliacao C --braco off --modelo anthropic:claude-sonnet-5 --agentes clinica=<id>,loja=<id>,imobiliaria=<id>,curso=<id> --k 1 --conversas C02,C13,C21 --saida /tmp/piloto.jsonl --precos /tmp/precos.json --teto-usd 1`, e `relatorio --avaliacao C --entrada /tmp/piloto.jsonl`. O relatório imprime o **gasto medido por execução**: multiplique pelo número de execuções do plano antes de autorizar o lote — ele substitui as constantes do plano pela medida.
3. **Lote** C: os dois braços × os 4 modelos, `--k 3`, um arquivo por modelo. **Lote** F5: os três braços × os 4 modelos, `--k 1`; depois `julgar --entrada f5-<modelo>.jsonl --saida juizo-<modelo>.jsonl --precos /tmp/precos.json --teto-usd <teto>` (chave em `<PROVEDOR>_API_KEY`).
4. **G:** `corpus-g --saida /tmp/corpus-g.json`, depois, por modelo e duas vezes (K = 2): `CORPUS=/tmp/corpus-g.json SAIDA=/tmp/g-<modelo>-<k>.json PROVEDOR=anthropic MODELO_AGENTE=claude-sonnet-5 MODELO_ECONOMICO=claude-haiku-5-5 PRECOS=/tmp/precos.json TETO_USD=<teto> ANTHROPIC_API_KEY=… pnpm exec tsx scripts/avaliar-fechamento.ts`.
5. **Relatório:** `relatorio --avaliacao C --entrada c-a.jsonl,c-b.jsonl`; `relatorio --avaliacao F5 --entrada f5.jsonl --juizo juizo.jsonl`; `relatorio --avaliacao G --entrada g-1.json,g-2.json`. Veredito por modelo: APROVA, REPROVA ou INCONCLUSIVO, com os motivos.

Um knob só vira padrão quando **todos** os modelos em uso nos agentes da
instalação aprovam (o knob é global, não há recorte por modelo). A virada é PR
próprio, com fragmento em `.changes/`, por decisão do dono.

## Custo e tempo

Saída de `plano` em 01/11/2026, com os preços da OpenRouter do mesmo dia (GET
`/api/v1/models`, sem chave): luna US$ 0,20/1,20 por M (entrada/saída), terra
2,00/12,00, Sonnet 4.6 3,00/15,00, Sonnet 5 2,00/10,00; leitura de cache a 10% da
entrada; gravação de 1 hora a 2× (Claude). Econômicos do G: gpt-6-luna e
claude-haiku-5.5, ambos 0,10/0,50. **Rode o plano de novo no dia: os números mudam
com o preço e com o corpus.**

| Avaliação | Modelo | Execuções | US$ cache ligado | US$ cache desligado | Horas |
|---|---|---|---|---|---|
| C (30 × K3 × 2 braços) | gpt-5.6-luna | 180 | 0,49 | 0,49 | 1,4 |
| | gpt-5.6-terra | 180 | 4,91 | 4,91 | 1,4 |
| | claude-sonnet-4-6 | 180 | 9,11 | 25,09 | 1,4 |
| | claude-sonnet-5 | 180 | 6,08 | 16,73 | 1,4 |
| | **subtotal C** | **720** | **20,60** | **47,22** | **5,6** |
| F5 (60 × 3 braços + juiz) | gpt-5.6-luna | 180 + 60 | 0,51 | 0,51 | 1,6 |
| | gpt-5.6-terra | 180 + 60 | 5,16 | 5,16 | 1,6 |
| | claude-sonnet-4-6 | 180 + 60 | 9,84 | 25,86 | 1,6 |
| | claude-sonnet-5 | 180 + 60 | 6,55 | 17,23 | 1,6 |
| | **subtotal F5** | **720 + 240** | **22,06** | **48,76** | **6,0** |
| G (160 × K2 × 3 braços) | gpt-5.6-luna (sombra gpt-6-luna) | 960 + 5% | 0,54 | 0,54 | 4,3 |
| | gpt-5.6-terra (sombra gpt-6-luna) | 960 + 5% | 4,44 | 4,44 | 4,3 |
| | claude-sonnet-4-6 (sombra haiku-5.5) | 960 + 5% | 6,72 | 6,72 | 4,3 |
| | claude-sonnet-5 (sombra haiku-5.5) | 960 + 5% | 4,52 | 4,52 | 4,3 |
| | **subtotal G** | | **16,22** | **16,22** | **17,4** |
| **Total** | | | **US$ 58,88** | **US$ 112,20** | **29 h** |

- O braço `json_b` (A/A do F5, proposta) custa US$ 7,31 com cache e US$ 16,21 sem; sem ele o F5 sai US$ 14,75 / 32,55.
- As horas são em série, uma execução por vez. Um processo por modelo em paralelo (os lotes não dividem estado) leva o total para ~7,5 h.
- O G não tem coluna de cache porque não usa cache (ver abaixo). Ele também é o mais barato por chamada: o pedido do corpus tem ~1,2 mil tokens contra os 9,8 mil do fechamento de produção, porque o `system` do corpus é só o prompt do agente — sem os blocos do motor. A saída (363 por chamada) é que pesa.
- Teto sugerido para a autorização: **US$ 70 com o cache dos Claude ligado, US$ 130 desligado** (o total + ~20% para correção, nova tentativa e o que as constantes erram). O roteiro para no teto de cada lote.

## O que as contas assumem

O que o plano **conta** com o200k, sobre o pedido de produção: o peso das
ferramentas de cada agente em cada braço (`esquemaParaOProvedor`, a mesma régua da
cerca de peso), o prompt de cada agente, a abertura de cada conversa em cada
formato (`buildOpeningMessage` + `## Agora`), o pedido inteiro de cada fechamento
do G e o prompt do juiz.

O que ele **toma da medição de produção** (fonte em `MEDIDO`,
`scripts/lib/avaliacao-de-tokens.ts`): o `system` do motor (derivado do passo da
Nina, contando o prompt dela por cima do de cada agente — erra para cima), 2
passos por turno, 130 tokens de saída por passo, 363 por fechamento, um
promise_semantic de 3.143 tokens por turno, o fator 28,7/21,6 do tokenizador dos
Claude, 28 s por turno da prévia e 16 s por fechamento. O piloto (passo 2) troca
essas constantes pelo que o lote realmente gasta.

Cache: os GPT têm cache automático (não desliga), então "ligado" e "desligado" só
diferem nos Claude. Com cache, o 1º pedido de cada prefixo (ferramentas + system
de cada agente; system do fechamento) grava pelo preço de 1 hora, os seguintes
leem — o lote roda em sequência, mais rápido que o TTL. O G não usa cache: o
roteiro não o marca, e o `system` de cada agente fica abaixo do mínimo cacheável.
