---
impacto: capacidade_nova
secao: adicionado
titulo: Importar lista na prospecção mostra, antes de importar, o motivo de cada linha que fica de fora
---

Em CRM › Prospecção › "Usar minha planilha", o botão novo "Conferir a lista antes de importar"
mostra quantas empresas entram e quais linhas ficam de fora, cada uma com o número da linha e o
motivo: sem nome, sem telefone, telefone inválido, repetido na própria planilha, já é contato do
CRM ou excluído a pedido do titular (LGPD). A conferência não cria campanha. Importar direto
continua possível, e o resultado da importação passa a listar os mesmos motivos.

Antes, telefone em branco e telefone inválido diziam a mesma frase, e quem já era contato ou tinha
pedido para sair aparecia só como "já estava na base". Agora a supressão da LGPD aparece com o
nome dela, e continua barrada também pelo gatilho do banco. As campanhas importadas na 1.95.0
seguem com o rótulo "Planilha". Nenhuma migração de banco. Crédito: @webtecnica (#3724).
