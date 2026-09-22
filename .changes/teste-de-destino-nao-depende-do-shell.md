---
impacto: nada_mudou
secao: corrigido
titulo: A suíte deixa de depender do proxy de modelo de quem a roda
---

Nada muda para quem usa o CRM: a correção é na suíte de testes.

Quem contribui com um proxy de modelo configurado no shell (LiteLLM, um gateway
da empresa, qualquer roteador local) via `tests/unit/gateway-destino-por-caminho`
reprovar na própria máquina enquanto passava no CI — o teste afirma para onde a
requisição vai, e os SDKs da Anthropic e da OpenAI leem `ANTHROPIC_BASE_URL` do
ambiente por conta própria, apontando o destino para `localhost`.

O teste passa a isolar essas variáveis, e a devolvê-las depois.
