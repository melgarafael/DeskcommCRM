---
secao: corrigido
impacto: nada_mudou
titulo: O plano de tarefa mostra o limite e diz qual campo passou
---
Em Tarefas › Planos, uma descrição de plano com mais de 300 caracteres não salvava e a tela mostrava só "Dados inválidos.", sem dizer o que corrigir — parecia que alguns caracteres eram proibidos. Agora a descrição tem contador ("245/300") e para no limite, o nome e o título dos passos também param no limite, o prazo do passo é conferido antes de salvar, e quando algo é recusado a mensagem nomeia o campo e o passo ("O título do passo 2 pode ter até 200 caracteres."). Nenhum caractere é proibido. Crédito: @LuigiMDev.
