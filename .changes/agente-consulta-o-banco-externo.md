---
impacto: capacidade_nova
secao: adicionado
titulo: O agente de IA passa a consultar o banco de dados externo que a empresa conectou
---

O banco externo (**Organização › Dados e acesso › Dados externos**) deixa de ser
só uma tela: o agente que atende no WhatsApp agora pode ler dele para responder
com o dado real (pedido, assinatura, saldo) em vez de estimar. São duas
capacidades novas no pacote **"Organizar a operação"**:
**"Ver as tabelas do banco conectado"** e **"Buscar dados no banco conectado"**.

- **Nada muda sozinho.** Nenhum agente existente ganha as duas: é preciso ligá-las
  na tela do agente. Sem conexão cadastrada, elas não abrem rede nenhuma.
- **Somente leitura**, dentro dos limites que o administrador configurou na
  conexão (linhas, filtros e tamanho da resposta).
- **O log não guarda o que o cliente buscou.** A auditoria registra a tabela e o
  campo consultados, nunca o valor do filtro (CPF, telefone, nome).
- **Busca sem resultado volta vazia.** O agente nunca recebe linhas de outras
  pessoas quando o filtro não casa.

Trabalho de @vgamkt, recortado do PR #1130.
