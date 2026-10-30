---
impacto: capacidade_nova
secao: adicionado
titulo: No canal oficial direto, o modelo de mensagem agora se cria, edita e apaga pela tela do CRM
---

Quem conecta o WhatsApp pela API oficial direta, inclusive por coexistência, precisava sair do CRM para criar o modelo no Gerenciador do WhatsApp, esperar a aprovação e voltar para clicar em "Sincronizar". Quem usa o canal de parceiro já fazia isso pela tela.

Agora a aba de Modelos do canal oficial tem "Criar modelo", e cada modelo tem "Editar" e "Apagar". O formulário é o mesmo do canal de parceiro: categoria, cabeçalho com imagem enviada do computador, corpo, rodapé e botões. O modelo criado ou editado volta para revisão e aparece na lista como pendente. Apagar pede confirmação e, se o modelo estiver em uso num follow-up ou num agente, mostra onde antes de apagar. Apagar é definitivo na conta do WhatsApp. Criar, editar e apagar exigem o papel de administrador.

Quando a conta do WhatsApp não tem a permissão de gerenciar modelos (`whatsapp_business_management`), a tela diz qual permissão falta, em vez de um erro genérico. Conexão sem conta ou sem token gravado recebe o pedido de reconectar o número. O botão "Sincronizar" continua igual. Nenhuma migração de banco é necessária e nada muda na VPS.

Crédito: @webtecnica.
