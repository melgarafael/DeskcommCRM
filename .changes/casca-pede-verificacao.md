---
impacto: nada_mudou
secao: corrigido
titulo: As telas pedem a verificação em duas etapas a quem já a tem cadastrada
---
Quem tem a verificação em duas etapas cadastrada passa a ser levado à tela do código ao abrir o CRM, o assistente de configuração inicial ou o painel da plataforma, como o login já faz, e volta para a página onde estava depois de digitar o código. Vale com a exigência ligada ou desligada em Configurações › Segurança. Quem não cadastrou a verificação não vê nada diferente. Na API da administração da plataforma (`/api/v1/admin/*`), a leitura (GET) passa a exigir a mesma confirmação na sessão de quem tem a verificação cadastrada, como a escrita já exigia. A resposta, na leitura e na escrita, é `403` com o código `mfa_required` — também quando a exigência da plataforma está ligada, caso em que vinha `forbidden`. Quem não é administrador da plataforma segue recebendo `forbidden`. Nada a fazer na atualização.
