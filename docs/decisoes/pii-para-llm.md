# PII → LLM: estado real e decisão de produto

Data: 2026-09-24. Levantamento de código (CONFIRMADO). Nada implementado além
do que está descrito aqui.

## O que realmente acontece hoje com os dados pessoais

### Rota 1 — Turno do agente ao vivo (a principal)
`lib/ai/runtime/agent.ts` — `generateText({ model, system, messages, tools })`.
O prompt carrega: system prompt da organização + histórico da conversa +
mensagem recebida. **Sem anonimização**: o agente precisa saber com quem fala
(nome, telefone como endereço do canal). **Nenhum header de privacidade** é
enviado nesta chamada.

O modelo é resolvido em `lib/ai/gateway.ts` (`resolveLanguageModel`), nesta ordem:
1. **Vercel AI Gateway** (string ID, `AI_GATEWAY_API_KEY`).
2. **OpenRouter** (`OPENROUTER_API_KEY`) — só headers de atribuição
   (`HTTP-Referer`, `X-Title`); nada de privacidade.
3. **Direto Anthropic / OpenAI** (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).
4. No modo "ensaio"/teste também: **Google** (`createGoogleGenerativeAI`) e
   **DeepSeek**.

### Rota 2 — Embeddings (RAG)
`lib/ai/embed.ts` — via gateway com `gatewayHeaders()` ou direto à OpenAI.
O conteúdo são chunks do RAG, **anonimizados no ingest**
(`lib/ai/rag/ingest/conversations.ts` → `anonymize()`).

### Rota 3 — Workers legados
`workers/ai-response-worker.ts`, `workers/ai-sentiment-worker.ts` — mesmo
`generateText`, mesma resolução de modelo, sem headers de privacidade.

### O módulo `lib/ai/anonymize/`
Só é usado no **ingest do RAG**. O turno ao vivo NÃO anonimiza nada.
Os outros acertos de "anonymize" no código são flags LGPD em nível de registro
(`is_anonymized` veta envios), não anonimização de prompts.

## Correção aplicada em 2026-09-24

`gatewayHeaders()` em `lib/ai/gateway.ts` enviava o header
`X-AI-Gateway-Zero-Retention: 1` com o comentário de que "optava a chamada para
fora dos corpora de treino do provedor". **Esse header NÃO é um mecanismo
documentado do Vercel AI Gateway** — era ignorado, e o comentário criava uma
garantia de privacidade que não existia. O mecanismo real é
`providerOptions: { gateway: { zeroDataRetention: true } }` na chamada do AI
SDK (verificado na documentação do Vercel / AI SDK em 2026-09-24), e o ZDR por
request exige plano **Pro ou Enterprise**. O header foi removido e o comentário
corrigido.

Ou seja: hoje **não há nenhuma garantia técnica de zero-retention ativa** no
turno do agente. A cobertura real é contratual (termos de cada provedor).

## Cobertura contratual por provedor (pendente de verificação)

- **Vercel AI Gateway**: ZDR por padrão no nível do gateway (prompts apagados
  após o request), mas a retenção do provedor *downstream* é pergunta separada;
  o enforcement de ZDR por request é Pro/Enterprise. Verificar no dashboard que
  o content logging está OFF.
- **Anthropic API direto**: não treina com dados da API por padrão (verificar
  termos comerciais vigentes).
- **OpenAI API direto**: dados da API não usados para treino por padrão
  (verificar).
- **OpenRouter**: não treina; a retenção downstream depende de cada provedor;
  dá para filtrar por política de dados por request.
- **Google / DeepSeek**: verificar termos.

Nada do acima está verificado contra os termos vigentes — é tarefa pendente
antes de prometer qualquer coisa a um cliente.

## Opções de decisão (para o dono)

**A. Status quo documentado.** Os prompts com PII vão ao provedor configurado;
a cobertura é contratual. Requer: verificar termos reais + desligar content
logging no dashboard do Vercel. Custo: quase zero. (O header enganoso já foi
removido em 2026-09-24.)

**B. Tokenização no turno ao vivo.** Trocar nome/telefone/e-mail por tokens
(`[CONTATO-1]`) antes do modelo e resolver só no before-send. Custo:
complexidade real e risco de degradar o agente (a personalização precisa do
nome). Só vale a pena se um cliente exigir por compliance.

**C. Híbrido (recomendado).** A + ZDR real via
`providerOptions.gateway.zeroDataRetention` (requer Vercel Pro) + filtro de
provedores com política de não-retenção no OpenRouter + PII mínima no prompt
(só o necessário para a tarefa).

## Regra

Nunca afirmar que "todos os prompts estão anonimizados" nem que "há
zero-retention ativo". O que há hoje é: RAG anonimizado no ingest +
cobertura contratual dos provedores. Todo o resto é trabalho futuro
explícito, não dívida escondida.
