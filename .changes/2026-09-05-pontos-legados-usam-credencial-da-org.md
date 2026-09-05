---
impacto: nada_mudou
secao: corrigido
titulo: A chave de IA cadastrada pela organização passa a valer também na medição de clima e na resposta do bot
---

Dois pontos de IA — "Medir o clima da conversa" e a resposta do bot — só usavam
a credencial cadastrada em IA › Credenciais quando havia uma escolha explícita
no painel de provedores. Sem essa escolha, eles iam direto para a chave que veio
na instalação (`.env`), ignorando a chave que a organização cadastrou e validou
na tela. Numa instalação cuja chave de `.env` estava revogada, isso aparecia
como classificação de clima falhando com erro de autenticação enquanto o agente,
que já usava a credencial da organização, respondia normalmente no mesmo minuto.

Agora os dois seguem a mesma ordem do resto do produto: a escolha do painel,
depois a credencial ativa e validada do provedor da organização e, só então, a
chave da instalação. Nada a fazer — quem já tem credencial cadastrada passa a
usá-la na próxima chamada.
