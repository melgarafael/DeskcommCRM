---
impacto: capacidade_nova
secao: adicionado
titulo: A foto do contato também pode ser lida por chave de integração (escopo Ler contatos)
---

A API `GET /api/v1/contacts/{id}/avatar`, que antes só atendia a pessoa logada no painel, agora também atende um servidor que se apresenta com uma chave de integração (`dsk_…`) marcada com o escopo **Ler contatos** (`contacts:read`). É a mesma autenticação dupla das demais rotas da API v1: a organização vem da linha da chave no banco, nunca do endereço pedido, então uma chave de uma empresa não alcança o contato de outra. Chave sem o escopo é recusada 403, chave inválida ou vencida é recusada 401 e a cota por chave continua valendo, como em todas as portas que aceitam chave.

Nada muda para quem usa a tela: a sessão do navegador continua pelo caminho de sempre — o mesmo redirecionamento temporário para o arquivo, o mesmo `Cache-Control` privado e a mesma ausência de foto para contato anonimizado. A prova está na suíte nova da rota (14 casos, cobrindo os cinco critérios da issue) e numa entrada nova na lista de caminhos que o proxy deixa passar sem sessão; sem essa entrada a chave receberia 401 antes de chegar na rota.

Quem chama a rota continua sendo a própria tela (`components/inbox/ConversationListItem.tsx:337`, `components/voice/ActiveCallPanel.tsx:154`, `components/voice/IncomingCallBanner.tsx:91`); o consumidor novo é o servidor de quem pediu a issue, que mora fora deste repositório.

Contribuição de @webtecnica (#3420).
