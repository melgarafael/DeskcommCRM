<?php
/**
 * ServicoNfe — a ponte fina entre o contrato JSON do app e o sped-nfe.
 *
 * Magro de propósito: TODO dado fiscal (emitente, itens, impostos) chega
 * pronto no payload; aqui só se monta, assina e transmite. Imposto NÃO é
 * deduzido nem presumido — item sem configuração tributária volta 422 com o
 * nome do campo, porque alíquota errada é crime fiscal e alíquota ausente é
 * só um 422.
 *
 * CRT 1 (Simples): CSOSN 102 por item, sem destaque (o padrão honesto de quem
 * não informou tributação). CRT 2/3: exige por item {cst, aliquota_pct} —
 * sem isso, recusa em vez de chutar 18%.
 */

declare(strict_types=1);

namespace FiscalSidecar;

use NFePHP\Common\Certificate;
use NFePHP\NFe\Complements;
use NFePHP\NFe\Make;
use NFePHP\NFe\Tools;

class ServicoNfe
{
    /** @var array<string,mixed> */
    private array $config;
    /** @var array<string,mixed> */
    private array $pedido;
    /** @var array<int,array<string,mixed>> */
    private array $itens;
    private string $certPath;
    private string $certSenha;

    /**
     * @param array<string,mixed> $payload Contrato documentado no README (seção Contrato).
     */
    public function __construct(array $payload)
    {
        $this->config = $payload['config'] ?? [];
        $this->pedido = $payload['pedido'] ?? [];
        $this->itens = $payload['itens'] ?? [];
        $this->certPath = (string)($payload['certificado_arquivo'] ?? '');
        $this->certSenha = (string)($payload['certificado_senha'] ?? '');
    }

    /** @return array<string,mixed> */
    public function emitir(): array
    {
        $erro = $this->validar();
        if ($erro !== null) {
            return ['ok' => false, 'codigo' => 'VALIDACAO', 'mensagem' => $erro];
        }
        try {
            $pfx = @file_get_contents($this->certPath);
            if ($pfx === false) {
                return ['ok' => false, 'codigo' => 'CERT_NAO_LIDO', 'mensagem' => 'Arquivo de certificado não legível no volume /certs.'];
            }
            $cert = Certificate::readPfx($pfx, $this->certSenha);

            $tools = new Tools($this->montarConfigTools(), $cert);
            $tools->model('55');

            $make = new Make();
            $this->montarNFe($make);
            $make->montaNFe();
            $xmlAssinado = $tools->signNFe($make->getXML());

            $lote = (string)(time() % 1000000000);
            $resp = $tools->sefazEnviaLote([$xmlAssinado], '', $lote);
            $std = json_decode($resp);

            $cstat = (string)($std->cStat ?? '');
            $xmotivo = (string)($std->xMotivo ?? '');
            // 103 = lote recebido (assíncrono): buscar recibo. 104 = processado.
            if ($cstat === '104' && isset($std->protNFe->infProt)) {
                $inf = $std->protNFe->infProt;
                $cstatProt = (string)($inf->cStat ?? '');
                if ($cstatProt === '100') {
                    $xmlAutorizado = Complements::toAuthorize($xmlAssinado, json_encode($std));
                    return [
                        'ok' => true,
                        'chave' => (string)($inf->chNFe ?? ''),
                        'protocolo' => (string)($inf->nProt ?? ''),
                        'numero' => (int)($this->pedido['numero_nota'] ?? 0) ?: null,
                        'serie' => (string)($this->config['serie'] ?? '1'),
                        'xml' => $xmlAutorizado,
                        'cstat' => $cstatProt,
                        'xmotivo' => (string)($inf->xMotivo ?? ''),
                    ];
                }
                return ['ok' => false, 'codigo' => 'SEFAZ_' . $cstatProt, 'mensagem' => (string)($inf->xMotivo ?? '')];
            }
            if ($cstat === '103') {
                return ['ok' => false, 'codigo' => 'LOTE_RECEBIDO', 'mensagem' => 'Lote recebido, recibo pendente de consulta.', 'recibo' => (string)($std->infRec->nRec ?? '')];
            }
            return ['ok' => false, 'codigo' => 'SEFAZ_' . $cstat, 'mensagem' => $xmotivo];
        } catch (\Throwable $e) {
            return ['ok' => false, 'codigo' => 'EXCECAO', 'mensagem' => substr($e->getMessage(), 0, 500)];
        }
    }

    /** @return array<string,mixed> */
    public function cancelar(array $payload): array
    {
        $chave = (string)($payload['chave'] ?? '');
        $protocolo = (string)($payload['protocolo'] ?? '');
        $justificativa = (string)($payload['justificativa'] ?? '');
        if ($chave === '' || $protocolo === '' || mb_strlen($justificativa) < 15) {
            return ['ok' => false, 'codigo' => 'VALIDACAO', 'mensagem' => 'Chave, protocolo e justificativa (15+ letras) são obrigatórios.'];
        }
        try {
            $pfx = @file_get_contents($this->certPath);
            if ($pfx === false) {
                return ['ok' => false, 'codigo' => 'CERT_NAO_LIDO', 'mensagem' => 'Arquivo de certificado não legível no volume /certs.'];
            }
            $cert = Certificate::readPfx($pfx, $this->certSenha);
            $tools = new Tools($this->montarConfigTools($payload['config'] ?? []), $cert);
            $tools->model('55');
            $resp = $tools->sefazCancela($chave, $justificativa, $protocolo);
            $std = json_decode($resp);
            $cstat = (string)(($std->retEvento->infEvento->cStat ?? ''));
            if ($cstat === '135') {
                return ['ok' => true, 'protocolo_cancelamento' => (string)($std->retEvento->infEvento->nProt ?? '')];
            }
            return ['ok' => false, 'codigo' => 'SEFAZ_' . $cstat, 'mensagem' => (string)($std->retEvento->infEvento->xMotivo ?? '')];
        } catch (\Throwable $e) {
            return ['ok' => false, 'codigo' => 'EXCECAO', 'mensagem' => substr($e->getMessage(), 0, 500)];
        }
    }

    /** @return array<string,mixed> */
    public static function danfe(string $xml): array
    {
        if (!class_exists('NFePHP\\DA\\NFe\\Danfe')) {
            return ['ok' => false, 'codigo' => 'DANFE_INDISPONIVEL', 'mensagem' => 'Pacote sped-da não instalado. Rode composer require nfephp-org/sped-da.'];
        }
        try {
            $danfe = new \NFePHP\DA\NFe\Danfe($xml);
            $danfe->debugMode(false);
            $pdf = $danfe->render();
            return ['ok' => true, 'pdf_base64' => base64_encode($pdf)];
        } catch (\Throwable $e) {
            return ['ok' => false, 'codigo' => 'EXCECAO', 'mensagem' => substr($e->getMessage(), 0, 500)];
        }
    }

    private function validar(): ?string
    {
        foreach (['cnpj', 'razao', 'ie', 'crt', 'serie'] as $campo) {
            if (empty($this->config[$campo])) {
                return 'config.' . $campo . ' é obrigatório.';
            }
        }
        if ($this->certPath === '' || $this->certSenha === '') {
            return 'certificado_arquivo e certificado_senha são obrigatórios.';
        }
        if (strpos($this->certPath, '/certs/') !== 0) {
            return 'certificado_arquivo deve estar dentro de /certs/.';
        }
        if (empty($this->itens)) {
            return 'Ao menos 1 item é obrigatório.';
        }
        $crt = (string)$this->config['crt'];
        foreach ($this->itens as $i => $item) {
            if (empty($item['codigo']) || empty($item['descricao']) || empty($item['quantidade'])) {
                return 'Item ' . ($i + 1) . ': codigo, descricao e quantidade são obrigatórios.';
            }
            if (($crt === '2' || $crt === '3') && (empty($item['cst']) || !isset($item['aliquota_pct']))) {
                return 'Item ' . ($i + 1) . ': CRT 2/3 exige cst e aliquota_pct — sem isso, recuso em vez de chutar alíquota.';
            }
        }
        return null;
    }

    /** @return string */
    private function montarConfigTools(?array $config = null): string
    {
        $c = $config ?? $this->config;
        $tpAmb = (($c['ambiente'] ?? 'homologacao') === 'producao') ? 1 : 2;
        return json_encode([
            'atualizacao' => date('Y-m-d H:i:s'),
            'tpAmb' => $tpAmb,
            'razaosocial' => $c['razao'],
            'cnpj' => preg_replace('/\D/', '', (string)$c['cnpj']),
            'ie' => preg_replace('/\D/', '', (string)$c['ie']),
            'crt' => (string)$c['crt'],
            'scheme' => 'PL_010',
            'versao' => '4.00',
        ]);
    }

    private function montarNFe(Make $make): void
    {
        $c = $this->config;
        $p = $this->pedido;
        $serie = (int)($c['serie'] ?? 1);
        $tpAmb = (($c['ambiente'] ?? 'homologacao') === 'producao') ? 1 : 2;

        $make->taginfNFe(['versao' => '4.00']);
        $make->tagide([
            'cUF' => $this->codigoUf((string)($c['uf'] ?? '')),
            'cNF' => substr((string)time(), -8),
            'natOp' => (string)($c['natureza'] ?? 'VENDA'),
            'mod' => '55',
            'serie' => (string)$serie,
            'nNF' => (string)($p['numero_nota'] ?? 1),
            'dhEmi' => date('Y-m-d\TH:i:sP'),
            'tpNF' => '1',
            'idDest' => '1',
            'cMunFG' => (string)($c['codigo_municipio'] ?? ''),
            'tpImp' => '1',
            'tpEmis' => '1',
            'cDV' => '0',
            'tpAmb' => (string)$tpAmb,
            'finNFe' => '1',
            'indFinal' => '1',
            'indPres' => '9',
            'procEmi' => '0',
            'verProc' => 'deskcomm-fiscal-sidecar/1.0',
        ]);
        $make->tagemit([
            'xNome' => (string)$c['razao'],
            'CNPJ' => preg_replace('/\D/', '', (string)$c['cnpj']),
            'IE' => preg_replace('/\D/', '', (string)$c['ie']),
            'CRT' => (string)$c['crt'],
        ]);
        $make->tagenderEmit([
            'xLgr' => (string)($c['logradouro'] ?? ''),
            'nro' => (string)($c['numero_end'] ?? 'S/N'),
            'xBairro' => (string)($c['bairro'] ?? ''),
            'cMun' => (string)($c['codigo_municipio'] ?? ''),
            'xMun' => (string)($c['municipio'] ?? ''),
            'UF' => (string)($c['uf'] ?? ''),
            'CEP' => preg_replace('/\D/', '', (string)($c['cep'] ?? '')),
        ]);
        $destDoc = preg_replace('/\D/', '', (string)($p['documento'] ?? ''));
        $dest = ['xNome' => (string)($p['nome'] ?? ''), 'indIEDest' => '9'];
        if (strlen($destDoc) === 14) {
            $dest['CNPJ'] = $destDoc;
        } elseif (strlen($destDoc) === 11) {
            $dest['CPF'] = $destDoc;
        }
        $make->tagdest($dest);

        $n = 0;
        foreach ($this->itens as $item) {
            $n++;
            $qtd = (float)$item['quantidade'];
            $unit = ((float)($item['preco_cents'] ?? 0)) / 100;
            $descPct = (float)($item['desconto_pct'] ?? 0);
            $unitLiquido = round($unit * (1 - $descPct / 100), 2);
            $make->tagprod([
                'nItem' => (string)$n,
                'cProd' => (string)$item['codigo'],
                'cEAN' => 'SEM GTIN',
                'xProd' => (string)$item['descricao'],
                'NCM' => preg_replace('/\D/', '', (string)($item['ncm'] ?? '00000000')),
                'CFOP' => (string)($item['cfop'] ?? $c['cfop'] ?? '5102'),
                'uCom' => (string)($item['unidade'] ?? 'UN'),
                'qCom' => number_format($qtd, 4, '.', ''),
                'vUnCom' => number_format($unitLiquido, 2, '.', ''),
                'vProd' => number_format(round($qtd * $unitLiquido, 2), 2, '.', ''),
                'cEANTrib' => 'SEM GTIN',
                'uTrib' => (string)($item['unidade'] ?? 'UN'),
                'qTrib' => number_format($qtd, 4, '.', ''),
                'vUnTrib' => number_format($unitLiquido, 2, '.', ''),
                'indTot' => '1',
            ]);
            $crt = (string)$c['crt'];
            if ($crt === '1') {
                $make->tagICMSSN([
                    'nItem' => (string)$n,
                    'CSOSN' => (string)($item['csosn'] ?? '102'),
                    'orig' => '0',
                ]);
            } else {
                $make->tagICMS([
                    'nItem' => (string)$n,
                    'CST' => (string)($item['cst'] ?? '00'),
                    'modBC' => '3',
                    'vBC' => number_format(round($qtd * $unitLiquido, 2), 2, '.', ''),
                    'pICMS' => number_format((float)($item['aliquota_pct'] ?? 0), 2, '.', ''),
                    'vICMS' => number_format(round($qtd * $unitLiquido * ((float)($item['aliquota_pct'] ?? 0)) / 100, 2), 2, '.', ''),
                    'orig' => '0',
                ]);
            }
            $make->tagPIS([
                'nItem' => (string)$n,
                'CST' => '07',
            ]);
            $make->tagCOFINS([
                'nItem' => (string)$n,
                'CST' => '07',
            ]);
        }

        $vNF = 0.0;
        foreach ($this->itens as $item) {
            $qtd = (float)$item['quantidade'];
            $unit = ((float)($item['preco_cents'] ?? 0)) / 100;
            $descPct = (float)($item['desconto_pct'] ?? 0);
            $vNF += round($qtd * $unit * (1 - $descPct / 100), 2);
        }
        $vNF = round($vNF + ((float)($p['frete_cents'] ?? 0)) / 100, 2);
        $make->tagICMSTot([
            'vBC' => '0.00',
            'vICMS' => '0.00',
            'vICMSDeson' => '0.00',
            'vFCP' => '0.00',
            'vBCST' => '0.00',
            'vST' => '0.00',
            'vFCPST' => '0.00',
            'vFCPSTRet' => '0.00',
            'vProd' => number_format($vNF, 2, '.', ''),
            'vFrete' => number_format(((float)($p['frete_cents'] ?? 0)) / 100, 2, '.', ''),
            'vSeg' => '0.00',
            'vDesc' => '0.00',
            'vII' => '0.00',
            'vIPI' => '0.00',
            'vIPIDevol' => '0.00',
            'vPIS' => '0.00',
            'vCOFINS' => '0.00',
            'vOutro' => '0.00',
            'vNF' => number_format($vNF, 2, '.', ''),
        ]);
        $make->tagtransp(['modFrete' => '9']);
        $make->tagpag(['tPag' => '99', 'vPag' => number_format($vNF, 2, '.', '')]);
    }

    private function codigoUf(string $uf): string
    {
        $mapa = [
            'RO' => '11', 'AC' => '12', 'AM' => '13', 'RR' => '14', 'PA' => '15',
            'AP' => '16', 'TO' => '17', 'MA' => '21', 'PI' => '22', 'CE' => '23',
            'RN' => '24', 'PB' => '25', 'PE' => '26', 'AL' => '27', 'SE' => '28',
            'BA' => '29', 'MG' => '31', 'ES' => '32', 'RJ' => '33', 'SP' => '35',
            'PR' => '41', 'SC' => '42', 'RS' => '43', 'MS' => '50', 'MT' => '51',
            'GO' => '52', 'DF' => '53',
        ];
        $uf = strtoupper(trim($uf));
        return $mapa[$uf] ?? '';
    }
}
