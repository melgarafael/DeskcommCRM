---
impacto: nada_mudou
secao: corrigido
titulo: "OpenRouter: quatro auxiliares do agente leem o JSON do modelo mesmo com cerca de código, prosa ou repetição"
---

Os auxiliares do agente pedem JSON no prompt e leem o texto de volta, porque o seam de modelo não envia `response_format`. Modelos roteados pelo OpenRouter às vezes respondem com cerca de código (```json), com o objeto no meio de prosa ou com o JSON repetido. A leitura antiga recortava do primeiro `{` ao último `}`. Quando o objeto vinha repetido, o recorte pegava as duas cópias e o parse falhava (sintoma relatado: "JSON inválido em 7 de 11 checagens").

O novo `extrairJsonDoTexto` (lib/agent-engine/texto/) tenta o texto inteiro e, se não der, devolve o primeiro objeto `{...}` que parsear. A varredura respeita strings, então `{`, `}` e `"` dentro do texto do cliente não a confundem. Ela nunca lança. Se um objeto não fecha até o fim do texto, a busca para e devolve nada. Assim uma saída truncada continua sendo recusada no fechamento do turno, em vez de gravar um checkpoint vazio. Quatro auxiliares do turno do agente passam a ler por ele: checkpoint, compactação, roteador de intenção e o flywheel de propostas. Um teste de cerca impede a volta do recorte antigo nesses quatro. Outros seis leitores com o mesmo recorte ainda não foram migrados.

Contribuição de @webtecnica (PR #2096).
