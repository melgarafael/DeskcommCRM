---
impacto: capacidade_nova
secao: adicionado
titulo: Campos do formulário nas mensagens das automações
---
Nas automações, `{{servico}}` passa a valer como atalho do campo `servico` do lead (antes só o caminho longo, `{{lead.custom_fields.servico}}`, funcionava). Os campos cadastrados no funil aparecem como botões na ação de WhatsApp, e a "Mensagem escrita pela IA" passa a receber o rótulo cadastrado ("Serviço que precisa") em vez da chave crua. Quem já usa `{{nome}}` e `{{telefone}}` não percebe diferença. Resolve a parte de variáveis da issue #1993.
