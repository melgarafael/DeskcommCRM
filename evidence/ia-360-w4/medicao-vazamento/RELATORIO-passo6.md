# O passo 6 levou os 30% a zero? **Não — mas levou a 10%.**

> Medido em 2026-08-06, worktree `SonghaiCRM-tres-papeis`, SHA `d0ef5ec2` (árvore limpa).
> Modelo `gpt-5.6-terra`, chave OpenAI real, **ferramentas EXECUTADAS** contra o Supabase local.
> Coletor: `tests/e2e/qa-agente-usa-as-maos.spec.ts` (o mesmo da linha de base) · contagem:
> [`medir.ts`](./medir.ts) · turnos crus em [`turnos/`](./turnos/).

---

## A resposta, em uma tabela

| configuração | ferramentas | vazou | taxa |
|---|---|---:|---:|
| **A · CONTROLE** — todas as capacidades | 21 | 3/10 | **30,0%** |
| **C · sem as de OPERAÇÃO** | 14 | 1/10 | **10,0%** |

**Zero respostas vazias nas duas corridas** — as ferramentas rodaram de verdade, contra dados reais.

### O controle CALIBRA

A configuração A reproduziu **30,0%**, com os **mesmos três cenários** da linha de base
(`3-diagnostico-de-entrada`, `7-automacoes-e-falhas`, `9-quem-pode-mexer`). O instrumento mede o
que a linha de base mediu — e é isso que torna a linha C comparável.

---

## O que caiu, e o que sobrou

Tirar as sete ferramentas de operação eliminou **dois dos três** vazamentos — exatamente os que
vinham do **DADO retornado** (porta 3):

| turno | o que vazava | com C |
|---|---|---|
| `7-automacoes-e-falhas` | `unsafe_url:https_required` (dado da ferramenta) | **sumiu** |
| `9-quem-pode-mexer` | `admin`, `manager`, UUIDs (dado da ferramenta) | **sumiu** |
| `3-diagnostico-de-entrada` | `webhook` | **permanece** |

**O resíduo é o achado.** Sem nenhuma ferramenta de webhook no contexto, o modelo **ainda disse
`webhook`** — o termo veio dele, não do que lhe foi mostrado. A frase da doutrina, *"só se fecha não
mostrando"*, fecha as portas 1, 2 e 3. **Não fecha o modelo.**

---

## ✅ APLICADO — e re-medido com o código no caminho

A recomendação abaixo foi implementada (`catalogoEntregueAoOperador`) e a coleta foi refeita com o
spec **perguntando ao código** quais capacidades sobram, em vez de repetir a lista à mão:

| configuração | vazou | taxa |
|---|---:|---:|
| A · CONTROLE | 3/10 | **30,0%** |
| C · **código aplicado** | 1/10 | **10,0%** |

Zero respostas vazias nas duas. O contexto que o modelo recebeu na linha C é o que
`catalogoEntregueAoOperador` produz em produção — não uma cópia paralela que poderia divergir sem
nada vermelhar. Há um teste travando isso: se a lista mudar sem nova medição, ele reprova.

**Sobra `crm_list_pipelines`, `crm_list_stages`, `crm_list_tags`** — contexto de conversa, que o
Conversador precisa para saber onde a pessoa está no funil.

---

## O que isso significa para o passo 6 como está implementado

O passo 6 entrega ao Operador as ferramentas **nativas** com equivalente (`update_lead_state`,
`schedule_followup`). **Nenhum dos três vazamentos veio delas** — os três vieram de `crm_list_*`.

Logo: **o passo 6, como entregue, não move a taxa.** O que move é a configuração C — entregar ao
Operador também as ferramentas de OPERAÇÃO do catálogo (`crm_list_webhook_sources`,
`crm_list_automation_*`, `crm_list_team_members`, `crm_list_message_templates`).

**Recomendação medida:** estender `EQUIVALENTE_NO_OPERADOR` para cobrir essas sete. Elas não servem
para responder pergunta de paciente — servem para o dono cuidar da casa, que é a definição do papel
Operador. As de contexto de conversa (`crm_list_pipelines`, `stages`, `tags`) ficam.

Isso levaria a taxa de **30% → 10%** pelo mecanismo do passo 6, e o gate continuaria cobrindo o
resíduo de 10% que vem do próprio modelo.

---

## O que NÃO foi medido (declarado, não estimado)

1. **A configuração C rodando pelo caminho do worker.** A coleta usa `/versions/[vid]/test`, que é
   onde a linha de base foi feita — mas não é onde o passo 6 atua. A equivalência é de CONTEXTO
   (mesmas ferramentas no prompt), não de código.
2. **O prompt de ATENDIMENTO nesta rodada.** Os 0% dessa coluna são da linha de base, não
   re-coletados aqui.
3. **Outros modelos.** Tudo em `gpt-5.6-terra`.
4. **n = 10 por configuração.** Um turno move a taxa em 10 pontos. Serve para comparar
   configurações lado a lado, não para cravar uma taxa com precisão.

---

## Dois instrumentos quebrados no caminho — registrados

**1. A primeira tentativa imprimiu `0,0%` nas três configurações.** Parecia o passo 6 funcionando
perfeitamente. As 30 chamadas tinham voltado **HTTP 400** (`function tools with reasoning_effort are
not supported`), os textos vieram vazios, e o detector não acha nada em texto vazio. O erro estava
capturado por linha; o resumo só imprimia a taxa. Corrigido: o script recusa calcular taxa quando há
turnos que não rodaram.

**2. A coleta com ferramentas reais devolveu 10 turnos vazios, e o spec passou.** Três causas em
cadeia, cada uma escondida pela anterior: credencial cifrada com outra chave
(`credential_decrypt_failed`); `AI_CRED_AES_KEY` do `.env.e2e` com 21 bytes em vez de 32
(placeholder do CI, que não exercita cifra); e o spec **nunca validava** a credencial que criava —
funcionava só porque reaproveitava uma validada à mão numa rodada anterior, dependência invisível de
estado. Os três consertados.

**O padrão comum:** turno que não roda e taxa que se calcula assim mesmo produz zero — e zero era o
número que se queria ver.
