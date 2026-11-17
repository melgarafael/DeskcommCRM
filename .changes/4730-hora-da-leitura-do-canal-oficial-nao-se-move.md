---
impacto: nada_mudou
secao: corrigido
titulo: No canal oficial, a hora da leitura não muda quando o aviso de leitura chega repetido
---

No canal da API oficial, a hora em que o cliente leu a mensagem passa a ser gravada uma vez só. A plataforma reenvia o aviso de leitura quando não recebe a confirmação a tempo, e cada reenvio trocava essa hora pela hora do reenvio. Agora a primeira leitura fica, do mesmo jeito que a hora da entrega já ficava. Nenhuma ação é necessária na atualização. Contribuição de @webtecnica (#4730, #4316).
