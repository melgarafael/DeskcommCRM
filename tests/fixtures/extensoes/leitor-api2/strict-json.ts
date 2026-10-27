import * as jsoncParser from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

import { ExtensionError } from "./errors";

export interface StrictJsonLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxPropertiesPerObject: number;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

// O pacote publica enums reais em runtime, embora seu .d.ts os declare como `const enum`.
// Este adaptador usa os valores publicados e continua compatível com isolatedModules.
const runtimeEnums = jsoncParser as unknown as {
  ScanError: { None: number };
  SyntaxKind: Record<
    | "EOF"
    | "LineCommentTrivia"
    | "BlockCommentTrivia"
    | "Unknown"
    | "OpenBraceToken"
    | "OpenBracketToken"
    | "CloseBraceToken"
    | "CloseBracketToken"
    | "StringLiteral"
    | "NumericLiteral"
    | "NullKeyword"
    | "TrueKeyword"
    | "FalseKeyword",
    number
  >;
};
const JSON_SCAN_ERROR = runtimeEnums.ScanError;
const JSON_TOKEN = runtimeEnums.SyntaxKind;

function invalid(cause?: unknown): never {
  throw new ExtensionError(
    "extension_invalid_package",
    cause === undefined ? undefined : { cause },
  );
}

function tooLarge(): never {
  throw new ExtensionError("extension_payload_too_large");
}

function validateLimits(limits: StrictJsonLimits) {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("Os limites do parser JSON devem ser inteiros positivos.");
    }
  }
}

function isJsonbSafeString(value: string) {
  if (value.includes("\0")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Faz a varredura de custo limitado antes de chamar o parser recursivo.
 * A varredura não monta árvore nem objeto JavaScript.
 */
function scanBeforeParse(text: string, limits: StrictJsonLimits) {
  const scanner = jsoncParser.createScanner(text, false);
  let depth = 0;
  let nodes = 0;

  for (;;) {
    const token = scanner.scan();
    if (scanner.getTokenError() !== JSON_SCAN_ERROR.None) invalid();
    if (token === JSON_TOKEN.EOF) break;

    if (
      token === JSON_TOKEN.LineCommentTrivia ||
      token === JSON_TOKEN.BlockCommentTrivia ||
      token === JSON_TOKEN.Unknown
    ) {
      invalid();
    }

    if (token === JSON_TOKEN.OpenBraceToken || token === JSON_TOKEN.OpenBracketToken) {
      depth += 1;
      nodes += 1;
      if (depth > limits.maxDepth || nodes > limits.maxNodes) tooLarge();
      continue;
    }

    if (token === JSON_TOKEN.CloseBraceToken || token === JSON_TOKEN.CloseBracketToken) {
      if (depth === 0) invalid();
      depth -= 1;
      continue;
    }

    if (
      token === JSON_TOKEN.StringLiteral ||
      token === JSON_TOKEN.NumericLiteral ||
      token === JSON_TOKEN.NullKeyword ||
      token === JSON_TOKEN.TrueKeyword ||
      token === JSON_TOKEN.FalseKeyword
    ) {
      if (token === JSON_TOKEN.StringLiteral && !isJsonbSafeString(scanner.getTokenValue())) {
        invalid();
      }
      nodes += 1;
      if (nodes > limits.maxNodes) tooLarge();
    }
  }
}

function validateKeysAndWidth(text: string, limits: StrictJsonLimits) {
  const objectKeys: Array<Set<string>> = [];
  let parseFailed = false;

  jsoncParser.visit(
    text,
    {
      onObjectBegin: () => {
        objectKeys.push(new Set());
      },
      onObjectProperty: (property) => {
        const keys = objectKeys.at(-1);
        if (!keys || FORBIDDEN_KEYS.has(property) || keys.has(property)) invalid();
        keys.add(property);
        if (keys.size > limits.maxPropertiesPerObject) tooLarge();
      },
      onObjectEnd: () => {
        objectKeys.pop();
      },
      onError: () => {
        parseFailed = true;
      },
    },
    { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
  );

  if (parseFailed) invalid();
}

export function parseStrictJson(bytes: Uint8Array, limits: StrictJsonLimits): unknown {
  validateLimits(limits);
  if (bytes.byteLength > limits.maxBytes) tooLarge();
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) invalid();

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    invalid(error);
  }

  scanBeforeParse(text, limits);
  validateKeysAndWidth(text, limits);

  const errors: ParseError[] = [];
  const value: unknown = jsoncParser.parse(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
    allowEmptyContent: false,
  });
  if (errors.length > 0 || value === undefined) invalid();
  return value;
}
