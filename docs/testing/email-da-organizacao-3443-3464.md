# Conta de e-mail da organização e diagnóstico do domínio

Trabalho de @webtecnica nos #3443 e #3464, trazido pelo #3560. Refs #3287 e #3441.

## Contrato

Em Configurações › Marca, quem administra a empresa conecta a conta Resend dela, com um From verificado para envio. A linha em Configurações › Recursos opcionais leva até lá. A conexão usa `fromAddress`, a mesma régua do envio, e exige uma chave com permissão de consultar domínios (Full Access). O servidor resolve tenant, papel, suporte somente leitura e MFA; o navegador não escolhe organização nem o domínio consultado. A chave fica cifrada em tabela própria, sem policies e sem privilégios do navegador, e a tela recebe só From e last4. Erro de banco na conexão ou na desconexão não volta em texto bruto.

Só a AUSÊNCIA de linha permite o envio da automação cair no transporte da instalação. Falha de leitura, de cifra ou de dados interrompe a saída com o motivo `conta_de_email_indisponivel`, sem trocar o remetente. E-mail de sistema (convite, senha, LGPD) continua no roteador da instalação.

O diagnóstico parte do From conectado e dos registros oficiais da mesma conta, com Return-Path personalizado e TXT/MX/CNAME, e separa registro ausente de consulta inconclusiva. O estado verificado na Resend e o DNS observado aparecem separados. Nenhum dos dois promete entrega na caixa de entrada.

## O que foi medido, e em qual árvore

**Merge com a main `4d5305a8d` (07/11/2026), na vps-teste:**

- `pnpm test:db`: install e update do baseline combinado, 609 arquivos, 4.893 casos passando, 1 falha esperada e 1 pulado. Inclui `conta-resend-da-organizacao-e-server-side` e o registro em `PROVA_PROPRIA` de `rls-completude-varredura`.
- `pnpm test:shell`: verde.
- Tipos: a CLI do Supabase 2.122.0, sobre o baseline combinado, gera para `organization_resend_accounts` exatamente o bloco que está em `lib/database.types.ts`. O arquivo não foi regenerado inteiro: a geração completa difere da main em 44 objetos que não são deste PR (o arquivo da main está atrás do baseline).
- `pnpm typecheck` inteiro morreu no teto de 6 GB de heap da VPS (exit 134), como a main. O typecheck dirigido, com `tsconfig.typecheck.json` restrito aos arquivos tocados, passou sem erro (3.516 arquivos alcançados). O inteiro fica com o `verify` do CI.

**Banco real, fonte `86e09872c` (27/10/2026).** PostgreSQL 17 limitado a 1 GiB e 1 CPU, com `ON_ERROR_STOP=1` nos dois modos: install e update deram 15 casos passando cada um. Como controle, `GRANT ALL` ao `service_role` no molde reprovou exatamente os 2 casos de ACL e de TRUNCATE, com os outros 13 passando. A fixture de banco usa bytes artificiais: ela prova formato opaco, ACL e RLS, não AES. Testes de unidade separados cifram e decifram com a implementação real.

**CI, head `d531c6ebe` (27/10/2026).** A jornada da spec `conta-resend-da-organizacao.spec.ts` passou em 53,2 s na parte 2, e os invariantes próprios passaram em Postgres 15 e 17. O check `invariants` reprovou só pela falta do registro em `PROVA_PROPRIA`, autorizado no doc 223 e aplicado depois. Esse CI não vale para heads posteriores.

**Transporte.** SDK real 6.33 enviou HTTP a um receiver local com chaves e destinatários sintéticos: From, To, Reply-To, corpo e hash do Authorization distintos por tenant. A main hoje declara `resend` ^6.35.0, então o CI do head é quem exercita a versão canônica.

## Limites

- Não há prova de entrega paga, de caixa postal nem de conta Resend real. É de propósito: sem envio pago e sem chave de produção.
- A cifra de produção não é medida pela fixture de banco.
- Conta ilegível não ganha alerta visual próprio: a tela segue mostrando a conta como configurada, porque a projeção segura não decifra. O motivo aparece na aba Atividade da regra.
- A linha em Recursos opcionais não lê o estado da conta. Mostra "Veja na tela dele", como as demais chaves que moram na tela do assunto.
- SMTP próprio por organização não faz parte desta entrega.

## Como a jornada roda no CI

A spec está na parte 2, que é semeada. O dublê `scripts/duble-saas-e2e.mjs` fica de pé na porta 3997 pelo job inteiro e atende tanto a SDK da plataforma quanto a da organização; só a parte 2 publica `RESEND_BASE_URL`. A parte 4 segue sem chave, com os mesmos serviços. Recibos guardam só o SHA256 do Authorization. PNG e recibo só são escritos depois de todas as assertivas e do cleanup.

Ela percorre: menu até Marca; From inválido sem HTTP; quatro recusas próprias sem gravar; conexão e recarga sem a chave; DNS ausente separado de verified; ação `send_email` real com banco e receiver; cifra ilegível sem fallback; dois tenants do mesmo admin; desconexão que conserva a vizinha.
