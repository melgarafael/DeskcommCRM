---
impacto: nada_mudou
secao: corrigido
titulo: A agenda do celular não recria mais o contato que o titular pediu para apagar
---

"Sincronizar agenda do celular" gravava pela mesma função da ingestão de mensagens, mas sem fazer a pergunta de LGPD que a sincronização da agenda do app já fazia: como a anonimização zera o telefone da ficha, a pré-leitura não a encontrava e o contato voltava ao cadastro com o número e o nome salvos no aparelho. Agora a sincronização pergunta antes de gravar, em lote, a mesma pergunta da ingestão, e na dúvida não cria nada. Quem pediu para ser apagado não volta por esse caminho, e o resumo da tela conta esses contatos como ignorados.

Você não precisa fazer nada.

Ajuste a partir da issue #3432.
