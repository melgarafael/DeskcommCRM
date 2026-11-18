---
impacto: capacidade_nova
secao: adicionado
titulo: O atendente pode importar empresas e pessoas, e a importação define o dono da carteira dos contatos criados
---

Em **Importações**, o atendente agora também importa planilhas (antes era só gerente e administrador). Os contatos criados pelo lote entram na carteira de um dono, com a origem "importação": por padrão quem importa, e gerente ou administrador podem escolher qualquer membro ativo no seletor **Dono da carteira dos contatos criados**. O atendente só pode ser dono dele mesmo: pedir outro dono é recusado antes de qualquer coisa ser gravada, e a regra de posse da carteira continua valendo para todo o resto (contato que já tem dono, ou que veio de outra origem, não muda). Excluir um lote continua sendo do gerente. É preciso aplicar a migration 9421 (o `update.sh` faz isso).
