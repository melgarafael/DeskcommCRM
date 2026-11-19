---
impacto: capacidade_nova
secao: adicionado
titulo: A ferramenta crm_list_pipelines traz os campos de cada funil, com a chave que o agente deve gravar
---

Quem lê o CRM por MCP não tinha como saber a CHAVE de um campo do funil, e inventava uma em `custom_fields` — `"valor"` no lugar de `valor_do_contrato`. A escrita passava, porque o schema de `custom_fields` aceita chave livre, e o valor ficava órfão no card: um defeito mudo, que só aparece quando alguém abre a ficha e não vê o dado que o agente disse ter gravado. Agora `crm_list_pipelines` devolve, por funil, `campos` com `key`, `label`, `type`, `escopo` e, nos campos de lista, os `options[].value` aceitos; a descrição da ferramenta diz que em `custom_fields` se usa essa key. A leitura é `camposDoFunil` — a MESMA que a ficha, o card e as regras usam —, então a lista do modelo não diverge da tela: definição que não passa em `customFieldSchema` não entra. `escopo` vai junto porque ele muda ONDE o valor é gravado (`contacts.custom_fields` no campo de contato, `crm_leads.custom_fields` no de negócio). Funil sem campo devolve `campos: []`, nunca ausente. A descrição da ferramenta cresceu 55 tokens (63 → 118, medido), e a entrada no teto de peso foi remedida.

Contribuição de @webtecnica (#4667), com desenho convergente de @tabaterral (#4733).
