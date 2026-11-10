# lib/ai/

> Este README foi um placeholder da Spec 05 até 2026-10. Ele aponta para as fontes; não lista
> modelos nem contagens, que envelhecem.

## Onde o sistema usa IA

A lista única é [`pontos/registro.ts`](pontos/registro.ts): cada chamada de modelo é um **ponto**
(`agent_turn`, `intent_router`, `sentiment_classify`, `transcricao_de_audio`…), agrupado por papel
para a tela (atender, entender, proteger, lembrar, perceber, melhorar). Ele alimenta
`/app/ai/providers` e `/app/ai/runs`, e `tests/unit/pontos-de-ia-completude.test.ts` reprova nos dois
sentidos: chamada fora do registro e ponto registrado que nenhum código chama. Para ver os pontos:

```bash
grep -nE '^\s*id: "' lib/ai/pontos/registro.ts
```

## Qual modelo e qual chave

- A escolha de modelo é **por organização e por ponto**, no banco (`ai_purpose_bindings`), validada
  contra o registro.
- A chave é BYOK por organização (`ai_provider_credentials`, cifrada). Sem ela, o fallback é a chave
  de plataforma do env — ver o cabeçalho de `lib/agent-engine/edge/llm/credentials.ts`.
- O teto de gasto mora em `ai_budgets`.

## Onde mora cada coisa

| Caminho | O quê |
|---|---|
| `lib/agent-engine/` + `workers/agent-worker` | Runtime canônico do agente (turno de entrada, follow-up, roteador) |
| `runtime/` | Runtime antigo, `@deprecated` — não adicionar features |
| `decisao/` | O Jev (System One): tarefas paralelas de decisão — clima, pedidos, manipulação, roteador |
| `rag/`, `knowledge/`, `embeddings/` | Ingestão, indexação e busca na base de conhecimento por organização |
| `workers/media-derive-worker.ts` | Transcrição, visão e PDF → texto para o modelo |
| `workers/ai-sentiment-worker.ts` | Clima da conversa → handoff para humano |
| `workers/voice-agent/` | Agente de voz (AudioSocket/Asterisk) |
| `lib/mcp/` | O CRM exposto via MCP para agentes externos |
