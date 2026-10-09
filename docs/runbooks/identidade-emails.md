# Identidade dos e-mails

Inventário verificável: `rg -n 'sendEmail\(|sendMail\(|emails.send|resetPasswordForEmail|auth.resend|auth.signUp' app lib workers` (excluir testes para emissores ativos).

| Fluxo | Emissor | Contexto de marca |
| --- | --- | --- |
| Convite de equipe, reenvio e criação administrativa | `lib/auth/issue-invite.ts`, chamado por `lib/team/convites.ts` e criação de organização | Organização de destino, resolvida por `marcaDaSaida(organizationId)` |
| Convites do onboarding | `app/actions/onboarding/sendOnboardingInvites.ts` | Organização do contexto autenticado |
| Exportação LGPD | `workers/lgpd-export-worker.ts` → `lib/lgpd/email-delivery.ts` | Organização da solicitação; o PDF preserva o controlador e não recebe marca |
| Alarme de prazo LGPD | `lib/lgpd/sla-alarm.ts` | Organização da solicitação |
| Confirmação de cadastro | `app/actions/auth/signUp.ts`, incluindo `lib/auth/convite-no-gotrue.ts` | SMTP Auth: instalação. Com Send Email Hook ativo: organização de convite validado ou instalação sem convite |
| Recuperação de senha | `app/actions/auth/requestPasswordReset.ts` | Instalação: formulário público não identifica organização |
| Magic link, convite nativo Auth, troca de e-mail, reautenticação | Supabase Auth, conforme funcionalidades/configuração do projeto | Instalação; não confundir convite Auth com convite de equipe do CRM |
| Avisos de senha, e-mail, telefone, vínculo/desvínculo de identidade, inclusão/remoção de MFA | Supabase Auth, se habilitados no projeto | Instalação; exportar modelos NÃO habilita os avisos |
| Orçamento de IA | `lib/email/templates/ai-budget-alarm.tsx` | Modelo sem emissor ativo; recebe marca explícita. Aviso atual é na Central, não e-mail |

Convites/LGPD usam `lib/email/roteador.ts`: SMTP configurado tem prioridade, senão Resend. O endereço remetente é o domínio verificado da instalação, o **nome exibido** vem da marca resolvida. Não se troca domínio SMTP por organização sem verificar esse domínio. A resolução consulta apenas a organização recebida; campos ausentes herdam a instalação, nunca outra organização. Nome/logo/cor vêm de `organizations.settings.branding` → `platform_branding` → ambiente → padrão. Estrutura compartilhada: `lib/email/templates/estrutura.ts`, tabelas de apresentação, estilos inline, dimensões de logo e identidade textual quando imagens não carregam.

## Supabase Cloud e mudanças de marca

Fontes oficiais consultadas em 2026-10-01:
- https://supabase.com/docs/guides/auth/auth-email-templates
- https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook

Cloud guarda HTML e assuntos na configuração Auth. A Management API permite GET/PATCH em `/v1/projects/{ref}/config/auth`. As variáveis `GOTRUE_MAILER_TEMPLATES_*` com URL são opção de GoTrue próprio, não prova de sincronização no Cloud.

O app serve `/email-templates/config` com os 13 modelos e assuntos, resolvendo a marca **do banco**, sem configuração SMTP nem segredos. Para exportar/aplicar, após implantar a revisão:

```sh
python3 scripts/email/sincronizar-auth.py \
  --app-url https://SEU_APP --project-ref SEU_REF \
  --diretorio /CAMINHO_PRIVADO/exportacao-nova
```

Inspecione os HTMLs. Para aplicar, use outro diretório novo e acrescente `--aplicar --token-file /CAMINHO_PRIVADO/token-management` (arquivo 0600 contendo apenas o token). O script verifica identidade do projeto e Site URL; salva `antes.json` dos campos afetados **antes** do PATCH; modifica somente assuntos/corpos; relê e compara todos os campos. SMTP, URLs e habilitação de notificações ficam preservados. Não imprime respostas Auth nem credenciais. Falha de releitura exige investigar e, se necessário, restaurar os campos de `antes.json` via mesma API/painel; não reenviar mensagens reais para testar.

**Não há agendamento automático nesta entrega.** Repita a aplicação após mudar a marca. Sem token Management API, exporte os HTMLs e aplique-os em Authentication → Email Templates após copiar os valores anteriores. Token OAuth do MCP e service-role **não** substituem token Management API.

Um token com permissões específicas precisa de **Project → Project Settings: Read-write** e **Application services → Auth Config: Read-write**, restrito ao projeto de destino. Analytics Config é outra capacidade. A API de atualização Auth exige ambas as permissões; leitura bem-sucedida sozinha não comprova permissão de escrita. Referência: https://supabase.com/docs/reference/api/v1-update-auth-service-config.

### Envio dinâmico Auth (opcional, exige prova antes de ativar)

O modelo global Cloud não distingue organizações. No modo SMTP global, a confirmação de uma conta criada por convite usa a instalação. A alternativa oficial é **Send Email Hook**, que substitui o envio SMTP do Auth. O endpoint `POST /api/v1/webhooks/auth-email` valida Standard Webhooks no corpo bruto e timestamp (janela de cinco minutos), limita tamanho/envios e usa os mesmos modelos e transporte SMTP/Resend do CRM. `AUTH_EMAIL_HOOK_SECRET` vazio recusa o endpoint e mantém o funcionamento existente do projeto.

Para signup, somente convite HMAC válido, não expirado, com e-mail igual ao destinatário identifica organização. Metadados editáveis de organização, domínio do destinatário e primeiro vínculo não são fontes de contexto. Recuperação e avisos públicos usam instalação, inclusive quando a conta tem convite antigo nos metadados. A marca é consultada a cada envio. Isso dispensa atualizar HTML Cloud após mudanças de marca **somente quando o hook está ativado e comprovado**; a exportação estática continua como alternativa e rollback.

Os 13 tipos estão cobertos. Troca segura envia `token_hash_new` ao endereço atual e `token_hash` ao novo; troca não segura envia somente ao novo. O aviso de alteração de e-mail vai ao endereço **anterior**, seguindo o envio nativo. O payload atual de desvinculação de identidade não contém o destinatário original da identidade removida; usa `user.email`, limite conhecido também documentado no código do Supabase (`internal/api/mail.go`). Não inferir endereço por outro vínculo.

Recibos no Redis distinguem ocupado/concluído por evento, corpo e índice do destinatário. Uma retentativa do segundo destinatário não duplica o primeiro concluído. Redis indisponível impede envio, sem fallback em memória. Recibos concluídos duram 24h; reserva em andamento dura dez minutos. O Redis do compose padrão é efêmero: reinício pode perder recibos. Nenhum recibo torna SMTP exatamente uma vez: queda após aceitação pelo provedor e antes de concluir o recibo deixa resultado incerto. Não prometer entrega exatamente uma vez; investigar a auditoria/provedor antes de reenvio manual.

Ativação:

1. Publicar a revisão e conferir o endpoint recusando pedidos sem assinatura. Confirmar SMTP/Resend do CRM e Redis; a configuração SMTP do Supabase sozinha não configura o transporte do app.
2. Salvar backup privado dos campos `hook_send_email_enabled`, `hook_send_email_uri` e `hook_send_email_secrets`, e do ambiente afetado. Não exibir os segredos.
3. Gerar segredo dedicado Standard Webhooks, armazenar fora do Git e cadastrar `AUTH_EMAIL_HOOK_SECRET` pelo mecanismo de configuração da instalação. No painel Supabase Authentication → Hooks, selecionar Send Email e URL HTTPS deste endpoint com o mesmo segredo. Manter Email Provider habilitado e as configurações SMTP preservadas.
4. Provar com endereço controlado: signup por convite e confirmação, recuperação, marca de instalação e organização, alteração de marca seguida de envio novo. Prova local não substitui entrega real Cloud.
5. Reversão: desabilitar Send Email Hook (ou restaurar os três campos do backup). O SMTP Auth volta a enviar usando o catálogo estático já conferido. Não mudar senhas ou URLs para reverter.

Auditoria `auth.email_sent`/`auth.email_delivery_failed` aparece nos painéis de auditoria já existentes; guarda somente tipo, transporte e índice, sem destinatário, OTP, hash de acesso, corpo ou assinatura. Falha retorna 503 para o Auth, que informa erro ao formulário; o operador consulta Auditoria e configura SMTP em administração. Continuidade IA/humano não se aplica. Entrada=hook Supabase assinado; saída=transporte e destinatário; configuração=Hooks Supabase/Marca/SMTP; próximo passo=falha visível e correção/reenvio controlado; retorno=recibo evita repetir efeito concluído. Mapa: `docs/architecture/marca-propria.architecture.json`. Destino: núcleo opcional, sem dependência paga nova nem alteração de schema.

## Aceite, testes e continuidade

Links da página de convite → cadastro ou login → confirmação/aceite → organização indicada pelo token assinado. O cadastro não deve provisionar organização quando existe convite; guardas continuam em `signUp`, `decidirConviteDoSignup` e `aplicarConvite`. Convite inválido não concede vínculo. `member.invited`/`member.accepted` alimentam auditoria; pendências/reenvio ficam em Equipe. Falha de SMTP deixa link e motivo acessíveis. Marca se configura em Marca da organização e Marca da instalação. O registro desta mudança é núcleo (identidade/acesso comuns a todos), sem nova tabela ou worker. Continuidade IA↔humano não é aplicável a autenticação.

Medir: testes de caminho de acesso, `branding-saida`, templates e transporte; `invite-lifecycle` em Supabase local com contas sintéticas; confirmação/recuperação em caixa capturadora. Conferir o destino e contagem de organizações antes/depois. Não abrir links reais de terceiros. Screenshot em Chromium prova aparência web, não renderização real no Outlook/Gmail/Apple Mail: documentar esse limite.
