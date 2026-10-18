# Guia: o agente responde com os dados do seu site (banco externo e receitas prontas)

Para quem **não programa**: dono de imobiliária, de loja ou de revenda de carros, com um
site WordPress ou um sistema que guarda os dados num banco MySQL. Este guia leva do zero
até o agente respondendo no WhatsApp, por exemplo "tenho 2 apartamentos de 2 quartos na
Asa Norte até 600 mil", com foto, e jogando o cliente interessado no seu funil.

Os nomes de tela daqui foram conferidos contra o código em 18/10/2026. Se a sua tela
estiver diferente, a sua versão é outra: confira a versão instalada.

## 1. O que é, e o que NÃO é

- **É:** o agente de IA consulta, na hora, os dados que já existem no seu site (imóveis,
  produtos, carros) para responder ao cliente com informação atual.
- **Não é:** uma cópia dos seus dados dentro do CRM. Nada é importado em massa.
- **Só lê.** O CRM nunca grava, altera ou apaga nada no seu banco. Mesmo assim, o acesso
  que você entrega a ele deve ser **somente leitura** (passo 2): é um cinto e um
  suspensório.
- **Só vê o que você liberar** (passo 3). O que não estiver marcado, o agente não enxerga.
- Funciona com **MySQL**. MariaDB não foi medido.

## 2. O que pedir ao técnico (ou à hospedagem)

Mande esta lista para quem cuida do seu site ou da hospedagem:

1. **Um usuário de banco SOMENTE LEITURA**, só com as tabelas necessárias (não o banco
   inteiro e nunca o usuário principal do site).
2. Que o banco **aceite conexões de fora**, vindas do servidor do CRM. Em muitas
   hospedagens compartilhadas isso fica numa tela chamada "MySQL remoto" ou "Hosts
   remotos": o técnico sabe. Se o servidor do CRM tem IP fixo, o ideal é liberar só ele.
3. Que ele te devolva estes dados:
   - **Endereço (host)** do banco, por exemplo `meusite.com.br` ou um IP;
   - **Porta**, quase sempre `3306`;
   - **Nome do banco**;
   - **Usuário** e **senha** do acesso de leitura;
   - **Prefixo das tabelas** (só WordPress): é o começo do nome das tabelas, quase sempre
     `wp_` (as tabelas se chamam `wp_posts`, `wp_postmeta`...). Em alguns sites é outro,
     como `abc_`.

### Comando para o técnico copiar

O técnico executa isto no banco do site. Troque os nomes em MAIÚSCULAS. O exemplo é o da
receita **WordPress com ACF ou WooCommerce** (prefixo `wp_`):

```sql
CREATE USER 'crm_leitura'@'%' IDENTIFIED BY 'TROQUE_POR_UMA_SENHA_FORTE';

GRANT SELECT ON NOME_DO_BANCO.wp_posts    TO 'crm_leitura'@'%';
GRANT SELECT ON NOME_DO_BANCO.wp_postmeta TO 'crm_leitura'@'%';
```

Quais tabelas liberar depende da receita que você vai usar:

| Receita | Tabelas que o usuário precisa ler |
|---|---|
| WooCommerce (loja) | `PREFIXO_posts`, `PREFIXO_postmeta` |
| ACF imóveis | `PREFIXO_posts`, `PREFIXO_postmeta` |
| JetEngine imóveis | `PREFIXO_jet_cct_SLUG` (a tabela do tipo de conteúdo) e, se a foto vier pelo número do anexo, também `PREFIXO_posts` |
| Tabela direta (ex.: carros) | só a tabela, por exemplo `carros` |

Exemplo para uma **tabela direta** de carros:

```sql
CREATE USER 'crm_leitura'@'%' IDENTIFIED BY 'TROQUE_POR_UMA_SENHA_FORTE';
GRANT SELECT ON NOME_DO_BANCO.carros TO 'crm_leitura'@'%';
```

Regras que o técnico deve seguir:

- **Nunca** `GRANT ALL`, nem `GRANT ... ON NOME_DO_BANCO.*`. Isso libera também a tabela
  de senhas do site.
- Se ele souber o IP do servidor do CRM, trocar o `%` por esse IP.
- A senha é forte e não é usada em nenhum outro lugar.

O CRM também mostra um passo a passo na tela, no quadro **Como criar um acesso só de
leitura (guia rápido)**. Ele ensina a criar uma *view* (tabela virtual); para as receitas
deste guia, o `GRANT SELECT` direto nas tabelas acima basta.

### O aviso de privilégio

Ao testar a conexão, o CRM confere o que o usuário consegue fazer. Se aparecer um aviso
amarelo, o teste **passou**, mas há algo a corrigir. As frases são estas:

- *"Este usuário do banco pode escrever. Crie um usuário só de leitura (apenas SELECT)
  para o assistente."* O usuário tem permissão de gravar. Peça ao técnico um usuário
  novo, só com `SELECT`.
- *"Este usuário lê o banco inteiro. Libere só as tabelas e views que o assistente deve
  ver."* Não é erro: lembra você de marcar só o necessário no passo 3. Melhor ainda é o
  técnico restringir o usuário.
- *"Não consegui conferir os papéis deste usuário. Confirme que ele só lê."* e
  *"Não consegui conferir os privilégios deste usuário. Confirme que ele só lê."* O CRM
  não conseguiu verificar sozinho. Peça ao técnico para confirmar que só existe `SELECT`.

## 3. Conectar o banco e liberar as tabelas

Só quem é **administrador da organização** consegue fazer estes passos.

> Se o item **Dados externos** não aparece no menu, o módulo está desligado na
> instalação. Quem administra o servidor liga em `/admin/sistema`.

1. No menu, abra **Organização** e, em **Dados e acesso**, clique em **Dados externos**.
2. Clique em **Conectar banco de dados** (se já existe alguma conexão, o botão se chama
   **Nova conexão**).
3. Preencha:
   - **Tipo de banco:** MySQL;
   - **Nome da conexão:** um nome seu, por exemplo "Site da imobiliária";
   - **Host**, **Porta**, **Banco de dados**, **Usuário**, **Senha**: os dados do passo 2;
   - **Segurança da conexão (TLS):** deixe como está, a menos que o técnico mande mudar;
   - **Cliente nas conversas** (**O que identifica o cliente** e **Nome da coluna**):
     serve para consultas sobre o próprio cliente (ex.: "meus pedidos"). Para vitrine de
     imóveis, produtos ou carros, que é o assunto deste guia, não é usado; preencha como
     o formulário pedir.
4. Clique em **Salvar**. A tela avisa *"Conexão criada. Agora escolha o que o assistente
   pode ler."*
5. Na lista, clique em **Testar**. O resultado esperado é *"Conexão bem-sucedida."* e o
   selo **Conectada** no cartão. Se der erro, veja o passo 9.
6. Se o teste passou numa conexão nova, a tela abre sozinha a conexão com o quadro
   **O que o assistente pode ver**. Se não abrir, clique em **Explorar** na conexão.
7. Em **O que o assistente pode ver**, deixe marcado **Só o que eu marcar
   (recomendado)** e marque **apenas as tabelas da sua receita** (tabela do passo 2).
   Evite **Tudo que o usuário do banco enxerga**.
8. Clique em **Salvar**. A tela confirma *"Lista salva. O assistente já usa a nova
   lista."*

Sem este passo, a receita não funciona: tabela não marcada é tabela que o agente não vê
(ver passo 9, "Tabela não liberada").

## 4. Escolher a receita certa

Na mesma página da conexão, desça até **Receitas prontas** e clique em **Adicionar
receita**. Cada receita só pode ser adicionada uma vez por conexão.

| Seu caso | Nome na tela | Observação |
|---|---|---|
| Loja WordPress com WooCommerce | **Produtos da loja WooCommerce** | Lê título, preço, SKU e estoque dos produtos publicados. |
| Imobiliária em WordPress com campos do plugin ACF | **Imóveis do WordPress com ACF** | Você diz qual campo é preço, quartos, bairro etc. |
| Imobiliária em WordPress com o plugin JetEngine | **Imóveis do WordPress com JetEngine** | **Ainda não testada numa instalação real** (passo 10). |
| Revenda de carros, ou qualquer sistema com uma tabela simples | **Tabela direta (qualquer tabela plana)** | Uma coluna para cada dado. Sem cruzar tabelas. |

### Como saber qual o seu site usa

- **WooCommerce:** o painel do WordPress tem o menu **WooCommerce** e você vende produtos.
- **ACF:** o painel tem o menu **Campos personalizados** (Advanced Custom Fields) e os
  imóveis são um tipo de conteúdo próprio com campos como preço e quartos.
- **JetEngine:** o painel tem o menu **JetEngine** e os imóveis ficam em "Custom Content
  Types".
- **Nenhum desses** (sistema próprio): use **Tabela direta** se os dados estão numa tabela
  simples, onde cada coluna é um dado (id, modelo, preço, ano).

Na dúvida, pergunte ao técnico: "meus imóveis estão em ACF, em JetEngine ou numa tabela
própria?". Ter mais de um plugin instalado ao mesmo tempo é comum (restos de uma troca
antiga): o botão **Sugerir campos** ajuda a descobrir qual deles tem dados de verdade.

## 5. Mapear os campos

Ao adicionar a receita, a tela abre um quadro de edição onde você diz **qual campo do seu
site é cada dado**. O botão **Sugerir campos** tenta preencher sozinho olhando o seu banco
(só leitura); ele **preenche apenas o que está vazio** e a palavra final é sua. Se não
achar nada, aparece um aviso e você digita à mão.

**Em todas as receitas:** **Rótulo** (nome para você reconhecer a receita) e
**Descrição**. O interruptor **Ativa** liga e desliga a receita sem apagá-la.

### Produtos da loja WooCommerce

Só o **Prefixo das tabelas** (padrão `wp_`). Os campos do WooCommerce são conhecidos.

### Imóveis do WordPress com ACF

- **Prefixo das tabelas:** `wp_` (ou o do seu site).
- **Tipo de post:** o nome interno do tipo de conteúdo dos imóveis, por padrão `imovel`.
  Ao editar um imóvel no painel, o endereço do navegador mostra `post_type=imovel`.
- **Mapeamento de campos (meta_key):** para cada dado, o nome interno do campo no ACF.
  Exemplo:

  | Dado | O que você digita |
  |---|---|
  | Preço | `preco` |
  | Quartos | `quartos` |
  | Bairro | `bairro` |
  | Cidade | `cidade` |
  | Área | `area` |

  O nome interno é o "Nome do campo" cadastrado no ACF. Clique em **Sugerir campos** para
  ele propor os que existem.

### Imóveis do WordPress com JetEngine

- **Prefixo das tabelas** e **Slug do CCT** (o nome interno do tipo de conteúdo, por
  exemplo `imoveis`; a tabela vira `wp_jet_cct_imoveis`).
- **Mapeamento de campos (coluna do CCT):** Título, Preço, Quartos, Bairro, Cidade e
  Área. Digite o nome da coluna de cada um (ex.: `preco`, `quartos`).

### Tabela direta (ex.: carros)

- **Tabela:** o nome da tabela, por exemplo `carros`.
- **Coluna ID**, **Coluna Título**, **Coluna Preço**, **Coluna Filtro Numérico**: o nome
  da coluna de cada dado. Exemplo para carros:

  | Campo da tela | Exemplo |
  |---|---|
  | Tabela | `carros` |
  | Coluna ID | `id` |
  | Coluna Título | `modelo` |
  | Coluna Preço | `preco` |
  | Coluna Filtro Numérico | `ano` |

Clique em **Salvar** para guardar a receita. A tela confirma com *"Salvo."*

## 6. Testar com a pré-visualização

Antes de deixar o agente usar, confira com os seus olhos:

1. Na receita salva, clique em **Pré-visualizar**.
2. A tela mostra **Pré-visualização (até 5 linhas)**, com quantas linhas vieram.
3. Confira se título, preço e bairro estão certos e no lugar certo.

Como interpretar:

- **Veio tudo certo:** vá para o passo 7.
- **Preço aparece errado, vazio ou zerado:** veja o passo 9, "Preço errado".
- **Veio uma mensagem de erro:** veja o passo 9.
- **Não veio nenhuma linha:** o site não tem item publicado nesse tipo de post, ou o nome
  do campo ou da coluna está diferente do que você digitou.

A pré-visualização é só para administradores e usa dados reais do seu banco.

## 7. Funil de destino: quem se interessa vira lead

Dentro da receita há o quadro **Funil de destino**:

1. Em **Funil**, escolha o funil onde o lead deve nascer.
2. Em **Etapa de destino**, escolha a etapa (o campo começa com **Escolha a etapa**).
   Etapas de ganho ou de perda não servem.
3. Clique em **Salvar**.

A tela explica: *"Quando o cliente demonstra interesse em um item, o lead nasce neste
funil e etapa."* Depois de salvo, a receita mostra **Leads vão para:** `Funil › Etapa`.

Como funciona na conversa:

- Quando o cliente diz que gostou de um item, o agente cria o lead naquele funil e etapa,
  com título, preço e uma referência do item na descrição, para o vendedor continuar de
  onde o robô parou.
- Se o mesmo cliente repetir interesse no **mesmo item** enquanto o lead está aberto, não
  nasce outro: entra uma nota "Interesse repetido". Se o lead anterior já foi ganho ou
  perdido, nasce um novo.
- O agente registra até **3 interesses diferentes por rodada** de conversa.
- **Sem funil de destino** (a opção **Sem funil de destino**; a tela diz "Sem funil de
  destino: interesse vira aviso na Central"), o lead **não** é criado. Em vez disso
  aparece um aviso na **Central** ("Interesse em item sem funil de destino"), apontando
  para o contato. Isso também acontece se o funil escolhido foi apagado, ou se a etapa
  exige campos que o cliente não informou.
- Contato bloqueado (pediu para parar) ou anonimizado não vira lead nem aviso.

## 8. Foto no WhatsApp

**De onde vem a foto:**

- **WooCommerce e ACF:** a **imagem destacada** do produto ou do imóvel no WordPress.
- **Tabela direta e JetEngine:** uma coluna de imagem da tabela (URL direta ou, no
  WordPress, o número do anexo). Na tela da receita, preencha **"Coluna da foto"**
  (tabela direta) ou **"Campo da foto"** (JetEngine); o campo é opcional, e o botão
  "Sugerir campos" tenta achar colunas chamadas `foto`, `imagem`, `image`, `thumbnail`,
  `img` ou `photo`. Sem ele, essas duas receitas respondem só com texto.

O agente manda **um item por mensagem**: foto com legenda (título, preço, bairro...). O
padrão é 2 itens por vez, e o limite de envios por conversa é 3.

**Por que às vezes sai só o texto, sem a foto.** A foto nunca derruba a mensagem: se algo
der errado, o texto sai e o motivo fica registrado. Os motivos:

- a foto é **grande demais** (mais de 5 MB);
- a foto **demorou demais** para baixar (mais de 8 segundos);
- a foto não é **JPG, PNG ou WebP**;
- o endereço da foto é **interno** (rede privada, `localhost`, IP interno): por segurança,
  o CRM só baixa foto de endereço público da internet;
- o endereço da foto não responde, ou a foto foi apagada do site.

Dica: fotos de até 1 MB e site no ar com endereço público (`https://`).

## 9. Problemas comuns

As mensagens abaixo são as que aparecem na tela.

**"A coluna "X" não existe na tabela. Confira o mapeamento."**
O nome do campo ou da coluna que você digitou não existe no banco. Corrija o
**Mapeamento de campos** ou a **Coluna ...** (maiúsculas e minúsculas contam), ou use
**Sugerir campos**, e pré-visualize de novo.

**"Uma tabela da receita não foi liberada pelo administrador desta conexão."**
O passo 3 ficou incompleto. Em **O que o assistente pode ver**, marque as tabelas da
receita (a de posts e a de metadados no WordPress; a de carros na Tabela direta) e clique
em **Salvar**. Se a tela mostra *"Falta escolher o que o assistente pode ler. Até lá, ele
não enxerga nada deste banco."*, nada foi marcado ainda.

**"Não foi possível conectar." (no teste da conexão)**
O CRM não chegou ao banco. Em alguns casos a tela mostra no lugar a mensagem técnica do
servidor (por exemplo, "connect ECONNREFUSED"): passe-a ao técnico. Confira, nesta ordem:
endereço e porta; usuário e senha; se a hospedagem **aceita conexão de fora** (pedido 2
do passo 2) e se o IP do CRM está liberado; se o **TLS** está certo. O selo **Falha no
último teste** fica no cartão até um teste passar.

**"Não foi possível consultar o banco de origem agora."**
O banco ficou fora do ar no momento ou demorou demais. Tente de novo; se persistir, clique
em **Testar** na conexão.

**Aviso amarelo sobre o usuário do banco**
Veja "O aviso de privilégio", no passo 2.

**O preço aparece errado (na pré-visualização ou na conversa)**
A receita ACF entende estes formatos de preço guardado no site: `650.000,00` (formato
brasileiro, com centavos), `480000`, `650000.50` e `1.200.000` (pontos de milhar, sem
centavos). Se o seu site guarda outra coisa (por exemplo `R$ 650.000` ou `650 mil`), a
leitura e o filtro de preço máximo podem falhar. O melhor remédio é o técnico deixar o
campo de preço só com números. Confira também se o **Preço** do mapeamento aponta para o
campo certo (às vezes há "preço" e "preço de entrada").

**A receita não aparece para o agente**
Confira o interruptor **Ativa**, se as tabelas estão marcadas (passo 3) e se o módulo de
banco externo está ligado.

## 10. O que ainda não está medido

Dito com honestidade, para você não ser surpreendido:

- **JetEngine numa instalação real.** A receita foi escrita pela documentação do
  JetEngine 3.x, mas **ainda não foi medida num WordPress com JetEngine de verdade**. Se
  você usa JetEngine, faça a pré-visualização com cuidado e avise se algo vier trocado.
- **Envio de foto num WhatsApp real.** Os limites (5 MB, 8 s, JPG/PNG/WebP) e a proteção
  contra endereço interno são verificados por teste automático, **mas o envio não foi
  provado num WhatsApp real**. A primeira foto para um cliente real é a prova que falta.
- **Quantos itens por mensagem é o ideal.** O padrão é 2 imóveis por vez; não se mediu
  ainda quanto o cliente gosta (ou se irrita).
- **Coluna da foto na Tabela direta e na JetEngine** ainda não tem campo na tela.
- **Taxonomias do WordPress** (categoria ou bairro cadastrados como "termo"): hoje o
  bairro precisa ser um campo comum.
- **MariaDB:** fora do que foi medido.
