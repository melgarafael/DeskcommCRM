---
impacto: exige_acao
secao: alterado
titulo: Um só catálogo de variáveis {{...}} para automação, follow-up, campanha e resposta rápida
---

A mesma frase escrita com `{{...}}` saía diferente dependendo da tela em que foi escrita. Medido na `main` de ontem, com o texto `{{saudacao}}, {{primeiro_nome}}! Seu pedido chegou.` e o mesmo contato:

- automação e follow-up: `, Ana! Seu pedido chegou.` (a variável virava vazio e a vírgula ficava órfã);
- resposta rápida: `{{saudacao}}, Ana! Seu pedido chegou.` (a marcação saía **literal** para o cliente);
- campanha: `Boa tarde, Ana! Seu pedido chegou.`

Agora existe **um** catálogo, **um** resolvedor e **um** seletor compartilhados. As quatro telas passam a produzir a mesma saída para o mesmo contato, cada uma preservando a política que já tinha para dado ausente (vazio, literal, remover ou pular o envio) — a diferença de política continua sendo escolha de cada canal, o que deixou de existir é a diferença de **significado** da variável. `{{saudacao}}` passa a resolver em automação, follow-up e resposta rápida.

Contribuição de @webtecnica (#3687).

## Requer atenção

**Exige ação:** quem usa `{{saudacao}}` em automação ou follow-up e contava com o vazio (ou com a marcação literal na resposta rápida) vai ver o cumprimento no lugar. O mapa posicional do fluxo da Meta (`contact_name`, `contact_first_name`, `lead_custom`) continua igual, e nenhuma automação já gravada perde variável: chave desconhecida segue caindo na leitura que existia antes.
