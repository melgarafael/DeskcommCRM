# Eixo self-host — o valor traduzido em checagem

> Puxe no passe 2 quando o PR tocar schema, env, dependência, infra ou qualquer coisa que declare
> sucesso. Este eixo é **veto, não ponderação**: um PR pode ser tecnicamente impecável e reprovar
> aqui.

## O fato que gera todas as regras

A monetização do DeskcommCRM **não é assinatura**. É self-host em VPS, com a HostGator como parceira.
Quem instala numa VPS é o cliente que paga — e ele instala sozinho, sem ninguém olhando.

Duas consequências que mudam o que é "bom código" aqui:

1. **O instalador é o produto**, não um pré-requisito dele. Defeito de instalação é abandono, não
   ticket.
2. **O kit aplica só o `supabase/baseline.sql`.** Não aplica `supabase/migrations/`. Este único fato
   já responde metade das perguntas abaixo.

## As quatro perguntas

### 1. A mudança de schema chega no cliente?

Se o PR mexe em schema e foi **só** para `supabase/migrations/`, ela não chega — nem em instalação
nova (que aplica o baseline), nem em atualização (que re-aplica o baseline). **Bloqueador.**

O apêndice do baseline tem de ser **idempotente e auto-curativo**: `add column if not exists`,
`create ... if not exists`, `create or replace function`. E se a mudança adiciona constraint, os
dados existentes precisam ser corrigidos **antes** dela — senão o `update.sh` de um clone com dados
sujos quebra, e quebra na casa de alguém.

### 2. Instalação fresca continua funcionando?

Env var nova **required** sem default quebra o primeiro deploy. A pergunta não é "funciona na minha
máquina" — é "funciona numa máquina onde nenhuma variável opcional está preenchida".

Teste com os envs opcionais **ausentes**. É o estado real de um primeiro deploy, e é onde moram os
piores defeitos de primeira impressão. Já aconteceu: um convite por e-mail que nunca saía porque o
instalador não gravava a chave do provedor de e-mail no `.env`.

### 3. O modelo continua de pé?

Reprova, com explicação e sem drama:

- dependência de serviço pago **obrigatório** para a instalação funcionar;
- algo que só funcione na Vercel (ou em qualquer PaaS específico);
- feature que assuma SaaS multi-tenant hospedado por nós;
- aumento significativo de requisito de RAM/CPU sem justificativa — a VPS do cliente é pequena.

Nada disso é ruim em si. É incompatível com **este** modelo, e o motivo se explica em uma frase ao
contribuidor: *"aqui quem paga a conta da máquina é quem instala"*.

### 4. A sonda mede o caminho do usuário?

A **falha-em-verde**. Qualquer coisa que declare sucesso — `healthcheck`, mensagem final de script,
bolinha verde de conexão na tela — precisa medir o caminho que o usuário usa, não um caminho interno
conveniente.

Caso real: `Instalação concluída! Acesse: https://$DOMAIN` com o site inalcançável de fora, porque a
sonda rodava dentro do contêiner. A instalação "passava" quebrada.

Num produto self-host isto é a classe mais cara de defeito, porque não existe ninguém monitorando: o
cliente simplesmente conclui que o produto não funciona, e vai embora sem abrir issue.

## Como isso vira texto no veredito

Não trate o eixo como burocracia. O contribuidor quase sempre não sabe que ele existe — não está no
CONTRIBUTING de forma acionável. Explique o **porquê** junto com o pedido:

> "Isto precisa também ir para o `supabase/baseline.sql`. O motivo não é burocracia: o kit que instala
> numa VPS aplica só o baseline, então do jeito que está a sua correção não chegaria em nenhum
> usuário self-host — que é quem paga o projeto. Te mostro o formato: <link para exemplo>."

E se o eixo não estiver documentado no lugar onde ele olharia, **conserte a documentação no mesmo
movimento**. A regra do passe 10 vale aqui inteira: não se cobra alguém por regra que não foi contada.
