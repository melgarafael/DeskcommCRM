---
impacto: nada_mudou
secao: corrigido
titulo: A listagem de modelos da assinatura do ChatGPT volta a funcionar
---

Com a conta do ChatGPT conectada em IA › Credenciais, o campo Modelo do agente
mostrava "Não consegui listar os modelos da assinatura do ChatGPT (http_401)"
mesmo com a credencial validada — a conversa funcionava, mas `models_available`
ficava vazio, o botão "Criar agente" aparecia desabilitado e o "Publicar" caía em
`model_not_found`. A listagem passa a mandar, junto do `Authorization`, o id da
conta que o backend do Codex exige (o mesmo que o CLI oficial envia), lido da
credencial já conectada.

No formulário de credenciais, o provedor "OpenAI pela assinatura (ChatGPT)"
dizia no campo Chave "conectado pelo login — não se cola chave" e ainda assim
exigia uma chave para salvar. Agora aceita o campo vazio e diz onde a conta se
conecta; nos demais provedores a chave continua sendo exigida.

Você não precisa fazer nada.

Contribuição de @webtecnica (#2957).
