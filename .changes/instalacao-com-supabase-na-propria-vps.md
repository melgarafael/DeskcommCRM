---
impacto: capacidade_nova
secao: adicionado
titulo: Um segundo jeito de instalar, com o banco (Supabase) dentro da própria VPS
---

O kit ganhou um modo de instalação **opcional** em que ele mesmo instala e opera o
Supabase **na VPS do cliente**, ao lado do CRM. Não é preciso abrir conta no
Supabase nem colar chave nenhuma: o instalador pergunta só o domínio. Na VPS, dentro
da pasta do repositório clonado:

```bash
bash ubuntu-production-installer.sh --domain crm.suaempresa.com.br
```

O que vale saber antes de escolher este modo:

- **Memória:** o banco passa a rodar na mesma máquina. O mínimo continua sendo uma
  VPS de 4 GB (a mesma régua do instalador comum), mas o **recomendado são 8 GB**.
- **Backup:** o `backup.sh` passa a guardar também os **arquivos anexados** (fotos e
  documentos), que nesse modo moram no disco da VPS, e o `restore.sh` os devolve
  junto com o banco. Se os anexos não puderem ser salvos, o backup falha em vez de
  dizer "concluído".
- **E-mail de acesso:** "esqueci a senha" e a confirmação de cadastro saem pelo
  **SMTP que você configura no CRM** (tela `/admin/email`). Sem SMTP, esses e-mails
  não são enviados, e o instalador avisa isso no fim. Depois de configurar o SMTP,
  rode `bash hostgator-setup-kit/update.sh` para o login passar a usá-lo.
- **Atualização:** o `update.sh` também leva o Supabase desta VPS até a versão que o
  kit fixa, sem apagar dados.
- **Mais de uma instalação na mesma VPS:** o banco ganha nomes próprios, e uma
  segunda cópia do CRM na mesma máquina é recusada em vez de mexer no banco da
  primeira.

Quem já instalou com o Supabase na nuvem (ou num Supabase próprio) **não é afetado**:
nada muda no comportamento do instalador comum, do backup ou da atualização.
