# Extensões declarativas v1 — primeira integração

Estado em 16/set/2026: instalação, configuração e recuperação **implementadas e provadas em tela** no J25; atualizar, desfazer a última troca e remover **implementados**, com a prova em tela no J26 (o resultado de cada rodada fica no fim do PROG-021). Complementa o PROG-017 e o marco 2 do PROG-018. A autorização de arquitetura e as respostas A/A/A do DEC-004 continuam vigentes. Os relatórios [08](../research/extensoes/08-integracao-bases.md), [09](../research/extensoes/09-integracao-impactos.md) e [10](../research/extensoes/10-integracao-riscos.md) são as três investigações deste recorte.

## Jornada e limites

Um pacote publicado **depois do build** acrescenta cards de orientação no hub CRM. A pessoa abre o guia instalado e sua ação leva às Tarefas existentes. O pacote não recebe dados de tarefas, não executa código e não condiciona a disponibilidade de Tarefas à sua ativação. O administrador da instalação admite um catálogo revisado e instala; o administrador da organização ativa e configura; os demais papéis usam o conteúdo dentro do acesso habitual.

Este incremento entrega instalação inicial, configuração, desativação, reativação e recuperação de preparação interrompida. Quem administra a instalação também atualiza ou troca a versão instalada, desfaz a última troca e remove a extensão da instalação (seção "Versões"). Remoção física de linhas não existe: remover é lógico e preserva recibos, artefatos e configuração. Código isolado, dependências, dados de domínio de pacote, notificações de incidentes, reputação e publicação pública não são oferecidos neste incremento.

## Contrato do documento

Pacote JSON UTF-8 estrito, sem ZIP, comentários, chaves duplicadas, chaves `__proto__`/`prototype`/`constructor`, HTML, script, SQL, CSS, expressões ou URLs de assets. Texto é renderizado como texto. As estruturas de autoridade são estritas; propriedade desconhecida é erro. O formato e a API do host são separados da versão pública do CRM. Textos localizados precisam de conteúdo legível; NUL e Unicode malformado são recusados antes do banco.

```typescript
type LocalizedText = { "pt-BR": string; es?: string };
type ExtensionConfiguration = {
  density: "comfortable" | "compact";
  show_description: boolean;
};
type ExtensionManifest = {
  format_version: 1;
  profile: "declarative";
  publisher: string; // slug ASCII minúsculo, 2–64 caracteres
  name: string; // slug ASCII minúsculo, 2–64 caracteres
  version: string; // SemVer estável x.y.z, inteiros sem zeros à esquerda
  license: "MIT";
  host_api: { min: number; max: number }; // inteiros positivos; host atual = 1
  permissions: ["navigation.tasks"];
  dependencies: [];
  data: { mode: "none" };
  display: {
    title: LocalizedText;
    summary: LocalizedText;
    category: "productivity" | "sales" | "service";
    icon: "ListChecks" | "BookOpen" | "Lightbulb";
  };
  configuration: ExtensionConfiguration; // defaults; sem configuração textual livre
  contributions: {
    crm_cards: Array<{
      id: string; title: LocalizedText; description: LocalizedText;
      icon: "ListChecks" | "BookOpen" | "Lightbulb";
      blocks: Array<{ heading: LocalizedText; body: LocalizedText }>;
      action: { label: LocalizedText; capability: "tasks.open" };
    }>;
  };
};
type CatalogEntry = Pick<ExtensionManifest,
  "publisher" | "name" | "version" | "license" | "host_api" | "display" | "permissions"
> & { sha256: string; byte_length: number };
type ExtensionCatalog = {
  format_version: 1;
  origin: string; // origem exata, sem credencial, caminho, query ou fragmento
  revision: number; // inteiro positivo, monotônico por origem admitida
  entries: CatalogEntry[];
};
```

Parâmetros técnicos iniciais, publicados antes dos ensaios e sujeitos à medição: pacote 64 KiB; catálogo 512 KiB; profundidade JSON 12; nós JSON 20.000; 32 propriedades por objeto; 128 entradas por catálogo; 4 cards por pacote; 8 blocos por card; títulos 100 caracteres, resumos/descrições 400, corpo 2.000; 8 extensões ativas por organização; 8 catálogos admitidos e 128 identidades instaladas/em preparação por instância; versão do pacote com até 64 caracteres; revisão de catálogo entre 1 e 999.999.999; download com prazo total de 15 segundos. Não são capacidade de VPS nem SLA demonstrados. O limite de bytes conta o corpo realmente lido; o cabeçalho só antecipa recusa. Transporte comprimido é recusado neste perfil.

Uma função compartilhada verifica compatibilidade na instalação, ativação, leitura de card/guia e resolução de ação. Recusa API fora da faixa, formato, perfil, capacidade ou dependência não suportados. Revalidar o manifesto persistido impede que um upgrade do CRM interprete cegamente um contrato anterior. Fallback de texto é pt-BR e fica indicado quando não há tradução para o idioma escolhido.

## Versões: atualizar, desfazer a última troca e remover

O perfil é declarativo e a configuração segue um esquema do host, então não existe dado de domínio do pacote para migrar. "Atualizar" é trocar o ponteiro do artefato da instalação; "desfazer" é trocar de volta. Artefatos continuam imutáveis e nunca são apagados.

**Precondição.** Toda troca de ponteiro exige `expected_installation_revision`, a revisão da linha de `extension_installations` que a tela exibiu (`null` quando a tela não viu linha para a identidade). A revisão sobe em toda conclusão de instalação e atualização, em desfazer e em remover; configurar não mexe nela, porque é estado da organização. Divergência é `409 extension_version_changed`, e a tela recarrega. A revisão pega o que a comparação por artefato não pega: remover e reinstalar a mesma versão, ou ir de A para C e voltar a A.

**Atualizar ou trocar** (inclusive para versão menor) usa a mesma porta da instalação. Para uma identidade ativa no mesmo catálogo com outra versão, o recibo nasce `update`, com a revisão, o artefato e a versão de origem. Download, validação e conclusão são os da instalação. Os vínculos das organizações não mudam: ativação, configuração e revisão ficam como estavam. O recibo concluído guarda de/para e quantas organizações estavam com a extensão ativa.

**Desfazer a última troca** (`POST :id/revert`) troca o artefato vigente com o anterior e é a própria inversa. Não baixa nada, então funciona com o catálogo fora do ar. O histórico guarda **um** passo: depois de 1.0 → 1.1 → 1.2, desfazer leva a 1.1, e a 1.0 só volta pelo catálogo, se a revisão admitida ainda a listar. A compatibilidade da versão de destino é conferida antes da RPC; um anterior incompatível deixa o botão desabilitado com o motivo.

**Remover da instalação** (`POST :id/remove`) grava `removed_at`/`removed_by`, sobe a revisão e desliga, em todas as organizações, só os vínculos **ativos**, com `deactivated_by_removal_at` e a configuração preservada. Nenhuma linha é apagada. A instalação sai do hub e do guia (o guia responde `410 extension_removed`), e configurar recusa com o mesmo código. Na aba Instaladas, qualquer pessoa de uma organização que a usava, inclusive quem também administra a instalação, vê o card somente leitura "Removida", dos mais recentes até 128. Para quem administra a instalação, ela aparece como "Reinstalar" no catálogo DE ONDE FOI INSTALADA, enquanto esse catálogo estiver admitido e listar a identidade. Se ele não listar mais, não há reinstalação pela tela e o card "Removida" fica. Instalar a mesma identidade a partir de outro catálogo cria outra instalação, sem os vínculos e sem a marca da remoção (não se migra instalação entre origens). A marca da remoção num vínculo só sai quando a organização ativa de novo: uma organização que não reativou depois de uma reinstalação continua contada como "a usava" numa remoção seguinte. Remover vale por instalação: a mesma identidade admitida por outro catálogo é outra instalação e continua ativa. Cada organização desligada recebe na própria auditoria (`/app/audit`) a ação `extension.deactivated_by_removal`, distinta da desativação que a própria organização faz, com `metadata.reason = "installation_removed"`. A exceção é a da auditoria sem bloqueio: se a resposta se perde depois do commit e a repetição devolve `applied_now` falso, o recibo e o card "Estava ativa até…" registram a remoção, e a auditoria das organizações não.

**Reinstalar** é a instalação pelo catálogo sobre a linha removida, com a revisão dela. A conclusão limpa a remoção e o anterior e sobe a revisão. Os vínculos voltam **desativados** e mantêm a marca da remoção, de onde a tela da organização tira "Estava ativa até ser removida…": a plataforma não reativa uma decisão que é da organização.

**Regras do formato 1 que a troca de versão depende:**

1. `contributions.crm_cards[].id` é identidade estável entre versões. A abertura envia o `card_id`, e a rota recusa com `409 extension_card_unavailable` o card que a versão vigente não tem.
2. Os defaults de `configuration` de uma versão nova não alcançam organizações que já configuraram.
3. Sair do catálogo não revoga a instalação nem impede desfazer; a confirmação avisa. Remover é a ferramenta para tirar uma versão ruim.
4. A mesma versão com digest diferente é conflito (`extension_version_conflict`) contra o artefato vigente, o anterior e o da linha removida.

**Leituras entre organizações.** A leitura de um recibo por quem administra a instalação se limita aos recibos da plataforma e aos da organização ativa. `fn_extensions_installation_counts(p_actor)` confere no banco, como as funções que escrevem, que o ator administra a instalação, e devolve, por instalação, quantas organizações estão com a extensão ativa e quantas foram desligadas pela remoção e ainda não reativaram. É exceção declarada à regra "service role filtra `organization_id`": a leitura atravessa organizações, e por isso devolve só números, nunca ids, e só a quem administra a instalação.

**Recusado por escrito:** auditoria por organização em atualizar e desfazer (nenhuma linha da organização muda; a versão vigente aparece no card e no cabeçalho do guia, e a auditoria da instância registra o ato com a contagem de organizações ativas, exceto quando a resposta se perde e a repetição devolve `applied_now` falso: aí só o recibo registra); histórico de mais de um passo; tratar saída do catálogo como revogação; troca sem precondição; migrar instalação, com seus vínculos, entre origens; versão por organização; remover com preparação da mesma identidade em curso (cancele antes); admin de organização desfazendo ou removendo; aviso ativo às organizações (banner, e-mail). Mudança de permissões entre versões hoje é impossível, porque a admissão força `["navigation.tasks"]`; quando o contrato admitir outra permissão, concluir atualização e desfazer passam a recusar `extension_permissions_changed`.

## Confiança e download

O piloto usa **catálogo imutável admitido manualmente**: o dono da instalação fornece pela tela um arquivo de catálogo obtido de uma fonte que já confia, fora da resposta remota a verificar. A tela explica essa procedência. O host registra ator, instante, origem, revisão e SHA-256 dos bytes fornecidos. Copiar o hash do próprio servidor não prova autoria. Revisão inferior ou mesma revisão com conteúdo diferente é recusada. Admitir nova revisão invalida preparações antigas; instalações já concluídas permanecem locais.

É uma implementação restrita do ponto de admissão, **não TUF**. Não oferece descoberta autenticada automática, expiração, rotação delegada de chaves ou conhecimento de revogação offline. O marketplace público continua condicionado ao verificador mantido e à operação de confiança descritos no PROG-017 §11. Não haverá protocolo criptográfico próprio. A saída estável do ponto de confiança é identidade, versão, tamanho, digest e evidência de admissão; armazenamento, download e ativação não dependem do mecanismo que a produziu.

A UI pede instalação por catálogo/publicador/nome/versão. O servidor constrói apenas `/packages/<sha256>.json` na origem admitida. Não aceita URL de pacote do navegador. HTTPS/certificado válidos, sem redirects, cookies ou credenciais. DNS é resolvido e os endereços admitidos ficam vinculados à conexão real, preservando Host/SNI; endereços especiais IPv4/IPv6 são recusados. Não copiar a janela de rebinding do helper atual de webhooks.

Exceção do laboratório: `EXTENSIONS_LOCAL_CATALOG_ORIGIN`, opcional e vazio por padrão, admite **uma origem HTTP exata em 127.0.0.1** somente quando `NEXT_PUBLIC_APP_URL` também é loopback. Origem fornecida pelo pacote/tenant nunca ativa essa exceção. Deve constar em `lib/env.ts` e `.env.example`, sem alterar o funcionamento de instalações existentes.

O catálogo de ensaio é processo separado, com banco SQLite próprio e artefatos imutáveis; não usa o banco do CRM. Publicação local e exportação do arquivo de admissão acontecem por CLI. Sua indisponibilidade só impede novos downloads. O Next não precisa de filesystem persistente, Docker socket, DDL ou processo executando código de pacote: os documentos admitidos ficam no banco local do CRM.

## Persistência e autoridade

Tabelas de framework: `extension_catalogs` (origem/revisão atual/admissão), `extension_artifacts` (documento UTF-8 original, digest, tamanho e manifesto imutáveis), `extension_installations` (identidade estável e ponteiro do artefato), `organization_extensions` (estado/configuração/revisão por organização) e `extension_operations` (recibo durável). Instalações e artefatos não são cópias de skills.

Tabelas de instância ficam fechadas a anon/authenticated. Vínculos de organização podem ser lidos por membro vigente sob RLS, sem INSERT/UPDATE/DELETE direto. Escritas do framework são RPCs `service_role` apenas, revogadas de PUBLIC e anon/authenticated, com busca de schema fixa. Além do guard HTTP de papel/MFA/suporte, cada RPC revalida no banco o ator e a organização/papel atuais. O ator vem de getUser, a organização do resolvedor canônico; nenhum dos dois é aceito do corpo HTTP.

API de admissão, instalação, atualização, cancelamento de preparação, desfazer e remoção exige plataforma com escopo `full`, ausência de acompanhamento de suporte e sessão com verificação em duas etapas quando a política da plataforma a exige ou quando a pessoa já tem um fator cadastrado. Ativação/configuração exige `requireRole("admin")`, com guarda de suporte para escrita. Neste perfil, configurar exige membership administrativo real e sair do acompanhamento de suporte; não é criada uma autoridade delegada nova por callback. Leitura/uso exige viewer. Concessão `navigation.tasks` só abre a porta já existente; não cria autoridade sobre tarefas e não dá leitura delas ao pacote.

Configuração e ativação usam revisão esperada, chave idempotente e transação com lock da organização para o teto agregado. Desativar preserva configuração; reativar não a substitui pelos defaults. Repetição da mesma chave só retorna o mesmo recibo se o pedido for idêntico. Conflito de revisão exige recarregar; não sobrescrever uma edição mais nova.

Leitura da gestão/guia/recibo, configuração e abertura de Tarefas exigem a precondição HTTP `X-Expected-Organization-Id`, contendo a organização apresentada pela tela. Depois do guard, a rota compara esse valor com a organização canônica da sessão: divergência é `409 extension_context_changed`; ausência ou formato inválido é 400. O header nunca escolhe organização nem concede acesso. Isso fecha a janela em que outra aba muda o cookie entre a renderização e o clique. A interface invalida o snapshot divergente e recarrega o contexto; o recibo de configuração devolve também `organization_id` para conferir a resposta.

## Operação recuperável e atualização do core

Preparação grava a identidade admitida e o recibo **antes** do download. Download não produz efeitos de domínio; conclusão verifica novamente admissão vigente/bytes/manifesto e publica artefato, ponteiro e recibo na mesma transação. Resposta perdida é resolvida lendo o recibo. Repetir preparação é seguro porque apenas a conclusão transacional publica. Repetir a conclusão compara com o artefato que ela publicou, e não com o ponteiro de agora, para que um desfazer posterior não faça a repetição acusar pacote adulterado. Toda RPC que escreve devolve `applied_now`, e a auditoria só grava quando ele é verdadeiro.

Tipos de recibo: `catalog_admission`, `install`, `update`, `revert`, `removal`, `configure`; só `configure` pertence a uma organização. Estados: `preparing`, `completed`, `failed`, `cancelled`; só `install` e `update` preparam. Falha guarda código estável com texto/proximo passo resolvidos pelo host, sem corpo remoto. Uma preparação interrompida aparece com **Verificar instalação**, **Verificar atualização** ou **Verificar troca de versão** (reler e retomar o mesmo recibo, com a revisão que a preparação encontrou) e com **Cancelar preparação**, **Cancelar atualização** ou **Cancelar troca de versão**. Retomar é só de quem pediu, porque o banco confere o ator; para os demais administradores da instalação a tela explica isso e oferece só cancelar. Um pedido cancelado por outra pessoa durante o download não é anunciado como sucesso para quem pediu. Um recibo de tipo ou estado que esta versão não conhece sai da lista com registro em log, em vez de derrubar a gestão; a leitura direta responde `409 extension_operation_unreadable`. Cancelamento é transacional: uma conclusão tardia não pode publicar depois dele. Não inferir sucesso ou fracasso só por timeout da tela.

Antes da mutação, o navegador precisa confirmar a persistência do UUID de reconciliação. Cada recibo ocupa uma chave própria, separada por ator e organização, para que duas abas não sobrescrevam listas inteiras. Falha do armazenamento bloqueia o envio e oferece recuperação visível. Um 404 sem o erro JSON canônico de operação não encontrada conserva o recibo; uma consulta confirmada o resolve independentemente da janela do histórico recente. A leitura inicial acontece depois da hidratação, e alterações do armazenamento são sincronizadas entre abas.

Preparação/conclusão e criação de `system_update_runs` compartilham coordenação transacional no banco. Nova atualização do core é recusada enquanto há preparação de extensão (`install` ou `update`); preparar, concluir e desfazer são recusados durante atualização `dispatched` com menos de 15 minutos, a mesma régua de `RUN_STALE_AFTER_MS`. Um `dispatched` mais velho é, para o próprio app, desfecho desconhecido e não trava a publicação. Remover não consulta a atualização do core: tirar só reduz o que está ativo. Um trigger do framework no INSERT/transição para dispatched do atualizador aplica o mesmo lock. Cancelar/retomar prepara a saída da espera sem desbloquear uma execução antiga capaz de publicar. Esta coordenação cobre o atualizador pelo app; execução externa/manual do kit mantém sua responsabilidade de manutenção e deve ser declarada como limite, sem anunciar exclusão global de processos.

Auditoria registra admissão/instalação/atualização/desfazer/remoção/configuração/desativação/cancelamento com IDs/versão/revisão, sem pacote bruto ou dados de tarefa. O recibo é a prova da operação; auditoria fire-and-forget é complementar. A UI mostra estado, origem, permissões e destino de uso. Ao foco/reconexão e após mutação, reconsulta o servidor; resposta de organização antiga é descartada. A rota direta e a ação verificam estado atual, mesmo com página antiga aberta.

## Interfaces de integração entre as tarefas

Módulo puro `lib/extensions/manifest.ts`: tipos acima; `parseManifest(bytes)`, `parseCatalog(bytes)`, `checkCompatibility(manifest): { compatible: boolean; reason: string | null }`, `validateArtifact(bytes, entry): Promise<ExtensionManifest>`; `configurationSchema` e `localize(text, locale): {text: string; fallback: boolean}` exportados. `lib/extensions/download.ts`: `downloadArtifact(origin, entry, policy): Promise<Uint8Array>`; policy tem `localCatalogOrigin` e `appUrl`. Erros tipados em `lib/extensions/errors.ts`, sem dados brutos em mensagens públicas.

RPCs retornam JSON com registro pós-operação; assinaturas:

- `fn_extensions_admit_catalog(p_actor uuid, p_operation uuid, p_snapshot jsonb, p_digest text)`.
- `fn_extensions_prepare_install(p_actor uuid, p_operation uuid, p_catalog uuid, p_publisher text, p_name text, p_version text, p_expected_installation_revision integer)`.
- `fn_extensions_finish_install(p_actor uuid, p_operation uuid, p_manifest jsonb, p_sha256 text, p_byte_length integer, p_document text)`.
- `fn_extensions_fail_install(p_actor uuid, p_operation uuid, p_error_code text)`.
- `fn_extensions_cancel_install(p_actor uuid, p_operation uuid)`.
- `fn_extensions_configure(p_actor uuid, p_organization uuid, p_installation uuid, p_operation uuid, p_expected_revision integer, p_enabled boolean, p_configuration jsonb)`.
- `fn_extensions_revert_install(p_actor uuid, p_operation uuid, p_installation uuid, p_expected_installation_revision integer)`.
- `fn_extensions_remove_installation(p_actor uuid, p_operation uuid, p_installation uuid, p_expected_installation_revision integer)`.
- `fn_extensions_installation_counts(p_actor uuid)`, só números por instalação (ver "Leituras entre organizações").

O formato dos registros e códigos SQL será publicado pelo implementador de banco antes da integração de APIs. Erros são códigos enumerados, nunca texto do pacote; a frase e o status de cada um moram em `lib/extensions/erros-do-banco.ts`, e um teste exige ali todo código que a migration levanta. Os tipos gerados do Supabase vêm do banco aplicado, sem edição manual.

Portas HTTP sob `/api/v1/extensions`: GET lista; POST `catalogs` admite bytes do arquivo (`application/json`, chave em `Idempotency-Key`); POST `install` pede/retoma instalação, atualização, troca e reinstalação (corpo com `expected_installation_revision`); GET `operations/:id`; POST `operations/:id/cancel`; PUT `:id/configuration`; GET `:id` lê guia ativo; POST `:id/open` resolve `tasks.open` após revisão, estado e existência do `card_id`; POST `:id/revert` e POST `:id/remove`, com `Idempotency-Key` e corpo `{expected_installation_revision}`. Corpos com limite, schema estrito e `ok`/`fail`; leitura `no-store`.

Gestão em `/app/extensions`, declarada no catálogo canônico de navegação; uso em `/app/extensions/[id]`. Cards ativos entram por contribuição tipada no NavHub CRM, com links a essa porta genérica. Nenhum href arbitrário vai ao shell. A gestão pode ser vista por membros, mas ações administrativas aparecem apenas a quem pode executá-las.

## Prova e laço de retorno

Validações de parser/rede hostil; banco real para RLS/RBAC, repetição/revisão, cancelamento tardio, conflito de versão e concorrência com atualização; baseline fresco e reaplicado. E2E real instala pacote publicado após o build, ativa em A sem afetar B, configura, usa guia e cria/conclui tarefa pela UI existente; desativa, abre URL antiga, reativa e confere preservação. O J26 atualiza de 1.0.0 para 1.1.0 com A ativa, desfaz com o catálogo desligado, recusa a aba antiga, remove, reinstala e reativa. Ensaia download inválido/interrompido, repetição de pedido, catálogo desligado, reinício/reconexão, troca de organização, papéis negados, tela estreita, teclado, marca e espanhol. Captura screenshot/trace e inspeciona backend.

| Pergunta da doutrina | Artefato implementado neste incremento |
|---|---|
| Quem alimenta? | `CatalogAdmission` recebe o arquivo revisado; o servidor baixa bytes da origem admitida por `downloadArtifact`. |
| Quem recebe a saída? | `NavHub`, `ExtensionGuide` e a capacidade fixa `tasks.open`, que abre as Tarefas existentes. |
| Que registro emite? | `extension_operations` é o recibo transacional; `audit()` emite ações `extension.*` em `api_audit_log`, como registro complementar. |
| Onde o registro aparece? | `ExtensionOperations` exibe recibos na gestão; a auditoria complementar aparece em `/admin/audit` para a plataforma e em `/app/audit` para a organização, onde a remoção deixa `extension.deactivated_by_removal`. |
| Por qual porta se chega? | Entrada Extensões no `NAV_CATALOG` de `lib/navigation/catalogo.ts`, grupo Organização › "Sua empresa" (visível a todo membro; ações só para admin); cards ativos também abrem os guias pelo hub CRM. |
| Qual o próximo passo garantido? | Preparação persistida (instalação ou atualização) oferece retomar a quem pediu e cancelar a qualquer administrador da instalação; falhas explicam o motivo e a nova tentativa. Uma versão com defeito tem saída: desfazer a última troca ou remover da instalação. O guia não cria demanda própria: a tarefa continua no domínio e na jornada existentes. |
| Onde se configura? | `InstalledExtensionCard` permite ativar, desativar, mudar densidade e descrição; `fn_extensions_configure` verifica papel, organização e revisão. |
| Qual a continuidade IA ↔ humano? | Este perfil só apresenta texto e abre uma tela existente. Não cria ferramentas de IA, handoff, envio ou autoridade nova; essas integrações pertencem aos marcos seguintes. |
| O que muda quando há erro? | A operação guarda falha/cancelamento ou permanece reconciliável; a gestão relê o recibo e orienta corrigir o catálogo/arquivo antes de novo pedido. Não repete efeito incerto nem altera outra organização. Uma versão publicada com defeito volta pelo desfazer, sem depender do catálogo, ou sai de todas as organizações pela remoção; cada organização desligada vê o motivo na própria auditoria e no card "Estava ativa até…". |
| Onde está o mapa? | `docs/architecture/extensoes-declarativas.architecture.json` conecta admissão, download, persistência, configuração, hub, Tarefas, recibos e auditoria. Seu estado separa implementação de provas concluídas. |

Essas respostas identificam o código implementado; o aceite de suas jornadas depende das provas registradas no PROG-021.

Referências de implementação consultadas: [jsonc-parser, Microsoft](https://github.com/microsoft/node-jsonc-parser), para scanner/parser com recusa dos erros; [ipaddr.js](https://github.com/whitequark/ipaddr.js), para classificação de endereços. Conferir APIs e versões instaladas antes do uso. São bibliotecas auxiliares; não conferem confiança ao catálogo.
