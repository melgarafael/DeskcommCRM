---
impacto: exige_acao
secao: corrigido
titulo: Regras de "negócio criado" passam a rodar também para o negócio aberto pela Prospecção
---
O negócio que a campanha de Prospecção abre chegava às automações marcado como se tivesse vindo de uma regra, e toda regra de "negócio criado" era pulada para ele. Etiqueta, roteamento e exclusão de follow-up nunca aconteciam. Agora ele roda as regras como qualquer outro negócio. Obrigado a @webtecnica pelo conserto e a @eduardosuruagy pelo relato (#3072).

## Requer atenção
Antes de atualizar, confira as suas regras com gatilho "Negócio criado" que **enviam mensagem** (WhatsApp, IA ou fluxo de mensagens). Elas vão passar a disparar também para as empresas abordadas pela Prospecção.
- Na campanha que cria o negócio **na hora do envio**, a regra escreve logo depois da primeira mensagem da campanha.
- Na campanha que cria os negócios **ao iniciar**, a regra dispara para a fila inteira no momento em que você clica em Iniciar, antes de a campanha mandar qualquer coisa, e a campanha pode pausar no primeiro contato com "Contato já atendido".

Se a regra não deve valer para a Prospecção, acrescente nela a condição em modo avançado: campo `lead.source`, operador "diferente de", valor `prospecting`. Não use o campo "Origem (utm_source)": ele é outro dado, e com "diferente de" a regra para de rodar para todo negócio sem UTM.
