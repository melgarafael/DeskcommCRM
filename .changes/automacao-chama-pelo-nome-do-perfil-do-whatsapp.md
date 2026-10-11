---
impacto: nada_mudou
secao: corrigido
titulo: Mensagem de automação com {{nome}} passa a usar o nome do perfil do WhatsApp quando o contato não tem nome cadastrado
---

Quem escreve pelo WhatsApp entra no CRM com o nome do perfil (o que aparece na tela do contato) e sem nome cadastrado. As automações só liam o nome cadastrado, então uma regra como "Olá {{nome}}, ..." disparada por **Novo lead** saía "Olá , ..." justamente no primeiro contato — o caso mais comum.

Agora `{{nome}}` e `{{primeiro_nome}}` seguem a mesma regra de nome da tela do contato: primeiro o nome cadastrado, depois o do perfil do WhatsApp, nunca um identificador técnico. Contato sem nome nenhum continua saindo com a variável vazia, como antes. Nada muda na configuração.
