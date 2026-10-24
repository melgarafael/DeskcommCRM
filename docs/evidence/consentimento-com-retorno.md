# Consentimento com compromisso de retorno

Escopo: função determinística `detectHumanPromise`, sem chamada a modelo, canal ou banco.

Reprodução dirigida dos cinco exemplos apontados na revisão do #2761, mais retaguarda nomeada e controles negativos. O teste novo não altera a suíte preexistente nem suas assertivas.

Comando: `pnpm exec vitest run tests/unit/consentimento-preserva-antecedente.test.ts tests/unit/consentimento-isento-so-na-mensagem-inteira.test.ts --reporter=verbose`.

Antes: exit 1, 6 falhas e 11 passes. Cinco falhas são os exemplos da revisão; a sexta é o antecedente nomeado. Depois: exit 0, 17 passes em 2 arquivos. Formatação e ESLint dos dois arquivos: exit 0.

Limites: não mede precisão de modelos ou entrega externa. A jornada Google previamente validada é uma evidência distinta; não foi repetida para este detector puro. Nenhuma autorização externa de tratamento de dados é inferida desses testes.
