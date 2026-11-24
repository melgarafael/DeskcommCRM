---
impacto: nada_mudou
secao: corrigido
titulo: A devolução automática ao agente não toma mais a conversa que um atendente acabou de assumir ou responder
---

Com o prazo de devolução ligado (Configurações › Distribuição de atendimento), a rotina automática lê as conversas paradas e, logo em seguida, devolve cada uma ao agente de IA. Se nesse intervalo um atendente assumisse a conversa ou respondesse o cliente, a rotina não via a mudança e devolvia a conversa à IA mesmo assim, logo depois de a pessoa entrar nela.

Agora a devolução confere, no momento da escrita, que a conversa continua com o mesmo responsável lido na varredura e que ninguém da equipe assumiu ou respondeu depois do prazo vencer. Se mudou, a conversa fica com a pessoa e a rodada segue para a próxima, sem contar como falha. O banco ganha uma função de apoio (migration 9472), aplicada pela atualização normal. Nada a fazer.
