---
impacto: nada_mudou
secao: corrigido
titulo: Com a assinatura do ChatGPT conectada, a lista de modelos passa a ser buscada no serviço do Codex, e não mais num endereço que recusava o token
---

Com a credencial "OpenAI pela assinatura" conectada, a lista de modelos da conta era buscada num endereço que recusa o token da assinatura: a lista nunca era gravada e o "Publicar" do agente respondia `model_not_found`. Agora a lista é buscada no mesmo serviço que o Codex usa. Se a busca falhar, o seletor de modelo do agente mostra o motivo e diz que a conta continua conectada; sem conta conectada, ele pede para conectar em IA › Credenciais. A conversa em si **não mudou**: ela segue indo ao endereço que, pela medição da issue, recusa o token da assinatura e cai na credencial de reserva (#2602, ponto 1, em aberto). Ter a lista de modelos não quer dizer que a assinatura já responde ao cliente. Nada precisa ser feito ao atualizar. Se a lista não vier na sua conta, declare `CODEX_CLIENT_VERSION` no `.env` com um valor de `client_version` (ex.: `0.160.1`). Contribuição de @webtecnica (#2622), a partir da issue #2602 de @GabrielBottan.
