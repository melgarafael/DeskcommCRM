# Doutrina Claude — Feature `ryze-channel`

Diretrizes e restrições para sessões de engenharia no provedor RyzeAPI.

## Doutrina de Canal (`docs/doctrine/restricao-de-canal.md`)
1. **Nenhuma feature nomeia um provider:** Código fora de `lib/channels/` não escreve o literal `ryze` ou `Ryze`.
2. **Declaração de Origem e Física:** Capabilities diferenciam auto-restrição (`banRisk`) de hetero-restrição (`requiresTemplates`).
3. **Seam de Canais:** Toda interação de WhatsApp ocorre através da interface `ChannelAdapter` em `lib/channels/`.
4. **Segurança P0:** Secrets, tokens de autorização e API keys nunca são logados nem persistidos bruto em banco de dados.
