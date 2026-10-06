# Oracle Ampere A1 — instalação ARM64 sem build na VPS

Este roteiro é para uma instalação **nova**, com Ubuntu e `VM.Standard.A1.Flex`,
**2 OCPU / 12 GB** em uma instância. A franquia Always Free de A1 é **total**
por tenancy (2 OCPU e 12 GB equivalentes), não 12 GB adicionais para cada
instância. `VM.Standard.A2.Flex` é outro shape: não trate A2 como Always Free.
Confirme elegibilidade, região e disponibilidade no [guia atual da Oracle](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
antes de criar a VM. Uma instância pode hospedar mais de um projeto, mas este
roteiro usa um único dono de Compose para este CRM. 12 GB são uma escolha de
capacidade, não uma medição de consumo do CRM com IA, WAHA e Supabase juntos.

## 1. VM, acesso e rede

No Console OCI, abra **Compute → Instances → Create instance** na região
principal da conta. Escolha imagem **Ubuntu** marcada como Always Free elegível,
shape **Ampere VM.Standard.A1.Flex**, 2 OCPU e 12 GB, subnet pública com IPv4
público e autenticação por **sua chave SSH**. Revise o resumo/custo antes de
confirmar; falta de capacidade A1 na região não é falha do CRM. Não cole uma
chave privada em chat ou repositório. No VCN, configure
Security List ou NSG **e** confira o firewall do Ubuntu (`sudo ufw status`):

| Entrada | Quando | Origem recomendada |
|---|---|---|
| 22/TCP | SSH | somente seu IP |
| 80/TCP, 443/TCP | HTTPS/validação do certificado | Internet |
| 7881/UDP | voz WaCalls, se habilitada | somente o necessário ao provedor |
| 5060/UDP, 10000–10200/UDP | SIP e mídia RTP, se habilitada | IPs do provedor sempre que possível |

Não exponha Postgres, Supabase Studio, Redis ou ARI à Internet. Regras do VCN
e do firewall local são camadas distintas. Configure DNS `A` do domínio para
o IPv4 público antes da instalação e confirme que 80/443 estão livres. Não
abra portas opcionais até escolher e testar a modalidade de voz.

## 2. Código e pré-voo

Use uma **release numérica publicada** `vX.Y.Z` cujo kit já inclua este roteiro;
troque esse marcador pela versão real antes de executar. `stable` é um canal
móvel e `latest` aponta para o topo da `main`, não para a última release.
No servidor, clone a origem/fork que vai manter e selecione a tag:

```bash
git clone https://github.com/melgarafael/DeskcommCRM.git crm
cd crm
git fetch --tags
git checkout vX.Y.Z
uname -m  # esperado: aarch64
bash ubuntu-production-installer.sh --domain crm.seudominio.com.br
```

O instalador instala/prepara Docker se necessário; **depois dessa preparação**,
valida a arquitetura `linux/arm64` antes de criar `.env`, runtime Supabase,
banco ou contêineres do produto, e verifica o manifesto das **quatro**
imagens do CRM (`app`, `worker`, `scheduler`, `voice-agent`), a WAHA efetiva e,
no modo single-server, **todas** as imagens do Supabase fixado. Não faz build
na VM nem usa emulação x86. Se um pacote estiver privado, ausente ou sem ARM64,
pare; não force `--platform=linux/amd64` nem substitua WAHA Plus/customizada
automaticamente. O instalador single-server pede o domínio e gera credenciais
locais; guarde-as em lugar privado. A IA inicia desativada e é configurada
depois pela interface.

Confira `docker compose -f docker-compose.prod.yml --env-file .env ps`,
`bash hostgator-setup-kit/healthcheck.sh` e o domínio em um navegador. Um
healthcheck interno verde não prova que o site público, IA ou telefone funciona.

## 3. Atualização, versão anterior e restauração

Um commit/push no GitHub **não é deploy automático**: é preciso publicar a
release/imagens por um workflow configurado e, na VPS, executar a atualização
deliberadamente. Não modifique clientes antes de validar nova release e backup.
Em instalação antiga, rode primeiro o pré-voo somente-leitura da nova tag,
obtida de clone separado da mesma origem. Ele não muda banco, contêineres,
volumes ou `.env`:

```bash
CHECK_DIR="$(mktemp -d)"
git clone --depth 1 --branch vX.Y.Z https://github.com/melgarafael/DeskcommCRM.git "$CHECK_DIR"
bash "$CHECK_DIR/hostgator-setup-kit/preflight-upgrade.sh" --installation /caminho/real/crm --to vX.Y.Z
cd /caminho/real/crm
bash hostgator-setup-kit/backup.sh
bash hostgator-setup-kit/update.sh --to vX.Y.Z
```

Se a sonda falhar, **não rode o updater antigo**. No kit novo, a atualização
também sonda ARM64 antes de backup, checkout ou banco. Não confunda a
branch local de segurança do código com backup dos dados. `backup.sh` salva
banco/sessões WAHA e, no modo single-server, anexos; transfira as cópias para
fora da VM e controle acesso. Para **ensaiar** restauração, use uma instalação
isolada de teste com os arquivos emparelhados, sem apontar para produção:

```bash
bash hostgator-setup-kit/restore.sh backups/db-AAAAmmdd-HHMMSS.sql.gz
```

`restore.sh` **sobrescreve** o banco-alvo e pode substituir sessões WAHA e
anexos. Não execute na produção só para verificar. Downgrade de código sobre
banco migrado pode não ser seguro; plano de retorno exige prova de restauração.

## 4. Voz opcional

O profile `voz` (WaCalls) é opcional e independente do atendimento por texto.
A sonda de imagem e o boot do voice-agent não comprovam chamada, áudio,
webhook, custo nem qualidade.

## 5. Registro de aceite — não confundir manifesto com operação

Só marque “aprovado” com evidência da **VM Oracle real** e sua configuração,
sem incluir tokens, números completos ou dados de clientes nos registros.

| Jornada | Estado inicial | Evidência mínima |
|---|---|---|
| Site/onboarding no navegador | não executado | HTTPS, login, UI sem erro, versão da imagem |
| IA: UI + ferramenta direta | não executado | mesmo texto cru, resposta e erro comparados |
| Supabase/Auth/RLS | não executado | login e isolamento entre organizações de teste |
| WhatsApp texto/mídia/restart | não executado | envio/recebimento, anexo e sessão persistente |
| WaCalls | não executado | chamada real com áudio bidirecional e encerramento |
| Backup/restore isolado | não executado | banco, WAHA e anexos restaurados em ambiente separado |
| CPU/RAM/disco | não executado | `docker stats --no-stream`, `free -h`, `df -h` sob uso representativo |

Uma imagem com manifesto ARM64 passa apenas no critério de **distribuição**.
Este trabalho de código não cria VM, não altera VPS de cliente e não atesta
essas jornadas externas.
