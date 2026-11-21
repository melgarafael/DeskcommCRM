---
impacto: capacidade_nova
secao: adicionado
titulo: Conectar o canal oficial pelo Facebook, com coexistência com o app WhatsApp Business
---
Em Admin › Meta você informa o App ID e o Config ID do app Meta da sua instalação. Com isso, a tela do canal oficial ganha o botão "Conectar pelo Facebook" (Embedded Signup): o cliente autoriza a conta e o número pelo fluxo da Meta, sem copiar token e IDs na mão. O número também pode continuar no app WhatsApp Business do celular, em coexistência com o CRM. Para a coexistência, o app Meta precisa ter os campos de webhook account_update, history, smb_app_state_sync e smb_message_echoes ativos, e o cliente precisa do app WhatsApp Business 2.24.17 ou mais novo. Nada muda para quem não preencher o App ID e o Config ID. A importação do histórico de conversas não faz parte desta versão. Referente à issue #4074.
