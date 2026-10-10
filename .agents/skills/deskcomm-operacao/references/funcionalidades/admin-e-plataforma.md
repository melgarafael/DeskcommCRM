# Funcionalidades — Administração e plataforma

O que há aqui: telas de /admin e o que só o dono da VPS vê ou configura.
Extraído do CHANGELOG até a 1.79.0 e conferido contra o menu e o código em 2026-10-10.
O menu e o código mandam sobre este arquivo; para ver o que mudou depois, use
`bash scripts/buscar.sh <palavra>` (a pasta é a da skill).

### Administração → Cadastro

- **Cadastro avisa modo pendente** — A tela avisa quando a troca de modo ainda não chegou ao cadastro do Supabase. _(desde 1.51.0)_
- **Cadastro com aprovação** — Com a chave ligada, conta nova vira pedido para aprovar ou recusar na tela. _(desde 1.43.0)_
- **Cadastro só com convite** — Interruptor fecha o signup com tela própria e trava as quatro portas. _(desde 1.25.0)_

### Administração → Configuração

- **Config do servidor na tela** — Modo administrador troca e-mail, remetente, suporte e DPO sem SSH. _(desde 1.40.0)_

### Administração → Destinos internos

- **Destinos internos liberados** — Tela libera IP e faixa da rede local só para o que a instalação configura. _(desde 1.37.0)_

### Administração → E-mail

- **E-mail pelo servidor próprio** — Tela liga SMTP com teste; vazio mantém o caminho anterior sem mudar nada. (chave Resend e remetente unificados aqui na 1.42.0). _(desde 1.38.0)_

### Administração → Extensões

- **Extensões no admin** — Painel mostra de onde vêm, quais estão instaladas e em quantas empresas. _(desde 1.42.0)_

### Administração → Google

- **Google pela tela** — Admin cadastra ID e chave com retorno pronto e troca cifrada. _(desde 1.8.0)_

### Administração → Marca

- **CSS próprio na Marca** — A Marca da instalação aceita CSS cosmético validado, com escape sem CSS. _(desde 1.71.0)_
- **Ícone do app na Marca** — O ícone da instalação vale na aba e no app instalado, sem reiniciar nada. _(desde 1.60.0)_
- **Ícone da aba na Marca** — Campo novo sobe o favicon quadrado que vale na hora em todas as telas. _(desde 1.58.0)_
- **Logo por tema da marca** — A marca aceita imagem para o escuro sem moldura branca; remover não apaga a outra. _(desde 1.48.0)_
- **Marca pela tela** — Dono troca nome, cor e logo com prévia; empresa tem a sua própria. _(desde 1.4.0)_
- **Marca fora da tela** — Ícone, autenticador, remetente e e-mails seguem a marca; PDF não leva. Onde: Administração → Marca → resto. _(desde 1.4.0)_

### Administração → Meta

- **App da Meta sem SSH** — Tela cadastra chave e gera token de verificação com reserva no arquivo. _(desde 1.26.0)_

### Administração → Modo Plataforma

- **Tema no Modo Plataforma** — A tarja ganha troca de claro, escuro e sistema com atalho de teclado. Onde: Administração → Modo Plataforma → tema. _(desde 1.54.0)_

### Administração → Sistema
- **Cobrança pelo Asaas** — Opcional: em Conexão, escolha Asaas e cole a chave de API para cobrar com Pix e boleto todo mês (pagos a cada cobrança, não é débito automático); atraso, suspensão e reativação funcionam como na Stripe. Assinaturas existentes ficam no provedor em que nasceram. Onde: Administração → Cobrança → Conexão. _(desde 1.79.0)_
- **Cobrança dos seus clientes** — Opcional e desligada: ligue em Recursos opcionais, conecte a Stripe em Administração › Cobrança e crie os planos. Empresa nova ganha teste grátis; pagamento atrasado gera aviso na Central, faixa no topo e e-mail, e suspensão depois da tolerância (5 a 30 dias, padrão 7, com aviso final 48 horas antes); paga, volta sozinha. O menu Billing da empresa passa a se chamar Plano e cobrança. Os limites por plano chegam travados: nenhuma empresa tem teto ainda. Onde: Administração → Cobrança. _(desde 1.78.0)_
- **Módulos guardam informação própria** — Um módulo de nicho declara as fichas que guarda e o servidor cria as tabelas, isoladas por empresa; a informação aparece na ficha do contato. O catálogo oficial ainda não publica módulo desse tipo. _(desde 1.78.0)_
- **Rota global do webhook do WhatsApp só da rede interna** — Quem roda o WAHA em outro servidor precisa apontar o webhook para o endereço com o token do canal; quem usa o WAHA da instalação não faz nada. _(desde 1.78.0)_

- **Sinal de assinatura no Sistema** — O Admin Sistema diz se as entregas do WhatsApp chegam assinadas nos últimos 7 dias. _(desde 1.75.0)_
- **Comportamento da instalação** — Quatro chaves saem do arquivo para a tela com piso no .env e auditoria. _(desde 1.38.0)_

### Administração → Uso + Tenants

- **Agente por cliente visível** — Uso ganha coluna e cada cliente ganha aba Agente com versão e modelo. _(desde 1.24.0)_

### Administração → acompanhar organização

- **Editar cadastro e excluir tenant pela tela** — O administrador da plataforma edita o cadastro, corrige o e-mail de acesso (a troca avisa a Central da empresa e o endereço antigo) e exclui o tenant. A exclusão só vale para tenant suspenso pelo administrador (nunca por falta de pagamento) e sem assinatura ativa, pede motivo e confirmação, fica na auditoria e confere a assinatura com o provedor de cobrança na hora — se o provedor não responder, nada é apagado, basta tentar de novo. Exige acesso completo à plataforma e a verificação em duas etapas. Onde: Administração → Tenants → painel do tenant. _(desde 1.79.0)_
- **Acompanhar com prazo** — Administração abre a empresa com identidade real, edição ou leitura e banner. _(desde 1.17.0)_

### Administração → criar organização

- **Criar empresa entrega tudo** — Nova empresa já vem com admin, convite copiável e recibo idempotente. _(desde 1.17.0)_

### Atualização → página de manutenção

- **Aviso de atualização** — Durante a troca aparece Estamos atualizando e a tela volta sozinha. _(desde 1.39.0)_

### Docs: runbook do painel

- **Painel com passo a passo** — Documentação oficial cobre instalar com painel ocupando as portas. _(desde 1.4.0)_

### Guias (.agents/skills)

- **Guias nos CLIs de IA** — Cinco guias carregam sozinhos no Codex, Cursor e afins. _(desde 1.19.0)_

### Guias: scripts/instalar-guias.sh

- **Guias fora do clone** — Um comando liga os guias nos CLIs; rodar de novo atualiza, com remoção. _(desde 1.30.0)_

### Imagens publicadas (ghcr)

- **Imagem pronta publicada** — VPS baixa e roda sem compilar nada na máquina. _(desde 1.0.0)_

### Kit de instalação

- **Instalação em VPS ARM64** — O instalador atende ARM64 com imagens nativas; nada é compilado na VPS. _(desde 1.65.0)_
- **Instalador em espanhol** — O install.sh pergunta o idioma e grava DESKCOMM_IDIOMA_CLI no .env. _(desde 1.52.0)_

### Kit: agente de atualização

- **Agente fixado sozinho** — Agente de atualização trava a versão solta em minutos sem mexer no manual. _(desde 1.4.0)_

### Kit: baseline.sql

- **Banco que se conserta** — Baseline reaplica sozinho sem quebrar clone com dado antigo. _(desde 1.0.0)_

### Kit: desinstalar_docker.sh

- **Desinstalar sem resto** — Script remove só containers, volumes e redes do projeto com confirmação. _(desde 1.39.0)_

### Kit: docker-compose.npm.yml

- **Atrás de NPM sobrevive** — REVERSE_PROXY=npm mantém o app na rede certa em toda atualização. _(desde 1.21.0)_

### Kit: install.sh

- **Banco na VPS sem expor as chaves** — A instalação com o banco na própria VPS deixa de mostrar as chaves do banco na tela; a saída completa fica em `.runtime/supabase-setup.log`, só para o root. Instalações existentes não mudam. _(desde 1.79.0)_
- **Banco na VPS atrás do Coolify** — Instalação com o banco na própria VPS passa a funcionar atrás do proxy do Coolify, com passo a passo medido em `docs/saas/coolify.md`. Quem instala sem as variáveis novas não vê mudança. _(desde 1.79.0)_
- **Instalação com um comando** — Script sobe app, WhatsApp e banco com diagnóstico junto. _(desde 1.0.0)_

### Kit: install.sh pergunta IA

- **Instalador pergunta a IA** — Pergunta provedor e valida a chave na hora em vez de falhar depois. _(desde 1.2.0)_

### Kit: scripts de operação

- **Oito rotinas de cuidado** — Instalar, atualizar, backup, restore, senha, MFA, saúde e ajuda. _(desde 1.0.0)_

### Kit: ubuntu-local-installer.sh

- **Instalação local na máquina** — Script sobe tudo local com comandos de dia a dia para avaliar o produto. _(desde 1.43.0)_

### Kit: ubuntu-production-installer.sh

- **Instalação com Supabase junto** — Modo opcional instala o banco na VPS com script e backup de anexos. _(desde 1.43.0)_

### Kit: update.sh e restore.sh

- **Barra e backup seguro** — Navegação mostra progresso; update para sem backup e restore traz sessões. _(desde 1.23.0)_

### Kit: update.sh fixa versão

- **Update trava na publicada** — Script recusa anterior, grava imagem e dispensa compose solto. _(desde 1.1.0)_

### Moldes /email-templates + GoTrue

- **E-mails no Supabase próprio** — Moldes servidos pelo app com marca; kit ensina e mede o GoTrue. _(desde 1.19.0)_

### Primeiro acesso → montar funcionário

- **Primeiro acesso monta tudo** — Seis passos com funcionário, ramo, teste de chave e conversa de prova. _(desde 1.4.0)_

### Primeiro acesso → telefone

- **Primeiro acesso pergunta** — Passo do telefone oferece código, conta oficial ou parceiro antes de criar. _(desde 1.4.1)_

### Rotina data-retention

- **Banco se limpa sozinho** — Eventos, fila e auditoria expurgam sozinhos com pisos e sem dono tocado. _(desde 1.4.0)_

### Rotinas agendadas (event_log)

- **Fila sem HTTP no banco** — Evento espera em tabela e rotina agendada drena sem pressa. _(desde 1.0.0)_

### Outros

- **Página inicial pública** — O endereço abre sem login com marca, privacidade e termos; o domínio passa a responder 200. _(desde 1.77.0)_
