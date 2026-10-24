---
impacto: capacidade_nova
secao: adicionado
titulo: Campo personalizado de arquivo com anexo de documentos, pré-visualização e travas de etapa
---

Adiciona o tipo de campo customizado `file` para negócios, permitindo anexar documentos, PDFs, vouchers e comprovantes com área de soltura (arrastar e soltar) e visualização direta em modal.

Os arquivos são armazenados com isolamento multi-tenant na tabela `crm_lead_attachments`, com URLs assinadas geradas sob demanda no bucket privado do Supabase Storage, auditoria por `audit()`, conformidade com LGPD e proteção por travas obrigatórias no avanço de etapas do funil.

Contribuição de @kaiow2018-cmd (#3229), a partir da issue #2829.
