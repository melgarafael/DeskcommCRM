🇧🇷 Português · [🇺🇸 English](white-label.en.md)

# Instalar para clientes (agências e revendedores)

Guia para quem instala o SonghaiCRM **para outras empresas** — agência, consultoria, revendedor — e cobra por isso.

A licença é MIT: você pode modificar, hospedar para terceiros, revender e cobrar o que quiser. Não há royalty, não há cláusula proibindo hospedagem comercial e não existe versão paga que trave funcionalidade do seu cliente.

---

## Trocar a marca

**Pela tela, e sem reiniciar nada.** Em `/admin/marca` você troca o **nome do sistema** e a **cor da marca**. Salvou, recarregou, a interface inteira já está repintada — a barra lateral, os botões, o anel de foco, o título da aba e o ícone do navegador.

A cor é **derivada**, não aplicada crua: de um hex saem onze tons nos dois temas (claro e escuro), com um piso de contraste calculado por papel e por superfície. Se a cor que você escolheu ficaria ilegível como texto de botão no tema escuro, o sistema anda os degraus necessários e a tela **te mostra** em qual tom cada coisa vai pousar, antes de salvar. Nada de "escolhi amarelo e o botão ficou branco no branco".

**O logo também.** Na mesma tela você **sobe o arquivo** — PNG ou JPG, até 512 KB. Ele vai para o storage da sua própria instalação e passa a valer na hora, sem reiniciar nada e sem você hospedar imagem em lugar nenhum. Altura fixa e largura livre, para não distorcer arte de proporção qualquer; sem logo, o nome aparece como texto.

O arquivo é aceito **pelos bytes, não pela extensão**. Renomear um `.svg` para `.png` não engana: o sistema lê o conteúdo, recusa e diz por quê. Isso não é preciosismo — SVG é XML e pode carregar script, que executaria se alguém abrisse a imagem direto pelo endereço dela, num bucket que é público por necessidade.

Quem preferir hospedar por conta própria continua podendo, pelo `.env`:

```bash
APP_LOGO_URL=https://cdn.suaempresa.com.br/logo.svg
```

Entre os dois, **o arquivo subido pela tela vence a URL do `.env`** — quem subiu expressou a escolha mais recente. E remover o logo de uma organização **devolve o da instalação**, não "nenhum": as camadas caem uma na outra, em vez de apagar.

### As três variáveis do `.env`, e o papel real delas

```bash
APP_NAME=Vendas Turbo CRM
APP_LOGO_URL=https://cdn.suaempresa.com.br/logo.svg
APP_ACCENT_HEX=#7a5cd6
```

O `install.sh` pergunta **duas** delas e as grava: o `APP_NAME` (Enter mantém o padrão) e o `APP_ACCENT_HEX` (Enter usa a cor do sistema). `APP_LOGO_URL` ele não pergunta — o caminho normal do logo é subir o arquivo pela tela, e esta chave existe para quem prefere hospedar por conta própria.

> A cor é pedida com validador: só `#` + 6 dígitos passa. É mais estreito do que a tela aceita, e de propósito — os **e-mails de acesso** (confirmação de conta e recuperação de senha) leem essa chave do `.env`, e eles só reconhecem essa forma. Um `#abc` ou um `7a5cd6` pintaria a interface com a sua cor e deixaria o verde do produto no primeiro e-mail que o seu cliente abre.

> ⚠️ **Trocar a cor pela tela depois NÃO reescreve os e-mails de acesso.** O texto deles vive dentro do Supabase (GoTrue), não no CRM, e quem o empurra para lá é o `marca-emails.sh` — que lê o **`.env`**, não o banco. Para os e-mails acompanharem uma cor trocada em `/admin/marca`: ajuste também o `APP_ACCENT_HEX` no `.env` e rode `bash self-host-kit/marca-emails.sh`. É por isso que a entrevista do instalador importa: ela é o único momento em que as duas pontas nascem iguais sem ninguém precisar saber disso.

O que essas variáveis são, exatamente: **semente e piso de rollback.**

- **Semente** — na primeira leitura, o que estiver no `.env` é gravado no banco. É assim que uma instalação nova já nasce com o seu nome.
- **Piso de rollback** — se você voltar para uma versão anterior do sistema, o `agent.sh` reverte a **imagem**, não o **banco**. A marca que sobrevive a qualquer volta é a que está no `.env`.

Depois da primeira leitura, **o banco manda**. Trocar a cor pela tela não pede `docker compose up -d`, não pede reinício, não pede nada: a leitura é feita a cada carregamento, com um cache curto que a própria tela invalida ao salvar.

### Por que isso é configuração, e não uma edição de código

Trocar a marca editando os arquivos-fonte funciona **uma vez**. No próximo `bash update.sh`, a imagem nova sobrescreve o patch e a marca do seu cliente volta a ser a nossa — normalmente sem ninguém perceber, até o cliente ver.

Configuração sobrevive a toda atualização. É por isso que a marca é lida em tempo de execução e nunca embutida na compilação: **uma única imagem Docker serve qualquer marca**. Pela mesma razão não existe "imagem com a sua marca": o `update.sh` regrava a linha `APP_IMAGE` do `.env` em toda atualização, e a sua imagem seria substituída pela nossa em silêncio, numa atualização de rotina.

---

## Marca por organização

**Uma instalação atende várias organizações, e cada uma pode ter a própria marca.** O admin de cada organização abre `Configurações → Marca` (`/app/settings/marca`) e define **nome**, **cor** e **logo** dela — sem precisar de você, e sem enxergar as outras.

A fronteira, que é deliberada:

| Onde | Qual marca aparece |
|---|---|
| `/login`, cadastro, recuperação de senha, verificação em duas etapas | A da **instalação** (a sua) |
| Dentro do sistema (`/app/...`), depois de entrar | A da **organização**, se ela tiver; senão, a da instalação |
| E-mails de acesso (confirmação de conta, recuperação de senha) | A da **instalação** |
| Convite de time, e-mails de LGPD | A da **organização** que enviou |

O motivo de o login ficar de fora não é limitação: **antes de a pessoa entrar, o sistema não sabe de qual organização ela é.** Pintar o login com a cor de alguma delas seria escolher uma no escuro.

Isso não torna a instalação dedicada obsoleta — ver a comparação abaixo, que continua valendo por infra, isolamento e discurso de venda.

### O que ainda não é configurável

Sendo direto, para você não descobrir na frente do cliente. Cada linha traz a razão medida, não a desculpa:

- **Domínio por organização.** Uma instalação, um domínio. Não há coluna de domínio no schema, o desvio por host no `proxy.ts` é um NOOP declarado (existe só como documentação da topologia pretendida), e no Edge não há banco para consultar antes de decidir a quem aquele host pertence. Cliente que exige o próprio domínio pede **instalação dedicada**.
- **Fonte.** A tipografia é a mesma em toda instalação. `next/font` resolve em tempo de **build**, e a imagem que a sua VPS baixa já vem construída — um seletor de fonte no painel salvaria um valor que nada leria. (A fonte é a Atkinson Hyperlegible, escolhida pelo Braille Institute por legibilidade; trocá-la não muda percepção de marca e piora a leitura de quem passa o dia no sistema.)
- **Tema.** O par claro/escuro é do design system. A sua marca move o **accent** — o que é ação, destaque e foco —, e deliberadamente **não** move o fundo da página: o fundo é o mesmo em toda marca, e é por isso que a cor da barra do navegador também é.
- **O relatório de LGPD do titular não leva a sua marca — e isso é de propósito.** Ver a seção própria abaixo.
- **O alarme de orçamento de IA** ainda sai com a nossa marca. É o único vazamento conhecido, e ele fica: hoje esse alarme não tem agendamento nenhum ligado, então consertar a marca dele não mudaria nada que alguém veja. Sai quando o alarme ganhar cron de verdade.
- **Dois nomes técnicos não mudam**: o cabeçalho `X-Deskcomm-Signature` dos webhooks de saída e o cookie de sessão. O primeiro é contrato com sistemas de terceiros que já conferem esse nome; renomear derrubaria integração de cliente **em silêncio** — o receptor não dá erro, apenas deixa de reconhecer.

---

## Os e-mails

### Os e-mails de acesso — o primeiro artefato que o cliente do seu cliente recebe

Confirmação de conta e recuperação de senha **não são enviados pelo sistema**: quem os monta e dispara é o serviço de autenticação do Supabase. Nenhum código nosso roda ali dentro — é texto que precisa ser **empurrado** para lá por API.

Por isso o kit traz um script próprio:

```bash
bash self-host-kit/marca-emails.sh
```

Ele sobe o assunto e o corpo dos dois e-mails com o **seu** nome e a **sua** cor, e de quebra configura o endereço de retorno do link (que nenhum script configurava antes, e é pré-requisito do link funcionar). O `install.sh` o chama sozinho, logo depois de criar o projeto Supabase; o `update.sh` também o chama, para que uma instalação antiga receba isso na primeira atualização.

**Se ele não tiver a chave de acesso da API do Supabase** (`SUPABASE_ACCESS_TOKEN`), ele não falha e não derruba a instalação: imprime exatamente o que fazer à mão no painel do Supabase e sai com sucesso. Esse é o caso de quem criou o projeto pelo painel e colou as credenciais, em vez de deixar o instalador criá-lo.

> ⚠️ **Se for fazer à mão, atenção ao caractere.** O link do template precisa levar `&token_hash=`, com **`&`**, nunca `?`. Com `?` o endereço fica com dois pontos de interrogação, o sistema perde o token e o usuário cai numa tela dizendo que o link expirou — quando o problema é o template. Nesse caso o sistema agora **nomeia a causa** em vez de dizer só "link inválido".

### Convite de time e e-mails de LGPD

Saem com a marca da **organização** que os originou — porque quem processou a solicitação, no produto do seu cliente, é o sistema do seu cliente.

Para enviá-los, preencha as duas variáveis (o `install.sh` pergunta as duas):

```bash
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=nao-responda@suaempresa.com.br
```

**O endereço tem de ser de um domínio verificado na SUA conta Resend.** Esse é o único pedaço que a marca não resolve: o nome que aparece na caixa de entrada é a marca; o endereço é de quem hospeda.

**Deixar em branco é uma escolha suportada, não um defeito.** Sem elas, o sistema não tenta enviar e não falha calado: o convite mostra o link de aceite **na própria tela**, para você copiar e mandar por onde quiser, e o export de LGPD fica pendente de revisão em vez de sumir. Antes, um endereço em branco fazia todo envio falhar lá na Resend com uma mensagem opaca, e o operador ia caçar rede, contêiner e chave por causa de uma variável vazia.

### O endereço de suporte que os seus clientes veem

```bash
SUPPORT_EMAIL=suporte@suaempresa.com.br
```

Aparece nas telas de conta suspensa e de cobrança. **Vazio significa vazio:** a tela simplesmente não mostra endereço nenhum — nunca cai de volta no nosso. Numa tela de conta suspensa isso importa: quem suspendeu foi você, não nós.

---

## O relatório de LGPD é a única coisa que NÃO leva a sua marca

Quando um titular de dados exerce o direito do Art. 18 II, o sistema gera um relatório em PDF. Esse documento **não leva marca nenhuma** — nem a nossa, nem a sua, nem logo, nem cor. Ele nomeia o **controlador**: a razão social da organização, mais o encarregado (DPO).

Isso é decisão de produto, não item esquecido. Num documento que responde a um direito legal, quem é nomeado responde pelos dados. **Você é operador, não controlador.** Trocar o nome ali pela sua marca não seria "completar o whitelabel" — seria piorar: hoje o nome que aparecia era obviamente o do software, e depois pareceria a declaração de quem responde juridicamente pelos dados daquelas pessoas.

**O que isso te pede na instalação:** confira a **Razão social** de cada organização em `Configurações → Empresa`. Ela nasce igual ao nome fantasia (é o que o instalador tem para dar), e um nome fantasia impresso como razão social num documento jurídico é o tipo de erro que só aparece quando alguém reclama.

O e-mail que entrega o link do export é outra coisa e leva, sim, a marca da organização: ele diz quem **operou**. O PDF diz quem **responde**. São papéis diferentes, e é por isso que os dois carregam nomes diferentes.

---

## Um cliente por instalação, ou todos numa só?

O sistema é multi-tenant desde a primeira linha: uma instalação atende várias organizações, e o isolamento entre elas é verificado no CI a cada alteração — um usuário de uma organização não enxerga nenhuma linha de outra. Não é promessa de marketing: é o teste `tests/invariants/rls-isolation.test.ts`, que cria duas organizações e prova o não-vazamento pelo mesmo caminho de autenticação que a produção usa.

Mesmo assim, os dois modelos servem a propósitos diferentes:

| | Uma instalação por cliente | Uma instalação para todos |
|---|---|---|
| **Marca** | A de cada cliente, inclusive na tela de entrada | A sua no login; a de cada organização dentro do sistema |
| **Custo de infra** | Uma VPS por cliente | Uma VPS |
| **Falha** | Isolada | Atinge todos |
| **Atualização** | Uma por vez, pode escalonar | Todos de uma vez |
| **Dado do cliente** | Fisicamente separado | Separado por RLS |
| **Melhor para** | Revender com a marca do cliente | Sua própria operação atendendo várias contas |

Se o seu cliente pergunta "onde ficam meus dados?", a instalação dedicada tem a resposta mais simples de dar — e de defender.

---

## O argumento jurídico para cliente moçambicano

A base legal que o produto usa internamente (recibo de dados, PDF de exportação, política de privacidade padrão) é a **Lei n.º 3/2017** de Moçambique — não a LGPD brasileira. Os identificadores de código (`lgpd_*`, rotas `/lgpd`) ficam por herança técnica do template original; o que o titular de dados lê no documento é a lei moçambicana.

⚠️ **Não venda como "instalado em Moçambique = conformidade automática com a Lei n.º 3/2017".** Isso é tão falso quanto o equivalente brasileiro: conformidade depende de base legal, finalidade, segurança e direitos do titular — não só de onde o servidor está. O produto dá o mecanismo (exportação, anonimização, auditoria, encarregado de dados); a conformidade completa da operação do seu cliente é responsabilidade do próprio cliente.

Se o seu cliente é brasileiro (a base original do produto, ainda suportada), a mesma cautela vale para a LGPD: **Resolução CD/ANPD nº 19/2024** tornou obrigatórias cláusulas-padrão contratuais para **transferência internacional de dados pessoais** (prazo de adequação encerrado em 23 de agosto de 2025) — hospedar em VPS no Brasil evita essa transferência específica, mas não substitui a LGPD nem a Lei n.º 3/2017 como base legal declarada ao titular. Ajuste a política de privacidade e o PDF de exportação (`/legal/privacy`, `lib/lgpd/pdf-renderer.tsx`) para citar a lei realmente aplicável à instalação do seu cliente antes de vender para qualquer mercado.

---

## Operação

Cada instalação traz os scripts em `self-host-kit/`:

| Comando | O que faz |
|---|---|
| `bash update.sh` | Atualiza. Faz backup do banco **antes**, reaplica o schema de forma idempotente e confere a saúde no fim |
| `bash backup.sh` / `restore.sh` | Backup e restauração |
| `bash reset-password.sh` | Redefine a senha de um usuário |
| `bash reset-mfa.sh` | Remove a verificação em duas etapas de quem perdeu o aparelho |
| `bash healthcheck.sh` | Diagnóstico da instalação |

O `reset-mfa.sh` é o que você mais vai usar: a verificação em duas etapas é obrigatória para administradores, e trocar de celular sem salvar os códigos de recuperação é a chamada de suporte mais comum.

---

## Requisitos por instalação

**4 GB de RAM recomendados** (a stack sobe com 2 GB, mas opera no limite — o WAHA usa ~150 MB por sessão de WhatsApp), portas 80 e 443, Docker Compose v2 e um domínio com registro A apontando para o IP. A VPS não compila nada — baixa uma imagem pronta. O certificado HTTPS é emitido automaticamente no primeiro acesso.

Guia completo de instalação: [`self-host-kit/README.md`](../self-host-kit/README.md).

---

*Última atualização: 14 de agosto de 2026 — revisão completa depois do épico de marca própria. As duas frases mais citadas deste documento ("cores, fontes e tema não são configuráveis" e "a marca é por instalação, não por organização") deixaram de ser verdadeiras e foram reescritas com o limite honesto de hoje.*

*Este documento existe em três idiomas, e o pré-requisito que a versão anterior deste rodapé nomeava foi pago: as traduções carregam na primeira linha um selo com o hash do original, e editar `docs/white-label.md` sem re-selar reprova `pnpm test:unit`. Depois de traduzir, re-sele com `pnpm exec tsx scripts/selar-traducao.ts --todas`.*

*Os três READMEs ficaram **fora** do selo de propósito. São o arquivo mais editado do repositório: com selo, cada conserto viraria um PR bloqueado até ~490 linhas serem re-traduzidas duas vezes — e o desfecho realista disso não é tradução em dia, é alguém re-selar sem traduzir, que é o único jeito de o selo morrer. Eles entram quando alguém quiser pagar esse custo de olhos abertos.*
