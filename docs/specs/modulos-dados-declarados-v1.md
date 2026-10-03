# Spec — Módulo de dados declarados (classe `data`), onda 1

**Status:** proposta, dependente do aceite da [ADR-0005](../adr/0005-plataforma-de-modulos-de-terceiro.md).
**Medido em:** `efed1d574`.

> A onda 1 entrega o seguinte: um terceiro publica um **arquivo declarativo**, o administrador da
> instalação o instala, e aparecem no produto **tabelas reais, telas e ações de um nicho** — sem uma
> linha de código do terceiro executando em lugar nenhum, sem contêiner novo, sem egress, sem RAM
> adicional e com os dados dentro do backup do cliente.
>
> **Prova de aceite:** portar o módulo de honorários, que hoje é código no repositório, para um
> artefato declarado, **sem nenhum PR no Core**.

---

## 1. O que a onda 1 NÃO entrega

Dito antes do resto, porque a doutrina proíbe anunciar o que não existe:

- nenhum código de terceiro executa (isso é a classe `connected`, onda 2);
- nenhuma integração externa, credencial de terceiro ou webhook de provedor;
- nenhum envio de mensagem;
- nenhum gancho no caminho quente (ingestão, dreno, turno, envio);
- nenhuma vitrine pública nem cobrança (ondas 4);
- nenhuma avaliação, contagem de download ou telemetria.

---

## 2. O artefato

O mesmo pacote JSON estrito que já existe, com `profile: "data"`. Continua valendo: UTF-8, teto de
bytes, parser estrito, nenhuma chave desconhecida, nenhum `null`, licença declarada, e **nenhuma URL**
(o endereço vive no catálogo revisado — ADR-0003 D5).

O teto de 64 KiB da coluna de artefato precisa ser revisto nesta onda: um nicho com seis objetos e
quarenta campos passa disso. A decisão é **aumentar o teto da coluna**, não compactar o JSON — texto
legível é o que torna a revisão do catálogo possível.

### 2.1 Objetos e campos

```jsonc
"dados": {
  "objetos": [{
    "slug": "odontograma",                  // [a-z][a-z0-9_]{2,30}; o host prefixa com o publicador
    "rotulo": { "pt-BR": "Odontograma", "es": "Odontograma" },
    "escopo": "organizacao",                // só este valor na onda 1
    "campos": [
      { "slug": "dente",    "tipo": "inteiro", "obrigatorio": true, "min": 11, "max": 48 },
      { "slug": "face",     "tipo": "escolha", "opcoes": ["oclusal","mesial","distal","vestibular","lingual"] },
      { "slug": "condicao", "tipo": "escolha", "opcoes": ["cariado","restaurado","ausente","higido"], "obrigatorio": true },
      { "slug": "valor",    "tipo": "dinheiro" },          // vira *_cents bigint + moeda
      { "slug": "laudo",    "tipo": "texto_longo" },
      { "slug": "imagem",   "tipo": "arquivo", "max_bytes": 2000000 },
      { "slug": "feito_em", "tipo": "data" }
    ],
    "refs": [{ "slug": "paciente", "entidade": "contato", "obrigatorio": true, "ao_apagar": "cascata" }],
    "unico": [["paciente", "dente", "face"]],
    "indices": [["paciente", "feito_em"]],
    "privacidade": { "pessoal": ["laudo", "imagem"], "sensivel": ["laudo"] }
  }]
}
```

Tipos da onda 1, fechados: `texto`, `texto_longo`, `inteiro`, `decimal`, `dinheiro`, `booleano`,
`data`, `data_hora`, `escolha`, `escolha_multipla`, `arquivo`, `imagem`.

`refs.entidade` vem de uma **allowlist de entidades do núcleo**: `contato`, `lead`, `conversa`,
`compromisso`, `usuario`, `comanda`, `produto`. Nada de referenciar tabela arbitrária.

`privacidade` não é enfeite: é o que liga o objeto à cascata de LGPD e ao export. Campo marcado como
`pessoal` entra na anonimização do contato; `sensivel` acrescenta a proibição de sair da instalação
quando a classe `connected` existir.

### 2.2 Telas

O host renderiza, com os componentes do próprio produto — o módulo **descreve**, não desenha:

```jsonc
"telas": [{
  "slug": "odontogramas",
  "rotulo": { "pt-BR": "Odontograma" },
  "objeto": "odontograma",
  "vista": "lista",                        // lista | ficha | calendario | quadro | galeria
  "colunas": ["paciente", "dente", "condicao", "feito_em"],
  "filtros": ["condicao", "feito_em"],
  "ordem": [["feito_em", "desc"]],
  "acoes": ["criar", "editar", "remover"]
}],
"paineis": [{ "slot": "contato.lateral", "objeto": "odontograma", "vista": "lista", "colunas": ["dente", "condicao"] }]
```

Slots da onda 1: `contato.lateral`, `lead.lateral`, `conversa.lateral`. Um slot é um lugar onde o host
**já** mostra informação da entidade; não é um ponto de injeção arbitrário.

### 2.3 Ações, eventos e ferramenta de IA

Tudo de catálogo fechado, implementado pelo **host**:

- **Ações**: `criar`, `editar`, `remover`, `mudar_campo`, `lancar_no_caixa`, `criar_tarefa`,
  `registrar_na_linha_do_tempo`. O módulo compõe; nunca traz lógica.
- **Eventos emitidos** pelo próprio registro: `<objeto>.criado`, `<objeto>.alterado`,
  `<objeto>.removido` — entram em `event_log` como qualquer fato, e ficam disponíveis como gatilho de
  automação do produto, de graça.
- **Ferramenta de IA**: declarativa e **somente leitura** na onda 1 (`consultar <objeto> do contato
  atual`). A descrição que o modelo vê é **gerada pelo host** a partir dos rótulos, nunca texto livre
  do pacote — texto de terceiro no prompt já foi recusado na ADR-0003.

### 2.4 Concessões

O manifesto declara, e a organização consente em frases legíveis, podendo consentir menos:
`dados.proprios` (implícita), `contato.ler`, `lead.ler`, `lead.campos.escrever`,
`linha_do_tempo.escrever`, `tarefa.criar`, `caixa.lancar`, `ia.consultar`.

Autoridade efetiva = declarado ∩ consentido ∩ papel de quem clica, revalidada na transação do efeito.

---

## 3. O compilador

A peça nova do host. Ele transforma o artefato em SQL **dentro da transação da instalação**, no
caminho que a ADR-0002 já abriu (`fn_modulo_instalar` → `fn_<slug>_provisionar()` →
`fn_proteger_modulo_provisionado()`).

Ordem, e cada passo existe por uma razão:

1. **Validar** o artefato (Zod no serviço e de novo no banco — validação dupla, com um invariante que
   sabota a primeira para provar que a segunda pega).
2. **Resolver nomes**: `m_<publicador>_<modulo>_<objeto>`, minúsculas, sem `__`, **truncado com sufixo
   de hash para caber em 63 bytes** (`NAMEDATALEN`), colunas reservadas recusadas, nome de policy por
   hash. Antes de criar, conferir **de quem é** a tabela com esse nome: um módulo nunca escreve sobre a
   tabela de outro.
3. **Gerar o corpo** da provisionadora: `create table if not exists`, `add column if not exists` para
   as versões seguintes, CHECK dos tipos e das escolhas, índices, únicos, e as FKs **compostas por
   organização** — a checagem de FK ignora RLS, então uma FK simples aceitaria id de outra
   organização.
4. **Gravar a função** e chamá-la, com `lock_timeout`: uma FK para `contacts` toma `SHARE ROW
   EXCLUSIVE`, e a ingestão de WhatsApp está no ar.
5. **Fechar as portas**: `revoke` de `authenticated` **antes** de `fn_proteger_modulo_provisionado()`.
   Tabela de módulo é server-only — toda mutação passa pela rota auditada do host, nunca pelo
   PostgREST.
6. **Conferir** os objetos esperados depois de provisionar, e reprovar visível se faltar algum (a D6 da
   ADR-0002), com a diferença decidida na ADR-0005: módulo de terceiro **suspende e avisa**; só o
   oficial derruba a atualização.

O que o compilador **nunca** faz: aceitar identificador cru do pacote, montar SQL por concatenação de
texto do pacote, criar função que o pacote nomeie, tocar tabela do núcleo, ou criar role.

### 3.1 Atualizar e remover

- **Atualizar** reaplica a provisionadora da versão nova, e só quando o hash do artefato mudou (para
  não alongar a janela em que o app fica parado). Mudança **compatível** (campo novo opcional, índice,
  tela) é aplicada; **incompatível** (remover campo, apertar tipo, trocar FK) é recusada com código
  próprio — quem precisa disso publica outra versão maior e migra, como o Core faz.
- **Remover** é lógico e **preserva os dados** (não-negociável 7): as telas saem, as tabelas ficam.
  Apagar é ação separada, com consequência escrita na tela e as regras de LGPD do domínio.

---

## 4. Escrita e leitura

Uma família de rotas genérica, com uma entrada por verbo e despacho **por dado**:

```
GET    /api/v1/modulos/{modulo}/{objeto}            lista, com cursor e filtros declarados
POST   /api/v1/modulos/{modulo}/{objeto}            cria (Idempotency-Key)
PATCH  /api/v1/modulos/{modulo}/{objeto}/{id}       altera (precondição por revisão)
DELETE /api/v1/modulos/{modulo}/{objeto}/{id}       remove
```

Todas resolvem a organização do **cookie ou do token**, nunca do corpo; conferem concessão e papel;
validam contra o schema declarado; auditam com o ator `module` e o módulo nomeado; e aplicam a cota em
**bytes**, atomicamente na escrita (o plano gratuito tem 500 MB para a instalação inteira).

---

## 5. LGPD, export e varreduras

- **Anonimização** do contato alcança os campos marcados `pessoal` nas tabelas do módulo, por SQL
  dinâmico protegido por `to_regclass` — onde o módulo não está instalado, passa sem erro. O caminho é
  o **gatilho na transição de `is_anonimizado`**, não reescrever a função de cascata, que já tem várias
  cópias no baseline.
- **Export** que não conseguir ler uma seção de módulo marca o resultado como **parcial**, nunca como
  completo.
- As varreduras de RLS, de `security definer` e da cascata rodam também sobre um banco **com módulos
  instalados**, senão tabela provisionada fica fora delas. E entra uma varredura nova por **DDL em
  qualquer `security definer`** — a atual só alcança `fn_*_provisionar`, e o compilador cria função
  nova.

---

## 6. Sistema vivo

| Invariante | Como esta onda o cumpre |
|---|---|
| Entrada | instalar na instância, ativar e consentir na organização, criar registro pela tela |
| Saída | telas e painéis do host, eventos em `event_log`, ferramenta de IA de leitura, ações |
| Registro | recibo em `extension_operations`, auditoria com ator `module`, atividade na linha do tempo |
| Tela | grupo "Módulos" na navegação, com porta declarada em `lib/navigation/registry.ts` |
| Anti-morte | conferência pós-provisionamento, módulo suspenso com aviso na Central, interruptor local |
| Laço de retorno | artefato que não compila **não instala** (nada pela metade); módulo que falha na atualização suspende e avisa, sem derrubar o núcleo |

---

## 7. Como isto é provado

1. **Invariantes em Postgres real:** compilação idempotente; tabela nascendo server-only e isolada por
   organização; FK composta recusando id de outra organização; nome de 63 bytes; sabotagem da validação
   do serviço para a do banco pegar; cota em bytes; recusa de mudança incompatível; anonimização
   alcançando o campo `pessoal` e passando sem erro onde o módulo não existe.
2. **Pela tela, em ambiente fresco estilo VPS** (banco do `baseline.sql` + `bootstrap-owner`): instalar
   um módulo, ativar numa organização, criar um registro, ver na ficha do contato, atualizar o módulo,
   remover e conferir que os dados ficaram.
3. **A prova dura:** o módulo de honorários portado para artefato declarado, instalado num banco onde
   ele não existe como código, com os mesmos dados funcionando.

Se o passo 3 exigir qualquer mudança no Core, a lacuna que ele revelar entra na spec antes de a onda
ser considerada pronta — é para isso que ele existe.
