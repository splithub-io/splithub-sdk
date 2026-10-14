// `splithub ship` codemod: rewrite source so it behaves like the kept variant, with
// no experiment left. Built on the TypeScript compiler API (passed in, so the CLI only
// loads it for `ship`). Works in passes: each pass makes the edits it can see, the next
// pass re-parses and simplifies what the previous one produced, until nothing changes.
import type * as TS from 'typescript';

export interface ShipTarget {
  id: string;
  keep: string;
  /** The kept variant's value (value and mvt experiments). */
  value?: unknown;
  hasValue: boolean;
}

export interface Leftover {
  line: number;
  text: string;
  reason: string;
}

export interface CodemodResult {
  output: string;
  changed: boolean;
  leftovers: Leftover[];
}

const TRUE = '__splithubShipTrue__';
const FALSE = '__splithubShipFalse__';
const SDK_NAMES = new Set(['Experiment', 'Variant', 'useVariant', 'useValue']);

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** A JS/TS literal for a variant value. */
export function literal(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

function scriptKind(ts: typeof TS, file: string): TS.ScriptKind {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(file)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

function applyEdits(source: string, edits: Edit[]): string {
  // Outermost first; drop edits nested in (or overlapping) one already taken. The next pass gets them.
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  const taken: Edit[] = [];
  for (const e of sorted) if (!taken.some((t) => e.start < t.end && e.end > t.start)) taken.push(e);
  let out = source;
  for (const e of taken.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function indentOf(source: string, pos: number): string {
  const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))![0];
}

/** Shift lines 2..n of `text` left so content written at `from` indentation sits at `to`. */
function reindent(text: string, from: string, to: string): string {
  if (from.length <= to.length) return text;
  const cut = from.length - to.length;
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : line.replace(new RegExp(`^[ \\t]{0,${cut}}`), '')))
    .join('\n');
}

/** Remove a whole statement, its line included when it stands alone. */
function removeStatement(source: string, node: TS.Node, sf: TS.SourceFile): Edit {
  const start = node.getStart(sf);
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const from = source.slice(lineStart, start).trim() === '' ? lineStart : start;
  let end = node.end;
  const lineEnd = source.indexOf('\n', end);
  if (source.slice(end, lineEnd < 0 ? source.length : lineEnd).trim() === '' && from === lineStart) end = lineEnd < 0 ? source.length : lineEnd + 1;
  return { start: from, end, text: '' };
}

function stringValue(ts: typeof TS, node: TS.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isJsxExpression(node) && node.expression) return stringValue(ts, node.expression);
  if (ts.isParenthesizedExpression(node)) return stringValue(ts, node.expression);
  return null;
}

function jsxAttr(ts: typeof TS, el: TS.JsxOpeningLikeElement, name: string): string | null {
  for (const p of el.attributes.properties) {
    if (ts.isJsxAttribute(p) && p.name.getText() === name) return stringValue(ts, p.initializer);
  }
  return null;
}

function tagName(el: TS.JsxOpeningLikeElement): string {
  const t = el.tagName.getText();
  return t.slice(t.lastIndexOf('.') + 1);
}

function skipParensUp(ts: typeof TS, node: TS.Node): TS.Node {
  let n = node;
  while (n.parent && ts.isParenthesizedExpression(n.parent)) n = n.parent;
  return n;
}

const EQ_KINDS = (ts: typeof TS) => [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];

/** `x === 'k'` / `'k' !== x` where x is `node`: the edit that turns it into a marker. */
function comparisonEdit(ts: typeof TS, node: TS.Node, keep: string, sf: TS.SourceFile): Edit | null {
  const n = skipParensUp(ts, node);
  const p = n.parent;
  if (!p || !ts.isBinaryExpression(p) || !EQ_KINDS(ts).includes(p.operatorToken.kind)) return null;
  const other = p.left === n ? p.right : p.left;
  const lit = stringValue(ts, other);
  if (lit === null) return null;
  const negate = p.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || p.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
  const result = (lit === keep) !== negate;
  return { start: p.getStart(sf), end: p.end, text: result ? TRUE : FALSE };
}

/** `switch (x) { case 'k': ... }` where x is `node`: keep the matching branch's statements. */
function switchEdit(ts: typeof TS, node: TS.Node, keep: string, source: string, sf: TS.SourceFile): Edit | null {
  const n = skipParensUp(ts, node);
  const sw = n.parent;
  if (!sw || !ts.isSwitchStatement(sw) || sw.expression !== n) return null;
  const clauses = sw.caseBlock.clauses;
  let idx = clauses.findIndex((c) => ts.isCaseClause(c) && stringValue(ts, c.expression) === keep);
  if (idx < 0) idx = clauses.findIndex((c) => ts.isDefaultClause(c));
  if (idx < 0) return removeStatement(source, sw, sf);
  const stmts: TS.Statement[] = [];
  for (let i = idx; i < clauses.length; i++) {
    const c = clauses[i]!;
    stmts.push(...c.statements);
    if (c.statements.length) break;
  }
  // A block clause `case 'a': { ... }` reads like its body.
  const flat = stmts.length === 1 && ts.isBlock(stmts[0]!) ? [...(stmts[0] as TS.Block).statements] : stmts;
  const body = flat.filter((s, i) => !(i === flat.length - 1 && ts.isBreakStatement(s) && !s.label));
  if (body.length === 0) return removeStatement(source, sw, sf);
  const indent = indentOf(source, sw.getStart(sf));
  const text = reindent(source.slice(body[0]!.getStart(sf), body[body.length - 1]!.end), indentOf(source, body[0]!.getStart(sf)), indent);
  const declares = body.some((s) => ts.isVariableStatement(s) || ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s));
  return { start: sw.getStart(sf), end: sw.end, text: declares ? `{\n${indent}  ${text.split('\n').join(`\n  `)}\n${indent}}` : text };
}

function isJsxChildPosition(ts: typeof TS, node: TS.Node): boolean {
  const p = node.parent;
  return Boolean(p && (ts.isJsxElement(p) || ts.isJsxFragment(p)));
}

/** What replaces `<Experiment>`: the kept `<Variant>`'s children. */
function variantContent(ts: typeof TS, exp: TS.JsxElement, kept: TS.JsxElement | TS.JsxSelfClosingElement | undefined, source: string, sf: TS.SourceFile): string {
  const children = kept && ts.isJsxElement(kept) ? kept.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces)) : [];
  const inJsx = isJsxChildPosition(ts, exp);
  if (children.length === 0) return inJsx ? '' : 'null';
  const first = children[0]!;
  const last = children[children.length - 1]!;
  const startAt = ts.isJsxText(first) ? first.pos + (source.slice(first.pos, first.end).length - source.slice(first.pos, first.end).trimStart().length) : first.getStart(sf);
  const endAt = ts.isJsxText(last) ? last.end - (source.slice(last.pos, last.end).length - source.slice(last.pos, last.end).trimEnd().length) : last.end;
  const raw = reindent(source.slice(startAt, endAt), indentOf(source, startAt), indentOf(source, exp.getStart(sf)));
  if (inJsx) return raw;
  if (children.length === 1) {
    const only = children[0]!;
    if (ts.isJsxElement(only) || ts.isJsxSelfClosingElement(only) || ts.isJsxFragment(only)) return raw;
    if (ts.isJsxExpression(only)) return only.expression ? `(${only.expression.getText(sf)})` : 'null';
  }
  return `<>${raw}</>`;
}

/** Simplify around a marker left by a comparison. */
function markerEdit(ts: typeof TS, node: TS.Identifier, source: string, sf: TS.SourceFile): Edit | null {
  const value = node.text === TRUE;
  const n = skipParensUp(ts, node);
  const p = n.parent;
  if (!p) return null;
  const text = (x: TS.Node) => x.getText(sf);
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return { start: p.getStart(sf), end: p.end, text: value ? FALSE : TRUE };
  if (ts.isConditionalExpression(p) && p.condition === n) {
    const branch = value ? p.whenTrue : p.whenFalse;
    const outer = skipParensUp(ts, p);
    // {cond ? <A /> : <B />} in JSX becomes <A /> itself.
    const jsx = ts.isJsxElement(branch) || ts.isJsxSelfClosingElement(branch) || ts.isJsxFragment(branch);
    if (jsx && outer.parent && ts.isJsxExpression(outer.parent) && isJsxChildPosition(ts, outer.parent)) return { start: outer.parent.getStart(sf), end: outer.parent.end, text: text(branch) };
    return { start: p.getStart(sf), end: p.end, text: text(branch) };
  }
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken && p.left === n) {
      if (value) return { start: p.getStart(sf), end: p.end, text: text(p.right) };
      const outer = skipParensUp(ts, p);
      if (outer.parent && ts.isJsxExpression(outer.parent)) return removeStatement(source, outer.parent, sf);
      return { start: p.getStart(sf), end: p.end, text: FALSE };
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken && p.right === n && value) return { start: p.getStart(sf), end: p.end, text: text(p.left) };
    if (op === ts.SyntaxKind.BarBarToken && p.left === n) return { start: p.getStart(sf), end: p.end, text: value ? TRUE : text(p.right) };
    if (op === ts.SyntaxKind.BarBarToken && p.right === n && !value) return { start: p.getStart(sf), end: p.end, text: text(p.left) };
  }
  if (ts.isIfStatement(p) && p.expression === n) {
    const branch = value ? p.thenStatement : p.elseStatement;
    const inBlock = p.parent && (ts.isBlock(p.parent) || ts.isSourceFile(p.parent) || ts.isCaseClause(p.parent) || ts.isDefaultClause(p.parent));
    if (!branch) return inBlock ? removeStatement(source, p, sf) : { start: p.getStart(sf), end: p.end, text: '{}' };
    if (inBlock && ts.isBlock(branch)) {
      if (branch.statements.length === 0) return removeStatement(source, p, sf);
      const declares = branch.statements.some((s) => ts.isVariableStatement(s) || ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s));
      if (!declares) {
        const first = branch.statements[0]!.getStart(sf);
        const body = source.slice(first, branch.statements[branch.statements.length - 1]!.end);
        return { start: p.getStart(sf), end: p.end, text: reindent(body, indentOf(source, first), indentOf(source, p.getStart(sf))) };
      }
    }
    return { start: p.getStart(sf), end: p.end, text: text(branch) };
  }
  return null;
}

function isUseCall(ts: typeof TS, node: TS.Node, name: string, id: string): node is TS.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
  return calleeName === name && stringValue(ts, node.arguments[0]) === id;
}

function enclosingScope(ts: typeof TS, node: TS.Node): TS.Node {
  let n: TS.Node = node.parent;
  while (n && !ts.isFunctionLike(n) && !ts.isSourceFile(n)) n = n.parent;
  return n;
}

function onePass(ts: typeof TS, file: string, source: string, target: ShipTarget, leftovers: Map<string, Leftover>): string {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
  const edits: Edit[] = [];
  const note = (node: TS.Node, reason: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const text = source.split('\n')[line - 1]?.trim() ?? '';
    leftovers.set(`${text}|${reason}`, { line, text, reason });
  };
  const visit = (node: TS.Node): void => {
    // <Experiment id="..."> … </Experiment>
    if (ts.isJsxElement(node) && tagName(node.openingElement) === 'Experiment' && jsxAttr(ts, node.openingElement, 'id') === target.id) {
      const variants = node.children.filter((c): c is TS.JsxElement | TS.JsxSelfClosingElement => (ts.isJsxElement(c) && tagName(c.openingElement) === 'Variant') || (ts.isJsxSelfClosingElement(c) && tagName(c) === 'Variant'));
      const kept = variants.find((v) => jsxAttr(ts, ts.isJsxElement(v) ? v.openingElement : v, 'name') === target.keep);
      if (!kept) note(node, `no <Variant name="${target.keep}"> in this <Experiment>`);
      else {
        edits.push({ start: node.getStart(sf), end: node.end, text: variantContent(ts, node, kept, source, sf) });
        return;
      }
    }
    // useValue('<id>') / sh.value('<id>')
    if (isUseCall(ts, node, 'useValue', target.id) || isUseCall(ts, node, 'value', target.id)) {
      if (target.hasValue) edits.push({ start: node.getStart(sf), end: node.end, text: literal(target.value) });
      else note(node, 'reads a value, but this experiment has no values');
      return;
    }
    // useVariant('<id>')
    if (isUseCall(ts, node, 'useVariant', target.id)) {
      const direct = comparisonEdit(ts, node, target.keep, sf) ?? switchEdit(ts, node, target.keep, source, sf);
      if (direct) edits.push(direct);
      else {
        const decl = skipParensUp(ts, node).parent;
        if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
          const name = decl.name.text;
          const scope = enclosingScope(ts, decl);
          const refs: TS.Identifier[] = [];
          const find = (n: TS.Node): void => {
            if (ts.isIdentifier(n) && n.text === name && n !== decl.name && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) refs.push(n);
            ts.forEachChild(n, find);
          };
          find(scope);
          const rewrites = refs.map((r) => comparisonEdit(ts, r, target.keep, sf) ?? switchEdit(ts, r, target.keep, source, sf)).filter((e): e is Edit => e !== null);
          if (rewrites.length) edits.push(...rewrites);
          else if (refs.length === 0 && ts.isVariableDeclarationList(decl.parent) && decl.parent.declarations.length === 1 && ts.isVariableStatement(decl.parent.parent)) edits.push(removeStatement(source, decl.parent.parent, sf));
          else edits.push({ start: node.getStart(sf), end: node.end, text: literal(target.keep) });
        } else edits.push({ start: node.getStart(sf), end: node.end, text: literal(target.keep) });
      }
      return;
    }
    if (ts.isIdentifier(node) && (node.text === TRUE || node.text === FALSE)) {
      const e = markerEdit(ts, node, source, sf);
      if (e) edits.push(e);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return applyEdits(source, edits);
}

/** Drop now-unused Experiment / Variant / useVariant / useValue imports from @splithub/*. */
function cleanImports(ts: typeof TS, file: string, source: string): string {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
  const used = new Map<string, number>();
  const count = (n: TS.Node): void => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isIdentifier(n)) used.set(n.text, (used.get(n.text) ?? 0) + 1);
    ts.forEachChild(n, count);
  };
  count(sf);
  const edits: Edit[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('@splithub/')) continue;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    const drop = named.elements.filter((el) => SDK_NAMES.has((el.propertyName ?? el.name).text) && !used.get(el.name.text));
    if (drop.length === 0) continue;
    const keepEls = named.elements.filter((el) => !drop.includes(el));
    if (keepEls.length === 0 && !st.importClause?.name) edits.push(removeStatement(source, st, sf));
    else if (keepEls.length === 0) edits.push({ start: st.importClause!.name!.end, end: named.end, text: '' });
    else edits.push({ start: named.getStart(sf), end: named.end, text: `{ ${keepEls.map((e) => e.getText(sf)).join(', ')} }` });
  }
  return applyEdits(source, edits);
}

/** Rewrite one file for the kept variant. */
export function shipSource(ts: typeof TS, file: string, source: string, target: ShipTarget): CodemodResult {
  const leftovers = new Map<string, Leftover>();
  let current = source;
  for (let i = 0; i < 12; i++) {
    const next = onePass(ts, file, current, target, leftovers);
    if (next === current) break;
    current = next;
  }
  current = current.split(TRUE).join('true').split(FALSE).join('false');
  const changed = current !== source;
  if (changed) current = cleanImports(ts, file, current);
  // Whatever still names the experiment needs a human (or agent) look.
  const quotes = [`'${target.id}'`, `"${target.id}"`, `\`${target.id}\``];
  const remaining = new Map<number, Leftover>();
  current.split('\n').forEach((text, i) => {
    if (quotes.some((q) => text.includes(q))) remaining.set(i + 1, { line: i + 1, text: text.trim(), reason: [...leftovers.values()].find((l) => l.text === text.trim())?.reason ?? "still mentions the experiment; rewrite it by hand" });
  });
  return { output: current, changed, leftovers: [...remaining.values()] };
}
