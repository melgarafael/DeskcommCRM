---
impacto: nada_mudou
secao: corrigido
titulo: A Agenda conecta uma conta Google diferente da conta de login do CRM
---

Quem entrava no CRM com um e-mail e tinha a agenda da clínica em outro chegava até a tela do Google e autorizava, sem seletor nenhum, a conta que já estava logada no navegador: ou a agenda errada entrava no CRM, ou a conexão voltava para a tela sem ter conectado nada. A causa era o pedido de consentimento sair com `prompt=consent` junto do `login_hint` — a dica que sugere a conta certa virava ordem, porque o Google só oferece a escolha de conta quando o pedido pede. Agora o pedido sai com `prompt=consent select_account`: a tela de escolha de conta aparece, com a conta sugerida em cima para quem só tem uma. Nada mais mudou — quem conecta a agenda com a mesma conta que usa para entrar no CRM continua conectando em dois cliques, e a reconexão continua pedindo o `refresh_token` do mesmo jeito.
