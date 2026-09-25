---
impacto: capacidade_nova
secao: adicionado
titulo: A tela de credenciais ganha o provedor personalizado compatível com OpenAI
---

Quem roteia a própria IA por um endpoint próprio — OmniRouter, 9Router, FreellmAPI, proxy corporativo, LiteLLM ou vLLM rodando na sua máquina — agora encontra a opção **"Provedor personalizado (compatível com OpenAI)"** em **IA › Credenciais**, junto dos provedores de sempre. Dá para informar a base URL e a chave, escolher o modelo no assistente e publicar: o agente conversa por aquele endpoint do mesmo jeito que conversa pelos outros.

O endereço fica guardado na própria credencial, cifrada como todas as outras — na tela só aparecem os quatro últimos caracteres da chave, e o endereço nunca é impresso em log. Cadastro, teste, validação e o turno do agente leem a mesma escolha.

Antes de salvar, a tela testa a conexão (`GET {base}/models`, 10 segundos): acertou, mostra a confirmação e quantos modelos o endpoint devolveu; errou, não grava nada e mostra o erro no campo. Depois de gravada, a validação em segundo plano repete a mesma chamada sobre a linha salva.

Nada muda para quem já usa Anthropic, OpenAI, Google ou OpenRouter: a opção nova nasce disponível, não ligada.
