---
impacto: capacidade_nova
secao: adicionado
titulo: O ChatGPT (e outros aplicativos de MCP) conecta ao CRM por OAuth, sem colar token
---

Aplicativos como o ChatGPT só oferecem OAuth na hora de adicionar um servidor MCP:
não há onde colar um token de API. Agora o CRM atende esse caminho. No aplicativo,
adicione um servidor MCP com o endereço `https://<seu-domínio>/api/mcp` e escolha
OAuth: abre uma tela do próprio CRM, você entra com a sua conta, escolhe a empresa
e decide se o aplicativo só lê ou também altera dados. Só quem administra a empresa
pode conectar.

A conexão aparece na tela API Tokens com "(OAuth)" no nome, e revogá-la ali a
desliga. Quem deixa de administrar a empresa perde a conexão na renovação seguinte
(até uma hora). O token colado à mão (`dsk_…`) continua funcionando como antes. A
instalação precisa ter `NEXT_PUBLIC_APP_URL` com o endereço público real — é ele que
o aplicativo confere.
