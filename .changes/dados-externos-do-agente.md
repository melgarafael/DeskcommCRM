---
impacto: capacidade_nova
secao: adicionado
titulo: Conecte um banco de dados de outro sistema e o agente responde com esses dados
---

Agora o agente que atende no WhatsApp pode consultar, em tempo real, um banco de dados PostgreSQL externo — o seu segundo CRM, um ERP, a base que outro sistema escreve. É ali que costuma morar o que o cliente pergunta: pedido, assinatura, matrícula, saldo.

O caminho é **Organização › Dados e acesso › Dados externos**. Qualquer pessoa da equipe vê a lista e explora os dados; só um administrador cadastra e edita a conexão.

- **Somente leitura, de verdade.** A conexão roda com transação de leitura obrigatória e tempo limite, e só aceita consultas de seleção. Nada que o agente faz altera o banco de origem.
- **A senha é cifrada** com a mesma chave que o sistema já usa para as chaves de IA. Nenhuma variável de ambiente nova, nenhum passo manual de atualização.
- **Nada de schema fixo.** As tabelas e campos são lidos na hora, então quando o outro sistema muda, a tela e o agente já enxergam o novo formato.
- **Duas capacidades novas para o agente:** ver quais tabelas e campos existem, e buscar linhas com filtros e limite. O resultado é limitado para não estourar o contexto, e o agente é instruído a tratar o conteúdo como dado, nunca como ordem.

Quem instala ou atualiza numa VPS recebe o recurso pelo procedimento de sempre (`update.sh`): a mudança de banco entra junto do baseline.
