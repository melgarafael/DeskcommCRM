---
impacto: capacidade_nova
secao: corrigido
titulo: A conta do ChatGPT por assinatura renova sozinha no 401 e avisa na Central quando desconecta
---

Quando a IA usa a assinatura do ChatGPT e o login vence no meio de um atendimento, o sistema agora renova o login uma vez e tenta a resposta de novo, em vez de deixar o cliente sem resposta. A renovação passa a acontecer uma vez por janela de validade do login, e não a cada mensagem. Quando a renovação é recusada, o motivo aparece em IA › Credenciais (por exemplo, "acesso revogado" ou "sem resposta da OpenAI"), e a Central de avisos ganha um único item, "A conta do ChatGPT desconectou", com o botão para reconectar. Esse item se fecha sozinho quando o login volta, seja pela reconexão, seja por uma renovação que voltou a dar certo. Ao religar a conta, a lista de modelos já vem preenchida, e o primeiro "Publicar" não falha mais por modelo não encontrado. Nada precisa ser feito na instalação.

Para quem integra: se a sua integração lê o campo `kind` dos itens da Central de avisos (`agent_inbox_items`), ela vai passar a ver também o valor `assinatura_desconectada`. Outros valores novos podem aparecer no futuro.

Contribuição de @webtecnica.
