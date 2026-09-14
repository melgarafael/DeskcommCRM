---
impacto: capacidade_nova
secao: adicionado
titulo: Dados da conexão para integrar outro sistema (endpoint e IDs) + onde obter o token
---

Depois de conectar um número, a tela de **Conexões** ganhou o painel **"Para
integrar"**: endpoint/base da API, identificadores (`phone_number_id`,
`waba_id` / conta) e nome da sessão, com um botão para copiar tudo de uma vez.

É o que faltava para plugar **outro sistema** no mesmo número sem caçar dado no
painel do provedor nem reler a documentação:

- **O token NÃO é exibido de volta.** Nada de credencial volta do servidor
  depois de gravada — em vez disso, um ícone de ajuda (ao passar o mouse) diz
  **onde obtê-la** no painel de cada provedor.
- **Aviso de webhook.** Um número tem um único endereço de webhook; para dois
  CRMs atenderem ao mesmo tempo, um precisa reencaminhar as mensagens ao outro.
- **Canal por QR (celular):** a credencial é interna desta instalação e não
  serve para fora — para outro CRM usar o mesmo número, ele conecta por uma
  sessão própria (novo QR). O painel explica isso e alerta sobre resposta
  duplicada se os dois tiverem atendimento automático.
