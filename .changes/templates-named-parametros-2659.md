---
impacto: nada_mudou
secao: corrigido
titulo: Templates oficiais do WhatsApp com parâmetros nomeados (parameter_format NAMED) voltam a ser enviados pelo Inbox e pela API sem o erro meta_100
---

O envio de template lia o espelho de definições da Meta sem o campo parameter_format e derivava o contrato como POSITIONAL. Um template aprovado com parâmetros nomeados saía sem parameter_name em cada parâmetro textual, e a Meta recusava com meta_100: Parameter name is missing or empty — tanto no Inbox quanto pelo endpoint REST de mensagens, que passam pelo mesmo caminho de envio. Agora o formato declarado pela Meta acompanha a definição até a montagem do payload: parâmetros nomeados saem com o nome aprovado, e templates posicionais continuam exatamente como antes. Nada precisa ser feito ao atualizar; se você enviava templates nomeados que falhavam com meta_100, eles voltam a funcionar sem reconfiguração (issue 2659). Contribuição de @webtecnica (#2678).
