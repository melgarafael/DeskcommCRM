---
impacto: nada_mudou
secao: corrigido
titulo: O cálculo de custo do runtime nativo legado reconhece os ids da OpenRouter e não chama de grátis o preço que não conhece
---
Contribuição de @webtecnica (#1963, issue #1931). O cálculo de custo do runtime nativo legado (`lib/ai/runtime/`) agora reconhece ids da OpenRouter escritos com ponto na versão ou com sufixo de variante, como `anthropic/claude-haiku-4.5`. Quando o preço do modelo não é conhecido, o custo fica registrado como desconhecido, e não mais como zero. Um modelo gratuito de verdade continua custando zero, e a variante `:free` não herda o preço do modelo pago. Esse runtime não é o que calcula o custo numa instalação hoje: o caminho ativo passa por `lib/agent-engine/edge/llm/pricing.ts`, e a correção dele segue aberta na #1931. Não é preciso fazer nada na instalação.
