# Integração declarativa — riscos e mínimo viável

14/set/2026 · leitura na branch do PR #1016, commit `b3a056b85`.

Escopo: marco 2; pesquisa documental, sem implementação, serviços, testes ou SQL executados.

Autoridade: PROG-017 *(documento interno de decisão)* §§5–6, 9–11 e PROG-018 *(documento interno de decisão)* marco 2/P0-03, 04, 07, 12, 13/P1-22. AGENTS/CLAUDE lidos; números experimentais anteriores não são prova desta integração.

## O que já existe e o que sua evidência permite afirmar

**CONFIRMADO por leitura**, com linhas da revisão acima; nenhum teste foi reexecutado nesta pesquisa.

| Peça existente | Evidência concreta | Consequência para a integração |
|---|---|---|
| Parser de skills | `lib/ai/skills/package.ts:30,39,97,137,194`: até 64 arquivos, 1 MiB/arquivo, 5 MiB descompactados, recusa caminhos absolutos/`..`/barra invertida, tipos de assets restritos; frontmatter dedicado | Reaproveitar critérios e casos hostis; seu formato é conteúdo de skill, não manifesto de contribuições. |
| Limites incompletos antes de alocar | `package.ts:98–102,135`: o próprio código declara tamanho ZIP mentiroso como resíduo; contagem ocorre após inflação síncrona. `app/api/v1/ai/skills/import/route.ts:38–59` usa Content-Length antes de materializar multipart | Não chamar esse fluxo de limite rígido de CPU/RAM. Cabeçalho ausente/falso não limita os bytes realmente recebidos antes de `formData()`. |
| Identidade e hash de skill | `package.ts:173,216`; `lib/agent-engine/agent/skills.ts:113`; `lib/ai/skills/install.ts:44`: nome só precisa não ser vazio, entra na chave de Storage; hash é calculado sobre arquivo recebido | Hash registra conteúdo, não autentica origem/publicador. Não usar nome livre como caminho nem confundir UUID de versão local com versão pública/compatibilidade. |
| Publicação local por ponteiro | `lib/ai/skills/install.ts:20–60`: arquivos antes do ponteiro, tentativa de limpeza no upload falho; versão órfã permanece. `lib/agent-engine/agent/skills.ts:147–166`: versão/nome/org conferidos no SQL do ponteiro | Aproveitar preparação antes de ativar e escopo explícito; ainda faltam operação durável retomável, exclusão/idempotência e limpeza reconciliada para extensão. Não há transação única Storage+banco. |
| Separação entre organizações | `app/api/v1/ai/skills/import/route.ts:33,70`: org vem de requireRole; `install.ts:74–105`: instalação de skill copia para a org | Guard e isolamento são precedentes úteis. Papel manager de skill não autoriza instalação de instância: PROG-017 separa administração da plataforma e ativação/configuração da org. |
| Navegação central | `lib/navigation/catalogo.ts:105`, `registry.ts:94`, `interface.ts:6–17,49–83`: catálogo estático, ícones do host, destinos conhecidos e preferências filtradas | Compor com catálogo/projeções existentes; hoje destino novo exige código. Não criar sidebar paralela nem transformar preferência em autorização. |
| Reconciliação de interface | `hooks/auth/InterfaceRefresh.tsx:23–62,70–95`: geração por usuário/org, leitura no-store, comparação de org, Realtime, foco/online e polling | Estender o padrão para revisão de ativação/configuração. Hoje ele observa preferências em user_organizations, não extensão instalada. |
| Rede protegida em outros fluxos | `lib/automation/outbound-url.ts:18`; `outbound-ip.ts:95`; `actions/call-webhook.ts:68–75,112–121`: esquema/IP/DNS, redirect manual, timeout | Reaproveitar critérios; `outbound-ip.ts:88–93` admite intervalo entre DNS validado e conexão. Não afirmar que copiar os guards encerra SSRF/rebinding. |
| Allowlist do runtime IA | `lib/agent-engine/edge/egress.ts:80–110`: host/porta derivados de configuração, redirect manual | Referência de autoridade fora do payload; não é cliente pronto de pacote: faltam política de origem completa, bytes, autenticidade e persistência. |
| Desativação no efeito | `experiments/extensoes/state/fixture.sql:114–122`, `state/probe.mjs:147–174`: guarda com lock compartilhado e contraprova da leitura solta | Evidência experimental prévia; ainda não há esse contrato integrado ao produto. `lib/agent-engine/agent/skills.ts:170–190` recarrega skills no início do run, sem provar revogação durante o run. |

## Compatibilidade que precisa ser explícita

**PROPOSTO para o piloto:** formato declarativo único versionado, contrato do host explícito e versão imutável do pacote, separados da versão do CRM e da revisão de configuração/ativação. Se houver dados próprios, declarar também seu contrato; o piloto visual não ganha SQL/migrations de pacote.

Compatibilidade deve ser uma função compartilhada por admissão e leitura/renderização, inclusive após atualizar o CRM. Não usar `package.json` como versão do produto. Recusar formato principal, ação, permissão ou capacidade obrigatória desconhecidos; permitir apenas metadados opcionais de apresentação em área delimitada e limitada.

Persistir identidade `(origem, publicador, id)`, versão e digest exatos; o mesmo identificador/versão com bytes diferentes é conflito. Não derivar identidade de título traduzido. O catálogo não pode escolher outra origem para um identificador já admitido.

Para reduzir o piloto, admitir apenas pacotes sem dependências e contribuições simples que não disputem áreas exclusivas. Declarar essa capacidade como ausente e recusar manifestos que a exijam; não ignorar dependências silenciosamente. Futuro resolvedor precisa recusar ciclos/conflitos e registrar conjunto exato sem upgrades implícitos (PROG-017 §5).

Uma versão ativa por extensão/instância segue o contrato aprovado; ativação/configuração ficam por organização. Atualização que afete outra org requer compatibilidade de todas antes de trocar o ponteiro. A cópia personalizável de skills mantém sua semântica própria.

## Confiança mínima para catálogo separado e pacote novo sem rebuild

**PROPOSTO, piloto local com confiança fixada:** catálogo em processo/serviço separado, dados próprios e artefatos imutáveis; o CRM só recebe metadados públicos e baixa um JSON declarativo. O renderer e a rota genérica pertencem à imagem do CRM; publicar um novo documento que use capacidades já implementadas não exige imagem nova.

O administrador da instalação provisiona, por canal local confiável e fora da resposta do catálogo, origem exata e uma lista de admissões `(publicador, id, versão, tamanho, SHA-256)`. Esta lista é estado protegido da instalação, não campo editável por tenant ou documento remoto. Um pacote novo exige admissão explícita nessa lista, mas não rebuild. O serviço separado serve discovery; não pode ampliar sozinho o conjunto confiado.

**Âncora real:** identidade do operador e procedência pela qual ele obteve/conferiu os bytes admitidos. Copiar para a lista um digest informado pelo mesmo catálogo não verificado elimina a independência dessa conferência. Hash sozinho detecta diferença; não comprova autoria, revisão ou inocuidade.

Para a bancada local, HTTP pode ser exceção somente para endereço/porta exatos previamente autorizados e serviço sintético controlado; nunca uma opção geral “permitir rede privada” enviada pelo pacote. Fora dessa bancada, exigir HTTPS com validação de certificado e origem provisionada. TLS autentica o serviço configurado, não o autor de cada pacote nem uma atualização maliciosa nesse serviço.

O pedido de instalação da UI leva identidade/versão, não URL livre, caminho, SQL ou comando. O host resolve o destino em sua política local, confere limites, digest admitido e manifesto; só então persiste e torna o pacote utilizável. Download parcial, identidade divergente e versão incompatível deixam a versão anterior íntegra.

Não é TUF nem marketplace público: confiança manual por artefato não oferece descoberta autenticada automática de versões futuras, rotação delegada, detecção geral de catálogo congelado ou revogação atualizada offline. Isso deve aparecer no relatório do piloto e na configuração administrativa.

**Alternativa A — catálogo imutável admitido:** o dono aprova fora do catálogo seu digest e procedência; depois de verificar esses bytes, o host admite apenas os pacotes/versões/digests neles enumerados. Catálogo novo exige nova aprovação externa; não há atualização automática ou promessa de revogação. Isso substitui a lista manual por artefato descrita acima, sem ampliar a autoridade do serviço remoto.

**Alternativa B — cliente TUF existente:** não há dependência TUF direta no `package.json` inspecionado; não foi verificada nesta leitura uma biblioteca com persistência em DB. Sua adoção fica condicionada a API pública de armazenamento/cache que preserve raiz confiada, versões e atualização consistente no banco, inclusive sob concorrência, sem exigir filesystem persistente do Next nem reimplementar verificações criptográficas.

**Contrato substituível proposto:** admissão de confiança devolve identidade, versão, tamanho/digest e evidência da decisão; download limitado, compatibilidade e ativação continuam contratos separados. Persistir no DB artefato declarativo, estado confiado e operação/revisões. A e B devem entregar esse mesmo resultado; trocar o verificador não autoriza revalidar silenciosamente pacotes por política mais fraca. Nenhuma alternativa aceita JS/SQL externo no marco 2.

Para distribuição pública, avaliar implementação mantida do TUF: raiz confiada fora do download inicial, papéis/assinaturas, versões/expiração, snapshot consistente, atualização de chaves e defesa contra rollback/freeze/mix-and-match; essas garantias têm operação própria. Não criar protocolo criptográfico caseiro. TUF verifica distribuição; não define o formato da extensão nem atesta segurança de seu comportamento. [Especificação TUF, §§1–2 e 5](https://theupdateframework.github.io/specification/latest/).

## Parser, destinos e assets

**PROPOSTO:** JSON UTF-8 sem ZIP no primeiro perfil reduz extração e descompressão. Limitar bytes efetivamente lidos antes de JSON.parse, com prazo total e cancelamento do corpo; Content-Length serve apenas como recusa antecipada. Se houver compressão de transporte, o teto precisa alcançar os bytes decodificados. Não aceitar tamanho declarado como prova.

Fixar e publicar, antes da implementação/ensaios, tetos de profundidade, nós/componentes, campos/chaves, arrays, textos, configurações, contribuições por pacote e total ativo por org. São parâmetros técnicos a medir, não SLA. Um JSON pequeno ainda exige orçamento de renderização; validação recursiva sem profundidade limitada pode falhar antes de devolver erro.

Schema discriminado/estrito nas partes de autoridade; rejeitar chaves duplicadas/ambíguas e nomes perigosos para composição de objetos. Nunca fazer merge irrestrito do manifesto em config do host. Texto permanece texto: sem HTML, JavaScript, expressões executáveis, CSS global, imports, fontes remotas ou SQL. Temas usam apenas tokens e valores enumerados/validados do host.

No piloto, preferir ícones do host e nenhuma URL/asset externa. Se assets entrarem depois, referências por identidade local verificada, MIME/tipo/tamanho admitidos e resposta segura; rejeitar SVG/HTML ativo nesse perfil. Nova origem requer admissão do operador, não permissão herdada do catálogo.

Rotas de ação/link são IDs conhecidos resolvidos pelo host, sem `javascript:`, URLs relativas de rede (`//`), destinos arbitrários ou ações privilegiadas escolhidas pelo pacote. Mesmo um link aberto só no navegador pode vazar contexto e contrariar a promessa de ausência de rede externa.

Se futuramente existir download por hostname externo, avaliar a conexão real: DNS/IP admitidos vinculados ao socket preservando TLS/Host, ou restrição de egress equivalente; bloquear redirects ou validar cada salto. Uma checagem DNS seguida de fetch independente deixa corrida. Allowlist de destinos e defesa na camada de rede são complementares. [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

Não usar IDs/títulos como caminhos físicos. Armazenar por chave opaca gerada pelo host; se houver filesystem, validar raiz/propriedade/contenção e links, gravar temporário exclusivo e promover atomicamente. Evitar arquivo compactado no piloto evita introduzir extração, mas não autoriza path relativo recebido de terceiros.

## Desativação, retomada e indisponibilidade

**PROPOSTO:** operação de instalação persistida e idempotente por identidade/versão, preparada antes da troca atômica do ponteiro, com falha/etapa/próximo passo. Reinício confere pós-condições e retoma ou encerra; não baixa novamente por presumir que um timeout significa “não aconteceu”. Limpar apenas artefatos próprios comprovadamente sem referências.

Persistir localmente artefato validado, admissão de confiança, contrato, configuração e revisões. Catálogo desligado impede descoberta nova, não abrir extensão já admitida nem reiniciar o CRM. Exibir última consulta e indisponibilidade; cache do catálogo não se torna autoridade para instalar pacote não admitido.

Desativação muda estado/revisão na org e preserva configuração/histórico. Página genérica, endpoints e qualquer efeito consultam o estado vigente; esconder menu não basta. Para escrita local, validação e efeito compartilham transação/guarda; para efeito externo enviado, registrar incerteza e reconciliar, sem anunciar desfazimento retroativo.

Compor a revisão da extensão com a reconciliação já existente: invalidar dados por org e revisar ao foco/reconexão; resposta antiga de A não entra em B. O backend continua autoritativo se Realtime cair. Navegação simplificada, idioma e marca não podem desaparecer na ativação.

Ao reconectar, reconciliar catálogo/admissões e apresentar avisos. DEC-004/PROG-017 §11 já determinam: retirada impede nova instalação oficial; versão local admitida tem decisão local explícita, sem desligamento remoto oculto. Offline não conhece revogações recentes; expiração de metadados restringe decisões novas, não revoga retroativamente a execução admitida.

## Custo e provas ainda necessárias

**INFERIDO:** o primeiro custo é manter contrato, armazenamento e operação recuperável, não contratar executor. Esse perfil declarativo dispensa um contêiner por extensão; catálogo separado, publicação e disponibilidade continuam exigindo responsável, backup, distribuição e diagnóstico. Não há custo ou capacidade de VPS demonstrados por esta leitura.

Medir tamanho de catálogo/artefatos e retenção, tempo/bytes de download e parsing, custo de renderizar conjunto máximo, consultas de revisão por usuário/aba, concorrência e limpeza de versões. Compartilhar consulta/revisão reduz multiplicação de polling por widget; acesso local não deve depender de consulta síncrona ao catálogo.

Aceite mínimo ainda pendente: publicar pacote depois do build do CRM e instalá-lo pela tela; usar A sem afetar B; recusar ator sem papel, versão incompatível, digest/origem adulterados e payload excessivo; repetir clique/aba; interromper download/ativação e reiniciar; desativar com aba antiga; operar instalado com catálogo desligado e reconectar. Provar erro compreensível e efeito backend, não apenas retorno HTTP.

Para avanço público, faltam ainda autoria/revisão de publicação, biblioteca e operação de confiança, gestão/recuperação de chaves, incidentes/revogação, matriz de compatibilidade e criador externo seguindo documentação. O piloto local não encerra essas lacunas nem o marco 4 executável/de dados.

Método reproduzível: `rg --files` para localizar módulos; `rg -n` para contratos/guards/reconciliação; `nl -ba`/`sed -n` nos arquivos citados; `git rev-parse --short HEAD` e `git branch --show-current`. Fontes primárias externas consultadas em 14/set/2026. Nenhum segredo, serviço ou banco foi acessado.
