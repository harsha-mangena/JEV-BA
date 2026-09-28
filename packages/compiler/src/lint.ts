import ts from 'typescript';

/** The only module generated specs may import, and the only names they may take from it. */
const ALLOWED_IMPORTS: Record<string, ReadonlySet<string>> = { '@playwright/test': new Set(['expect', 'test']) };
/** Environment variables a generated spec may read. */
const ALLOWED_ENV = new Set(['QA_BASE_URL', 'QA_FIXTURE_TOKEN']);
const FORBIDDEN_GLOBALS = new Set(['require', 'module', 'exports', 'globalThis', 'global', 'eval', 'Function', 'Deno', 'Bun', '__dirname', '__filename', 'WebAssembly', 'Worker', 'SharedArrayBuffer', 'Atomics']);
const FORBIDDEN_MEMBERS = new Set(['evaluate', 'evaluateHandle', 'addScriptTag', 'addInitScript', 'exposeFunction', 'exposeBinding', 'route', 'routeFromHAR', 'setExtraHTTPHeaders', 'setInputFiles', 'skip', 'fixme', 'only', 'soft', 'fail', 'slow', 'constructor', '__proto__', 'prototype']);

/**
 * Syntax-level policy for generated or repaired specs. It parses the source
 * (so aliases, re-spellings and string tricks that defeat a regex are seen for
 * what they are) and allows only a small, known vocabulary. It is a first
 * filter; the namespace sandbox is the boundary.
 */
export function astLintGeneratedSpec(source: string): string[] {
  const issues = new Set<string>();
  const sf = ts.createSourceFile('generated.spec.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const diag = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diag.length) issues.add(`source does not parse: ${ts.flattenDiagnosticMessageText(diag[0]!.messageText, ' ')}`);
  const at = (n: ts.Node) => `line ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const from = ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : '<dynamic>';
      const allowed = ALLOWED_IMPORTS[from];
      if (!allowed) issues.add(`import from "${from}" is not allowed (${at(n)})`);
      else {
        const c = n.importClause;
        if (!c || c.name || !c.namedBindings) issues.add(`only named imports of ${[...allowed].join(', ')} are allowed (${at(n)})`);
        const nb = c?.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) issues.add(`namespace import of "${from}" is not allowed (${at(n)})`);
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!allowed.has((el.propertyName ?? el.name).text)) issues.add(`import of "${(el.propertyName ?? el.name).text}" from "${from}" is not allowed (${at(n)})`);
      }
    } else if (ts.isExportDeclaration(n) || ts.isExportAssignment(n) || ts.isImportEqualsDeclaration(n)) {
      issues.add(`module exports and import-equals are not allowed (${at(n)})`);
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      issues.add(`dynamic import() is not allowed (${at(n)})`);
    } else if (ts.isMetaProperty(n)) {
      issues.add(`import.meta/new.target is not allowed (${at(n)})`);
    } else if (ts.isIdentifier(n) && FORBIDDEN_GLOBALS.has(n.text) && !isPropertyName(n)) {
      issues.add(`use of "${n.text}" is not allowed (${at(n)})`);
    } else if (ts.isIdentifier(n) && n.text === 'process' && !isPropertyName(n)) {
      const env = n.parent;
      const ok = ts.isPropertyAccessExpression(env) && env.expression === n && env.name.text === 'env' && ts.isPropertyAccessExpression(env.parent) && env.parent.expression === env && ALLOWED_ENV.has(env.parent.name.text);
      if (!ok) issues.add(`process access other than process.env.{${[...ALLOWED_ENV].join(',')}} is not allowed (${at(n)})`);
    } else if (ts.isPropertyAccessExpression(n) && FORBIDDEN_MEMBERS.has(n.name.text)) {
      issues.add(`.${n.name.text} is not allowed (${at(n)})`);
    } else if (ts.isElementAccessExpression(n) && !ts.isNumericLiteral(n.argumentExpression) && !isSafeIndex(n)) {
      issues.add(`computed member access is not allowed (${at(n)})`);
    } else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'force' && n.initializer.kind !== ts.SyntaxKind.FalseKeyword) {
      issues.add(`forced actions are not allowed (${at(n)})`);
    } else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Function') {
      issues.add(`new Function is not allowed (${at(n)})`);
    } else if (ts.isTaggedTemplateExpression(n)) {
      issues.add(`tagged templates are not allowed (${at(n)})`);
    } else if (ts.isWithStatement(n) || n.kind === ts.SyntaxKind.DebuggerStatement) {
      issues.add(`with/debugger statements are not allowed (${at(n)})`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...issues];
}

function isPropertyName(n: ts.Identifier): boolean {
  const p = n.parent;
  return (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isPropertySignature(p) && p.name === n) || (ts.isImportSpecifier(p) && p.propertyName === n);
}

/** `obj[key]` where key is a plain identifier or string literal read from typed records the emitter produces. */
function isSafeIndex(n: ts.ElementAccessExpression): boolean {
  const a = n.argumentExpression;
  if (ts.isStringLiteral(a)) return !FORBIDDEN_MEMBERS.has(a.text) && !FORBIDDEN_GLOBALS.has(a.text) && a.text !== 'process';
  return ts.isIdentifier(a);
}
