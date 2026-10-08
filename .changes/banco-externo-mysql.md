---
impacto: capacidade_nova
secao: adicionado
titulo: Dados externos agora aceita bancos MySQL, além de PostgreSQL
---
Em Dados externos, ao conectar um banco você escolhe se ele é PostgreSQL ou MySQL, e o assistente passa a consultar também bancos MySQL (por exemplo, o de um site WordPress). A conexão é sempre somente leitura; no MySQL, o teste avisa em amarelo quando o usuário do banco pode escrever ou ler o banco inteiro, e recomenda criar um usuário só de leitura e liberar só as tabelas ou views que o assistente deve ver. O tipo do banco não muda depois de criado: para trocar, apague a conexão e crie outra. Crédito: @paulolimajr77.
