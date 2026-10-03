---
impacto: nada_mudou
secao: alterado
titulo: A busca de prospecção passa por um despachante de provedor, e a Apify continua sendo a fonte
---

A prospecção tinha o provedor de busca como constante de módulo. Agora a busca passa por um despachante de interface única (`startSearch`, `readSearch`, `readResults`), e a escolha do provedor é lida de `organizations.settings.prospecting.provider`, sem migration. A Apify continua sendo o provedor de toda organização: quem opera a VPS não vê nada diferente, a validação da chave segue em `users/me`, e a chave segue na mesma `prospecting_settings.credential_encrypted`, por organização e cifrada. É a base para a próxima fatia trazer outro fornecedor de busca.

Os contratos de erro (`EscopoDaFalha`, `ProspectingError`) não se moveram: `worker.ts` e `guard.ts` seguem com zero linhas alteradas.

Contribuição de @webtecnica (#2174, refs #1758).
