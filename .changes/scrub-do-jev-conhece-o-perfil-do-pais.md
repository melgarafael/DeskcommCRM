---
impacto: nada_mudou
secao: corrigido
titulo: O scrub da telemetria passa a apagar NIF, IBAN e código postal de Portugal, e o +55 com hífen ou ponto
---

O scrub da telemetria (`lib/sentry/scrub.ts`), que o Sentry e o Jev usam, não conhecia o perfil do país da organização — a máscara da ingestão para a IA conhecia, desde o #2416. Com isso, uma organização de Portugal ainda deixava passar no Jev formas que a ingestão já mascara: o NIF `PT123456789` saía inteiro, o IBAN saía `PT50 [PHONE] [PHONE] 9015 4` (a cadeia de telefone comia os blocos de 4 dígitos por dentro) e o código postal `1000-001` não caía. No Brasil, `+55-11-98765-4321` saía inteiro e `+55.11.98765.4321` saía `+55.[PHONE]`: o separador depois do `55` só aceitava espaço.

O scrub agora aplica os padrões declarados em `lib/legal/perfil-do-pais.ts`, de todos os perfis — porque quem chama este scrub não tem organização na mão. O IBAN vem antes da cadeia de telefone, pela mesma razão do `apikey` e do UUID, e os demais vêm depois, para o que já saía apagado continuar saindo no mesmo formato de antes (o NIF sem prefixo segue saindo `[PHONE]`, como no #2345). Os resultados são travados por teste de resultado exato, forma a forma.

No Brasil a máscara também cresce, e para TODA organização, porque o scrub não sabe o país e aplica todos os perfis: no Sentry e nos textos que o Jev lê, o CEP com hífen (`01310-100`) passa a sair `[CEP]`, e grupos de dígitos com a forma do código postal português (`1234 567`, `1234-567`) ou do NIF em dois blocos (`123456 789`) passam a sair `[CODIGO_POSTAL]` e `[NIF]` — também quando são um número de lote, protocolo ou pedido, e não dado pessoal. A conferência de campo personalizado fica de fora: ela pergunta ao Jev se o valor que a IA quer gravar foi dito pelo cliente, e com `[CEP]` na mensagem recusaria o CEP que o cliente acabou de digitar. Por isso ela continua recebendo as mensagens exatamente como antes. Crédito: @webtecnica (#2435).
