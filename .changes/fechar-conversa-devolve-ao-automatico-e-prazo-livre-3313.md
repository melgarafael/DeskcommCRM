---
impacto: capacidade_nova
secao: adicionado
titulo: Fechar uma conversa de contato com a equipe pergunta se o atendimento volta para o automático, e o prazo de devolver sozinho passou das 24 horas
---

A trava de atendimento humano mora no CONTATO, não na conversa — então fechar a conversa não a soltava: a próxima mensagem daquele cliente, dias depois, não recebia resposta da IA, e ninguém percebia até o cliente reclamar. Agora, ao fechar uma conversa cujo contato está com a equipe, o diálogo de confirmação pergunta o que fazer, com «Devolver ao automático ao fechar» MARCADO por padrão; a outra opção é «Manter com a equipe». Escolhendo devolver, a conversa encerra e a trava é solta pela mesma regra do botão «Devolver ao automático», com a memória do que a equipe falou gravada para a IA retomar. Contato marcado como «sempre atendimento humano» continua com a equipe, e a tela avisa isso ao fechar. Fechar uma conversa cujo contato NÃO está travado continua idêntico: nenhuma pergunta, nada muda.

Em Configurações › Distribuição de atendimento, o prazo de «Devolver ao agente sozinho depois de um tempo sem resposta da equipe» deixou de ter teto de 24 horas: agora vai de 5 minutos a 30 dias, e o cron de devolução respeita prazos longos. Quem não usa o ajuste continua com a regra de sempre — a IA só volta quando alguém clica em Devolver. As abas da Inbox (reordenar e ocultar) ficam para a próxima fatia e NÃO entraram aqui.
