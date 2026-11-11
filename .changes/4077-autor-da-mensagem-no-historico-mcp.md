---
impacto: capacidade_nova
secao: adicionado
titulo: O histórico de conversa pelo MCP diz quem da equipe enviou cada mensagem
---

O `crm_get_conversation_history` devolvia `sent_via`, que separa pessoa de IA e de automação, mas **não dizia de qual pessoa era a fala** — e nem o `sent_by_user_id`, que já estava na linha lida pelo handler. Quem consome por token (integração de cobrança, auditoria de atendimento) não tinha como saber se a promessa saiu de um atendente ou da IA, nem qual deles respondeu.

Agora cada mensagem traz `sent_by_user_id` e `sent_by_user_name`. O nome sai da **mesma resolução que o balão do inbox usa**, com os ids distintos da página: uma consulta só, que confere o vínculo com a organização e traz o nome, nunca uma por mensagem. Mensagem recebida do cliente, de IA, de automação, de sistema ou de celular sai com os dois campos vazios — vazio é "não há autor interno", não um "sistema" inventado. Id de quem não tem vínculo com a organização do chamador também sai sem nome: o `sent_by_user_id` continua sendo a verdade e o nome é a cortesia.

A transcrição do áudio (`media_derived_text` / `media_derived_status`) continua vindo do mesmo jeito que chegou na versão anterior: atrás do escopo próprio `messages:derived:read`, porque o texto pode conter dado pessoal.
