---
impacto: nada_mudou
secao: corrigido
titulo: A conta do ChatGPT por assinatura só se conecta pelo botão de login
---

A credencial da assinatura do ChatGPT nasce marcada como conferida, porque quem a confere é o login. Mas o cadastro comum de chave (a API de credenciais e o passo da chave no onboarding) aceitava essa opção com um texto colado, e o texto virava uma credencial "conferida" sem login nenhum. Agora esses caminhos recusam a assinatura sempre, com o recurso ligado ou desligado, e a mensagem indica o botão de login em IA › Credenciais. O passo da chave no onboarding também deixou de oferecer essa opção.

Duplicar um agente que usa a assinatura, com o recurso desligado, agora é recusado com a mesma mensagem das outras gravações. Antes, a cópia voltava a usar a assinatura. A montagem do agente de prospecção pula a assinatura quando o recurso está desligado e escolhe a próxima chave que funciona. Não há nada a configurar na atualização.
