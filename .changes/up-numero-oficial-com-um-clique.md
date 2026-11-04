---
impacto: capacidade_nova
secao: adicionado
titulo: O número oficial do WhatsApp se conecta com um clique, sem conta no provedor
---

Quem administra a instalação pode cadastrar, uma vez, a chave da conta da instalação no
provedor parceiro em Painel › Configuração (ou na variável opcional
`ZERNIO_PLATFORM_API_KEY` do `.env`, que a tela vence). A partir daí, em Conexões › Provedor
parceiro, cada empresa vê o botão «Conectar meu WhatsApp»: abre a janela da Meta, a pessoa
entra com o Facebook da empresa, escolhe o número e confirma — inclusive um número que já
usa o app WhatsApp Business, que continua funcionando no celular. A empresa não precisa de
conta no provedor nem de configurar webhook: os eventos de todos esses números chegam por
UM webhook da instalação, registrado sozinho e filtrado aos perfis das empresas conectadas,
e cada empresa ganha no provedor um perfil com o nome da marca da instalação na frente.
Excluir a conexão desconecta o número da conta da instalação. Sem a chave, nada muda: a
tela segue oferecendo só a conexão por chave própria — que agora também registra o webhook
sozinha, sem nada para copiar. Crédito: @jmpo.
