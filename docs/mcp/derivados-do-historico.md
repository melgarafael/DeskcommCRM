# Texto derivado no histórico MCP

Destino: núcleo, contrato da ferramenta existente `crm_get_conversation_history`.

Além de `mcp:read` e do papel mínimo da ferramenta, o token deve receber explicitamente `messages:derived:read` em Configurações → Tokens de API. O escopo permite que a integração leia transcrições e texto extraído de mídia, que podem conter dados pessoais. Tokens anteriores permanecem sem esse escopo. Revogação e expiração continuam na autenticação nativa por chamada; a atualização não altera tokens existentes.

Com esse escopo, cada mensagem recebe `media_derived_status` e `media_derived_text`. Texto só é retornado para status `ready`. Mídia marcada expirada não retorna conteúdo derivado. Sem escopo, as chaves adicionais não são emitidas. A permissão não amplia o conjunto de conversas, não assina novos links, não retranscreve nem altera retenção. O campo `body` pode continuar nulo para áudio: o consumidor deve ler os campos derivados.

Entrada: token autenticado e histórico existente. Saída: DTO do histórico, consumido por integrações MCP. Observabilidade e controle de falha: auditoria e erros nativos da chamada; status `pending`/`failed` não são sucesso vazio nem tentam gerar novo texto. Não há rota/tela/tabela nova, daemon ou loop de retry. Native runtime sem tokenScopes não recebe esse opt-in implicitamente.
