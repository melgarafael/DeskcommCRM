---
impacto: nada_mudou
secao: corrigido
titulo: A rota do catálogo por feed respeita o módulo que a empresa desligou
---

O catálogo por feed tem duas portas para o mesmo módulo: a tela, que publica o feed por `POST /api/v1/products/feed`, e o trabalho de fundo, que a cada 2 horas relê a fonte gravada. O cron já perguntava o módulo com a empresa — o `organization_id` da fonte — desde a fatia dos trabalhos de fundo, mas a rota perguntava só pela instalação. Numa instalação que hospeda várias empresas, quem desligava o Catálogo por feed em Módulos por empresa continuava publicando pela tela, e a rodada seguinte do cron recusava a mesma fonte: duas respostas para a mesma chave.

Agora a rota faz a mesma pergunta duas vezes, na mesma ordem do cron: a instalação, que é o teto e responde antes de qualquer leitura — 404, como já respondia —, e depois a empresa que o cookie resolveu, lida de `organization_modules`. Desligada para a empresa, a resposta é o mesmo 404 da instalação desligada, antes de buscar a URL, de ler o catálogo e de gravar produto ou fonte; não é um 403 novo, e não é um código que a tela não saiba tratar. Empresa sem linha herda a instalação; se a leitura da linha por empresa falhar, a rota nega em vez de publicar às cegas. Nada muda de banco, de tela nem de payload: quem nunca desligou nada continua exatamente onde estava. Contribuição de @webtecnica (issue #4871).
