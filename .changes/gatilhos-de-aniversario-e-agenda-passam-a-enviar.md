---
impacto: capacidade_nova
secao: corrigido
titulo: Regras de WhatsApp por aniversário e por compromisso passam a enviar
---

As regras de automação com gatilho "No aniversário de um contato" ou "Agendamento criado/confirmado/remarcado/cancelado/compareceu/não compareceu" e ação de mandar WhatsApp (ou de acionar a IA, ou de iniciar um fluxo) nunca chegaram a enviar: o evento nascia sem a origem do atendimento e a ação terminava `failed` com `service_boundary_stale`, sem erro em lugar nenhum. O carimbo no instante da emissão e a resolução na leitura passam a ler a mesma tabela de `(tipo, entidade) → contato`.

Atenção a quem já tem uma regra dessas configurada: depois desta atualização ela envia WhatsApp de verdade para o contato, no próximo aniversário ou no próximo evento de agenda. O envio respeita a janela de horário do canal, o limite diário e o espaçamento entre mensagens, como qualquer automação. Eventos anteriores à atualização não são reenviados. Se a regra foi criada e esquecida, revise-a ou desative-a antes de atualizar.

Contribuição de @Tong-bit-art (#2330, Refs #2326).
