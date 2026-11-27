---
impacto: capacidade_nova
secao: adicionado
titulo: A Straitly entra como empresa de inteligência artificial do atendente
---

A Straitly agora aparece na lista de empresas de IA, junto de Anthropic, OpenAI, Google, OpenRouter, DeepSeek, Requesty e AI/ML API. Dá para cadastrar a chave em "IA › Credenciais" e escolher os modelos dela para o atendente e para as outras funções da IA.

Ela é uma agregadora compatível com a OpenAI: uma chave só dá acesso a mais de 100 modelos de vários fabricantes, com cobrança por token em créditos pré-pagos numa conta só. A chave é conferida em `/v1/key` na hora de salvar, a lista de modelos vem do catálogo público `/v1/models` e o endereço é fixo, então a chave só é enviada para `api.straitly.ai`.

Para quem já usa outra empresa de IA, nada muda: o atendente continua no mesmo provedor e modelo, e a Straitly só passa a valer quando alguém a escolhe.
