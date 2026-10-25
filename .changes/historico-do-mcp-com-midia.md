---
impacto: capacidade_nova
secao: adicionado
titulo: O histórico de conversa pelo MCP passa a trazer a mídia com link temporário
---

`crm_get_conversation_history` devolve, para cada mensagem com mídia, `media_mime`, `media_size_bytes`, `media_status` e `media_signed_url`. O link vale 1 hora, a mesma validade da rota `/api/v1/messages/[id]/media`. Até aqui vinha só o `media_url`, o endereço interno do canal, que não abre fora do servidor. Quem consome pela API (um sistema que transcreve áudio, por exemplo) agora baixa o arquivo direto.

`media_status` diz `ready` (arquivo guardado), `pending` (ainda sendo guardado, ou o link falhou: tente de novo), `expired` (apagado pela política de retenção) ou `none` (mensagem sem mídia). Falha ao gerar o link nunca derruba o histórico.

No turno do agente de atendimento, o tipo e o estado da mídia chegam, mas o link não: o agente não consegue abri-lo, e um link de acesso a foto ou áudio de cliente não deve sair para o provedor de IA. Contribuição de @lucasprestes1.
