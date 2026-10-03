---
impacto: capacidade_nova
secao: adicionado
titulo: O chat de casos mostra os trechos do acervo ligados à pergunta
---

Ao perguntar dentro de um caso (`Conversar sobre o caso`), a tela passa a mostrar, num painel
ao lado, os trechos do acervo de conhecimento do agente do caso que se ligam à pergunta. A busca
é a mesma das conversas (F1 da #1869): mesma fonte, mesmo limiar. Os trechos acompanham a
resposta, mas a IA ainda não os lê ao responder, então eles não são a fonte dela. Fazer a
resposta se apoiar no acervo é o próximo passo da #1869. Sem acervo publicado, nada aparece e
nada dá erro. As guardas da conversa seguem iguais: 404 em vez de 403 para conjunto vazio,
idempotência por `turn_id` e recusa de contato anonimizado.

Contribuição de @webtecnica (#1952).
