---
title: Runbook — Banco de dados externo, para quem não programa
status: rascunho
last_review: 2026-10-22
owner: Paulo Lima Jr (contribuição)
---

# Runbook — Banco de dados externo, para quem não programa

> Guia para o dono de uma imobiliária, de uma loja ou de uma agência com um site em WordPress
> (com WooCommerce, ACF ou JetEngine). Você liga o banco do site ao CRM para o agente de IA do
> WhatsApp mostrar os itens do site (imóveis, produtos) e abrir um negócio no funil quando o
> cliente se interessar.
>
> Os nomes de tela estão entre aspas e foram copiados do sistema. Os exemplos são fictícios.

---

## 1. O que isto faz, em 5 linhas

1. O cliente pergunta no WhatsApp: "tem apartamento de 3 quartos até 700 mil?".
2. O agente consulta o banco do site ao vivo e mostra os imóveis que batem com o pedido, com preço, código e link.
3. Quando o cliente diz "tenho interesse nesse", o agente abre um negócio no funil que você escolheu, com a referência do imóvel.
4. Se você não escolheu um funil, o agente passa a conversa para a sua equipe, pela "Central de avisos".
5. Só leitura: o agente **nunca escreve no banco do site**.

> Quantos itens o agente mostra por resposta ainda não foi medido; o exemplo de instrução da seção 9
> pede "até três". Fotos: nesta versão **nenhuma receita traz a foto** do item (seção 12).

---

## 2. Antes de começar

Tenha em mãos os dados de conexão do banco MySQL do site. O formulário pede:

| O que o formulário pede | O que colocar |
|---|---|
| "Tipo de banco" | **MySQL**. O padrão é PostgreSQL, e as receitas prontas só existem para MySQL. |
| "Nome da conexão" | Um nome para você reconhecer, por exemplo "Imóveis do site". |
| "Host" | O endereço do servidor do banco, por exemplo `meusistema.com`. |
| "Porta" | `3306` no MySQL (o formulário sugere sozinho ao trocar para MySQL). |
| "Banco de dados" | O nome do banco do site. |
| "Usuário" e "Senha" | Um usuário **só de leitura** (veja abaixo). |
| "Segurança da conexão (TLS)" | Deixe o padrão, "Obrigatório (padrão)". |

Pontos que valem antes de criar a conexão:

- **Acesso só de leitura.** O formulário pede um usuário que só tenha `SELECT`: "No MySQL, conecte com um usuário só de leitura (apenas SELECT)." Quem administra o banco cria esse usuário. O guia da própria tela se chama "Como criar um acesso só de leitura (guia rápido)".
- **Não use o usuário principal do site.** O sistema avisa, depois do teste, se o usuário pode escrever ou lê o banco inteiro (seção 11).
- **Quem cria a conexão é o administrador da organização.** Os demais usuários só leem.
- **A senha é guardada cifrada** e nunca volta a aparecer na tela: "A senha é cifrada antes de gravar e nunca é mostrada de volta."
- **Os campos "Cliente nas conversas" e "Limites de leitura" são opcionais.** Pode deixar como estão.

---

## 3. Passo 1 — Ligar o módulo (quem administra o servidor)

Esta etapa é do administrador da **instalação**, não do administrador da empresa. O módulo vem desligado de fábrica.

1. Abra **Admin › Sistema** (a página `/admin/sistema`).
2. Localize o cartão **"Módulos opcionais"**.
3. Na linha **"Banco de dados externo"**, ligue o interruptor.

Enquanto o módulo estiver desligado, a entrada **"Dados externos"** não aparece em Configurações, a tela da conexão não abre, e o agente não recebe as ferramentas de banco. O texto da própria tela diz: "Ligado, cada empresa pode conectar o banco de outro sistema (um ERP, outro CRM) para o agente consultar."

---

## 4. Passo 2 — Conectar o banco do site

1. Abra **Configurações** (no rodapé do menu), procure a seção **"Dados e acesso"** e clique em **"Dados externos"**. Ela não aparece no menu lateral.
2. Clique em **"Conectar banco de dados"** (ou em **"Nova conexão"**, se já houver uma).
3. Preencha o formulário, campo a campo, na ordem da tela:
   1. **"Tipo de banco"**: MySQL.
   2. **"Nome da conexão"**.
   3. **"Host"** e **"Porta"**.
   4. **"Banco de dados"**.
   5. **"Usuário"** e **"Senha"**.
   6. **"Segurança da conexão (TLS)"**: deixe "Obrigatório (padrão)".
   7. **"Conexão ativa"**: deixe ligada.
4. Clique em **"Salvar"**. A tela responde: "Conexão criada. Agora escolha o que o assistente pode ler." e abre a tela da conexão.
5. Volte à lista de **"Dados externos"** e clique em **"Testar"** na linha da conexão. Se der certo, a tela mostra "Conexão bem-sucedida.". Se der errado, mostra "Não foi possível conectar." e o erro aparece no cartão da conexão.

Se o teste passar com um aviso amarelo, leia a seção 11. O teste foi aprovado, mas há algo a corrigir no usuário do banco.

---

## 5. Passo 3 — Liberar as tabelas que o agente pode ler

**Nada vem liberado sozinho.** Uma conexão nova nasce sem nenhuma tabela liberada. Enquanto você não marcar, o agente não enxerga nada desse banco.

Na tela da conexão, o cartão **"O que o assistente pode ver"** tem dois modos:

- **"Só o que eu marcar (recomendado)"**: o agente vê só o que você marcar.
- **"Tudo que o usuário do banco enxerga"**: o agente vê tudo. A tela avisa: "Se houver dados sensíveis (senhas, chaves), crie no banco um usuário de leitura só com o que ele precisa, ou volte para 'Só o que eu marcar'."

Use **"Só o que eu marcar (recomendado)"**. Depois marque as tabelas que as receitas precisam (a lista está na seção 6, em cada receita) e clique em **"Salvar"**.

Enquanto nada estiver marcado, a tela mostra: "Falta escolher o que o assistente pode ler. Até lá, ele não enxerga nada deste banco."

**Atenção ao guia de acesso.** A tela de conexão sugere criar uma *view* (uma tabela virtual) e liberar só ela. Isso **não serve para as receitas prontas**: as receitas leem as tabelas do WordPress pelo nome (`wp_posts`, `wp_postmeta`). Peça ao administrador do banco um usuário só de leitura com permissão de `SELECT` nessas tabelas, e marque-as no painel.

---

## 6. Passo 4 — Escolher a receita

A receita é o modelo pronto de consulta. Ela só aparece em conexões **MySQL**.

1. Na tela da conexão, no cartão **"Receitas prontas"**, clique em **"Adicionar receita"**.
2. Escolha uma opção em **"Qual receita você quer usar?"**. Você pode cadastrar mais de uma receita na mesma conexão (por exemplo, imóveis e veículos).
3. Preencha a receita e clique em **"Salvar"**.
4. Antes de liberar para o agente, clique em **"Pré-visualizar"**. A prévia mostra até 5 linhas do banco, para você conferir sem o WhatsApp.

As três receitas que existem hoje:

### 6.1 Produtos da loja WooCommerce

- **Para quem serve:** loja com WooCommerce, para os produtos publicados.
- **Resumo na tela:** "Os produtos publicados da loja: título, preço, SKU e estoque."
- **O que o agente pode buscar:** termos (por exemplo, "boné"), preço máximo, "só em estoque" e a ordem ("recentes" para os últimos cadastrados).
- **Prefixo das tabelas:** o que aparece antes de `posts` no banco (padrão `wp_`).
- **Tabelas que precisam estar liberadas:** `wp_posts` e `wp_postmeta` (com o prefixo do seu site).
- **Exemplo fictício:** uma loja de bonés. O cliente pede "boné preto até 80 reais, só em estoque". O agente responde com os modelos que batem com o pedido.

### 6.2 Conteúdo do WordPress (qualquer tipo de post)

- **Para quem serve:** qualquer tipo de conteúdo de um site WordPress: imóveis, veículos, cursos, cardápio. Funciona com o plugin ACF ou com o JetEngine (no modo de tipo de post).
- **Resumo na tela:** "Qualquer conteúdo de um site WordPress: imóveis, veículos, cursos, eventos, cardápio. O administrador diz o tipo de post e de onde vem cada dado."
- **O que você preenche:**
  1. **"Tipo de post"**: o nome do tipo de post do seu site (por exemplo, `imovel`).
  2. **"Começar de um modelo"**: o botão **"Imóveis"** preenche a tela com campos de imóvel. O botão **"Em branco"** começa do zero. Trocar de modelo apaga o que você digitou, e a tela pede confirmação.
  3. **"Campos do site"**: cada dado que o site guarda, com **"Rótulo"** (como o cliente vai ler), **"Campo no site"** (o nome do campo no ACF ou no JetEngine), **"Tipo"** (Texto, Número ou Preço) e **"Filtro"** (Nenhum, Contém, Igual, Mínimo ou Máximo).
  4. **"Categorias do site"**: bairro, cidade, tipo ou finalidade, que o WordPress guarda como categoria. Cada uma tem **"Categoria no site"** (a taxonomia) e **"Nível"** ("Qualquer", "Tem categoria acima" ou "Não tem categoria acima").
  5. **"Esconder itens"**: um campo e os valores que somem para o cliente, por exemplo o campo de situação com o valor "vendido".
- **Tabelas que precisam estar liberadas:** `wp_posts` e `wp_postmeta`. Se houver categoria mapeada, também `wp_terms`, `wp_term_taxonomy` e `wp_term_relationships`.
- **Exemplo fictício:** uma imobiliária de Sorocaba. O cliente pede "apartamento de 3 quartos até 700 mil". O campo "Quartos" tem filtro **Mínimo**, o campo "Preço de venda" tem filtro **Máximo**, e a categoria "Bairro" tem filtro **Contém**. O imóvel vendido some porque o campo de situação esconde o valor "vendido".

**Regras da receita de conteúdo WordPress, depois de montar:**

- Um filtro que não está mapeado não é aplicado. Se o dado do imóvel não está mapeado, a busca não filtra por ele.
- A finalidade por categoria casa por igualdade: o termo tem de se chamar exatamente "Venda" ou "Aluguel" (ou ter esse slug). "Venda e Aluguel" não casa com nenhum dos dois.

### 6.3 Tabela direta (qualquer tabela plana)

- **Para quem serve:** uma tabela comum do banco, em que cada linha é um item e cada coluna é um dado. Serve também para os tipos de conteúdo próprio do JetEngine (CCT).
- **Resumo na tela:** "Qualquer tabela plana do banco externo: uma linha por item, uma coluna por dado. O administrador diz a tabela, a coluna do id e a do título, e mapeia cada dado."
- **O que você preenche:** **"Tabela"**, **"Coluna do id"**, **"Coluna do título"**, depois os dados (**"Coluna na tabela"**, **"Tipo"**, **"Filtro"**), e opcionalmente **"Só mostrar quando"** e **"Esconder quando"**.
- **Modelo JetEngine:** o botão **"JetEngine — tipo de conteúdo próprio (CCT)"** preenche a tabela `wp_jet_cct_imovel`, com `_ID` como id e `titulo` como título. Os nomes das colunas são sugestão: o seu site pode ter outros. Confira antes de salvar.
- **Tabela que precisa estar liberada:** só a tabela informada.
- **Exemplo fictício:** em "Só mostrar quando", coluna `cct_status`, valor `publish`, para mostrar só os imóveis publicados.

> No modelo JetEngine a tela sugere a coluna **"Só mostrar quando"** com `cct_status = publish`. Ela só aparece como sugestão do modelo; confirme no seu banco.

---

## 7. Passo 5 — Dizer para onde vai o interesse

No cartão da receita, a seção **"Para onde vai o interesse do cliente"** tem dois campos:

- **"Funil do interesse"**: o funil onde o negócio nasce. A primeira opção é **"Sem funil (passar para a equipe)"**.
- **"Etapa do interesse"**: a etapa do funil. Etapas de ganho e de perda não aparecem, porque o interesse nasce em andamento.

A tela explica: "Quando o cliente se interessar por um item, o agente abre o negócio neste funil e etapa. Sem escolha, ele passa a conversa para a equipe." Se você escolheu o funil mas não a etapa, aparece o aviso: "Falta escolher a etapa: sem ela, o interesse continua indo para a equipe."

Crie o funil antes, no menu **"Funis"**, com o botão "Novo funil" (ou "Criar meu primeiro funil"). Se o funil não existir, a lista fica vazia.

**Sem escolha:** o agente não abre negócio sozinho. Ele chama **"Chamar um atendente humano"** e a conversa aparece na **"Central de avisos"** para a sua equipe.

**Com escolha:** o agente cria o negócio no funil e na etapa escolhidos, com a referência do item (por exemplo, `wordpress-conteudo:4821`). Essa referência fica na descrição do negócio e em um campo próprio.

- **Mesmo cliente, mesmo item:** se o cliente repetir o interesse no mesmo item e o negócio ainda estiver aberto, **não** nasce outro negócio. O sistema devolve o que já existe e deixa uma nota na linha do tempo: "O cliente voltou a demonstrar interesse em" seguido da referência.
- **Negócio já ganho ou perdido:** não impede um novo interesse.

> O funil escolhido tem de estar entre os funis que o agente pode mexer (seção 8). Se não estiver, o sistema recusa a criação do negócio e a tela **não avisa** isso hoje. Veja a seção 11.

---

## 8. Passo 6 — Dar ao agente as capacidades certas

Na tela do agente, abra a aba **"Configuração"**, papel **"Conversa com o cliente"**, card **"O que o agente pode fazer"**. Ali as capacidades vêm agrupadas em pacotes, com um interruptor por pacote, e o agente aceita no máximo 27 capacidades. Todo agente novo já nasce com **"Vender e mover o funil"** ligado. Se você ligar o pacote inteiro **"Organizar a operação"** ou **"Passar para um humano"**, passa desse limite e a tela recusa. Por isso, clique em **"Escolher uma a uma (modo avançado)"** e marque, uma por uma, as capacidades abaixo. A aba **"Capacidades"** só mostra o uso de cada uma depois de ligada.

| Capacidade (nome na tela) | Para que serve | Pacote onde ela mora |
|---|---|---|
| "Ver as tabelas do banco conectado" | Descobre o código da conexão, que o agente precisa para listar as receitas. | "Organizar a operação" |
| "Consultar receitas prontas do banco conectado" | Lista as receitas da conexão e executa a busca. | "Organizar a operação" |
| "Criar oportunidade no funil" | Abre o negócio quando o cliente se interessa. | "Vender e mover o funil" |
| "Chamar um atendente humano" | Passa a conversa para a equipe (quando não há funil de destino). | "Passar para um humano" |
| "Ver horários livres na agenda" e "Marcar consulta ou sessão" | Só se o agente for marcar visita. | "Vender e mover o funil" |

Pontos de atenção:

- **O funil de destino precisa estar liberado para o agente.** Na aba **"Configuração"**, no papel **"Organiza o sistema"**, o campo **"Em que negócios ele pode mexer"** lista os funis. Marque o funil que você escolheu na receita. Se não marcar, o agente não consegue criar o negócio. A tela não avisa isso hoje (a spec 25 registra como não medido na tela).
- **O código da conexão vem da ferramenta de descoberta.** Por isso a capacidade "Ver as tabelas do banco conectado" é necessária mesmo para a receita.
- Os nomes acima vêm do próprio sistema. Se a sua tela mostrar outro texto, siga o nome que aparecer.

---

## 9. Passo 7 — Ensinar o agente a conversar

Na aba **"Configuração"** do agente, no papel **"Conversa com o cliente"**, escreva as instruções. O campo aceita até 20.000 caracteres.

Exemplo para uma imobiliária (fictício, pode adaptar):

> Você atende clientes de uma imobiliária pelo WhatsApp, com educação e de forma objetiva.
>
> Quando o cliente pedir imóveis, consulte o catálogo do site antes de falar de qualquer imóvel. Nunca invente um imóvel, um preço ou uma foto.
>
> Mostre até três imóveis por resposta. Para cada um, escreva o código dele (cód. seguido do número), o preço, o bairro e o link.
>
> Quando o cliente disser que tem interesse em um imóvel desta lista, registre o interesse antes de responder. Só diga que registrou depois que o sistema confirmar.
>
> Se o cliente pedir algo que você não consegue resolver, ou quiser falar com uma pessoa, passe a conversa para a equipe.

Por que escrever o código junto de cada item: quando o cliente escolhe, o agente precisa do código na conversa. O resultado da busca anterior não fica disponível no turno seguinte. Sem o código, o agente pode consultar de novo, não achar, e dizer que registrou sem registrar. Foi o que aconteceu no ambiente de teste (seção 13).

---

## 10. Passo 8 — Testar com uma conversa de verdade

Antes de testar pelo WhatsApp:

1. Confira o funil e a etapa na receita (seção 7) e o campo "Em que negócios ele pode mexer" (seção 8).
2. Na aba **"Teste"** do agente, faça uma pergunta de teste para ver a resposta. Use **"Publicar v<número>"** quando a versão estiver pronta (o botão mostra o número da versão).
3. Use uma conta de WhatsApp de teste, que **não** seja de cliente real.

Roteiro de 5 mensagens, com o que conferir em cada uma:

| # | Mensagem do cliente | O que conferir |
|---|---|---|
| 1 | "procuro 3 quartos até 700 mil" | A resposta mostra imóveis com preço real do site, com código "cód.". Nenhum preço inventado. |
| 2 | "mostra de novo" | Os mesmos imóveis (ou outros que batem com o pedido), com código. Nada inventado. |
| 3 | "tenho interesse nesse" | Um negócio criado no funil e na etapa configurados, com a referência do imóvel (formato `wordpress-conteudo:<código>`). O agente só diz "registrado" depois do sistema confirmar. |
| 4 | "quero ver as fotos" | O agente diz o que pode fazer. Nesta versão, nenhuma receita traz a foto, então ele não pode mandar nenhuma. O que conferir: ele não inventa uma foto. |
| 5 | "posso visitar sábado?" | Se a capacidade de agenda estiver marcada, o agente consulta os horários. Se não estiver, ele não consegue marcar e deve passar para a equipe. |

Depois da mensagem 3, repita o interesse no **mesmo** imóvel (uma mensagem a mais, por exemplo "é esse mesmo"). O esperado: nenhum negócio novo, e uma nota na linha do tempo do negócio que já existe.

Onde conferir o negócio: no menu **"Funis"** (o quadro de cada funil), no funil e na etapa escolhidos.

---

## 11. Quando algo dá errado

As mensagens abaixo são as que o sistema devolve ao agente, ou os avisos que a tela mostra. O texto que o **cliente** lê depende do agente, que explica do jeito dele.

| O que você vê | O que significa | O que fazer |
|---|---|---|
| A entrada "Dados externos" não aparece em Configurações, ou a tela não abre (página não encontrada). | O módulo está desligado nesta instalação. | Peça ao administrador da instalação para ligar o interruptor "Banco de dados externo" em **Admin › Sistema**, cartão "Módulos opcionais". |
| O cartão "Receitas prontas" não aparece na conexão. | A conexão não é MySQL. As receitas só existem para MySQL. | Crie a conexão de novo com **"Tipo de banco"** = MySQL. O tipo não muda depois de criado. |
| "Não foi possível conectar." no teste. | O sistema não conseguiu entrar no banco. | Confira **"Host"**, **"Porta"**, **"Banco de dados"**, **"Usuário"** e **"Senha"**. |
| Aviso amarelo: "Este usuário do banco pode escrever. Crie um usuário só de leitura (apenas SELECT) para o assistente." | O usuário tem permissão de escrita. | Peça ao administrador do banco um usuário só de leitura e troque a conexão por esse usuário. |
| Aviso amarelo: "Este usuário lê o banco inteiro. Libere só as tabelas e views que o assistente deve ver." | O usuário enxerga o banco todo. | Marque só as tabelas necessárias em "O que o assistente pode ver" e mantenha "Só o que eu marcar (recomendado)". |
| "Falta escolher o que o assistente pode ler. Até lá, ele não enxerga nada deste banco." | Nenhuma tabela foi liberada. | Marque as tabelas no cartão "O que o assistente pode ver" e clique em "Salvar". |
| Mensagem ao agente: "uma tabela da receita não foi liberada pelo administrador desta conexão." | A receita pede uma tabela que não está liberada. | Libere as tabelas da receita (seção 6) e clique em "Salvar". |
| Mensagem ao agente: "não há receita ativa nesta conexão." | Nenhuma receita está ativa. (A mensagem cita "Integração de dados › Receitas prontas"; no menu, é "Dados externos".) | Abra a conexão e ative a receita ("Ativa"), ou crie uma em **"Adicionar receita"**. |
| Mensagem ao agente: "não foi possível abrir a conexão." | A conexão não abriu. Vale também quando o módulo está desligado (a ferramenta de receitas não mostra o motivo). | Confira se a conexão está ativa ("Conexão ativa") e se o módulo está ligado. |
| O interesse vai para a equipe, e não cai no funil. | Nenhum funil de destino está escolhido, ou o funil escolhido foi apagado ou arquivado. | Escolha o funil e a etapa na receita. Se o funil foi arquivado, escolha outro. Enquanto isso, a equipe recebe a conversa na **"Central de avisos"**. |
| O agente diz que registrou o interesse, e o negócio não aparece no funil. | Medido no ambiente de teste (seção 13). Causas possíveis: o funil não está em "Em que negócios ele pode mexer", ou o agente não tinha o código do item na conversa. | Confira, nesta ordem: (1) o funil está marcado em "Em que negócios ele pode mexer"; (2) o agente escreve "cód." junto de cada item; (3) o negócio no menu "Funis". Se nada disso resolver, passe a conversa para a equipe e avise o suporte. |

---

## 12. O que ainda NÃO faz

- **Só leitura.** O agente não escreve no banco do site. Nada que ele faz altera o banco de origem.
- **Não sugere campos sozinho.** Você mapeia cada campo e cada categoria na mão, ou usa um modelo como ponto de partida.
- **Não traz foto.** As três receitas não trazem o endereço da foto do item. O agente sabe enviar uma foto por endereço (jpg, png ou webp, de até 5 MB, por https), mas nenhuma receita fornece esse endereço ainda. Por isso, hoje, a resposta sai só com texto.
- **Não faz SQL livre.** Você não escreve consulta. Só usa as receitas prontas e os campos da tela.
- **Não lê outros tipos de banco.** Só MySQL. PostgreSQL não tem receitas prontas. MariaDB não está incluído.
- **O link do conteúdo pode estar antigo.** O link vem de um campo que o WordPress não atualiza quando o site muda de domínio. Se o site mudou de endereço, o link aponta para o antigo.
- **Base migrada com campo repetido.** Se o mesmo campo do site estiver gravado duas vezes no mesmo item, o item repete na lista. A receita não remove a repetição.
- **Sistemas próprios com relacionamento próprio não entram.** Se o seu sistema guarda os dados de um jeito artesanal, sem receita pronta, ele fica fora do que esta versão faz.

---

## 13. Medido na prática (22/10/2026)

Numa imobiliária montada do zero no ambiente de teste, o agente consultou o banco, mostrou os imóveis com código e, quando o cliente disse "tenho interesse", o negócio foi criado no funil e na etapa configurados, com a referência do imóvel — usando o modelo de IA `gpt-5.6-sol`. Com o modelo mais econômico `gpt-5.6-luna`, o agente não chamou a ferramenta de criar negócio e escreveu "já está registrado" sem registrar (4 tentativas). Por isso: para o atendimento que depende de abrir negócio sozinho, prefira um modelo mais forte e confira o funil depois das primeiras conversas.
