# Preservação de etiquetas em regras sequenciais

Adaptado da contribuição pública https://github.com/jmpo/DeskcommCRM/pull/89. O contexto de um evento é uma fotografia compartilhada: regras sequenciais não podem regravar suas etiquetas a partir dessa fotografia.

O destino explícito contato já lê o banco. O destino padrão card passa a ler as etiquetas atuais com id e organization_id antes do merge. Falha de leitura impede escrita; linha ausente é skipped, sem evento de alteração inexistente. Após sucesso, o contexto recebe o resultado gravado. Eventos conservam caused_by_rule e só anunciam etiquetas novas.

Limite: esta correção preserva regras sequenciais do mesmo evento; não torna um read-modify-write atômico contra dois eventos concorrentes. Uma operação atômica separada exige validação de escopo, lock e emissão de eventos.

Sem alteração de permissões, schema, canal ou ativação de automações. Os testes cobrem regras com a mesma fotografia, alvo de contato/card, ausência/falha de leitura e evento/idempotência. A versão sem a correção reprova o teste de preservação.
