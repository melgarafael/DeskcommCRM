---
impacto: capacidade_nova
secao: adicionado
titulo: Automações ganharam os gatilhos "caso aberto" e "caso encerrado", e o card do funil de atendimento passa a acompanhar o chamado
---

A tela **Automações** ganhou dois gatilhos: **Quando a Central abrir um caso** (`ai.case_opened`) e **Quando a Central encerrar um caso** (`ai.case_closed`). Com eles, a regra que já existe de mover o card — "Criar/mover lead no funil" — passa a levar o card do contato no funil de atendimento para a etapa que a regra declara: "caso aberto leva o card para Em atendimento", "caso resolvido leva para Resolvido".

Até aqui a etapa do card vinha do passo do agente (`crm_stages.agent_stage_hint`), que tem sete passos fixos e serve ao funil de vendas: num funil de atendimento as etapas do meio dependem do caso, e "resolvido" não é "ganho". Essa ponte continua exatamente como era — quem quiser trocar o funil de vendas pelo passo do agente não perde nada.

O evento é o mesmo que o sistema já publica quando o caso abre e quando ele fecha: nenhum emissor novo foi criado, e o caso que abre e fecha em minutos também move o card duas vezes, na ordem. O segundo gatilho traz o desfecho no campo **Desfecho do caso** (`resolved`, `escalated` ou `cancelled`), então a mesma regra pode levar caso resolvido para Resolvido e caso cancelado para Cancelado.

O card usado é o do contato **no funil que a regra aponta**: se ele ainda não existe, é criado ali. O card que o contato já tem em outro funil (o de vendas, tipicamente) **não** é transferido — o board de vendas continua intacto.

O mesmo evento entregue duas vezes (uma nova tentativa de entrega, ou o Reenviar da aba Atividade) move o card uma vez só: quando o card já está na etapa, a execução responde "já estava na etapa" e não escreve nada.
