/** Position-preserving lexical helpers shared by the static review rules. */
export interface Span { start: number; end: number; text: string; kind: 'comment' | 'string'; }
interface LexicalEntry { spans?: readonly Span[]; masks: Map<string, string>; }
// Pure, bounded content cache: no paths, diagnostics or filesystem facts are cached.
const lexicalCache = new Map<string, LexicalEntry>();
let cachedCharacters = 0;
function lexicalEntry(code: string): LexicalEntry {
    const existing = lexicalCache.get(code);
    if (existing) { lexicalCache.delete(code); lexicalCache.set(code, existing); return existing; }
    const entry: LexicalEntry = { masks: new Map() };
    if (code.length > 500000) { return entry; }
    lexicalCache.set(code, entry); cachedCharacters += code.length;
    while (lexicalCache.size > 32 || cachedCharacters > 2000000) {
        const oldest = lexicalCache.keys().next().value!;
        lexicalCache.delete(oldest); cachedCharacters -= oldest.length;
    }
    return entry;
}

export function triviaSpans(code: string): readonly Span[] {
    const entry = lexicalEntry(code);
    if (entry.spans) { return entry.spans; }
    const spans: Span[] = [];
    for (let i = 0; i < code.length;) {
        const start = i;
        if (code.startsWith('/*', i)) {
            const close = code.indexOf('*/', i + 2);
            i = close < 0 ? code.length : close + 2;
            spans.push({ start, end: i, text: code.slice(start, i), kind: 'comment' });
        } else if (code.startsWith('--', i)) {
            const close = code.indexOf('\n', i + 2);
            i = close < 0 ? code.length : close;
            spans.push({ start, end: i, text: code.slice(start, i), kind: 'comment' });
        } else if (code[i] === "'" || code[i] === '"') {
            const quote = code[i++];
            while (i < code.length) {
                if (code[i] === quote && code[i + 1] === quote) { i += 2; }
                else if (code[i] === quote) { i++; break; }
                else if (code[i] === '\\') { i = Math.min(i + 2, code.length); }
                else { i++; }
            }
            spans.push({ start, end: i, text: code.slice(start, i), kind: 'string' });
        } else { i++; }
    }
    entry.spans = spans;
    return spans;
}

export function maskCode(code: string, strings = true, quotedIdentifiers = false): string {
    const entry = lexicalEntry(code), key = `${strings}/${quotedIdentifiers}`;
    const cached = entry.masks.get(key);
    if (cached !== undefined) { return cached; }
    const chars = code.split('');
    for (const span of triviaSpans(code)) {
        if (span.kind === 'string' && !strings) { continue; }
        if (span.kind === 'string' && quotedIdentifiers && span.text.startsWith('"')) { continue; }
        for (let i = span.start; i < span.end; i++) {
            if (chars[i] !== '\r' && chars[i] !== '\n') { chars[i] = ' '; }
        }
    }
    const result = chars.join('');
    entry.masks.set(key, result);
    return result;
}

export function maskXmlComments(text: string): string {
    return text.replace(/<!--[\s\S]*?-->/g, s => s.replace(/[^\r\n]/g, ' '));
}

export function matching(code: string, open: number, left = '(', right = ')'): number {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === left) { depth++; }
        if (code[i] === right && --depth === 0) { return i; }
    }
    return -1;
}

export function adjacentComments(code: string, start: number, end: number, inner?: number): string[] {
    const comments = triviaSpans(code).filter(s => s.kind === 'comment');
    const clean = maskCode(code, false);
    const result: string[] = [];
    const backwards = (boundary: number, lower = -1) => {
        let cursor = boundary;
        for (let i = comments.length - 1; i >= 0; i--) {
            const span = comments[i];
            if (span.end > boundary) { continue; }
            if (span.start <= lower || clean.slice(span.end, cursor).trim()) { break; }
            result.push(span.text); cursor = span.start;
        }
    };
    backwards(start);
    let cursor = end;
    for (const span of comments) {
        if (span.start < end) { continue; }
        if (clean.slice(cursor, span.start).trim()) { break; }
        result.push(span.text); cursor = span.end;
    }
    if (inner !== undefined) { backwards(inner, start); }
    return result;
}

export function catchArguments(code: string, start: number, end: number): string[][] {
    const mask = maskCode(code), locations = [end], groups: number[] = [];
    for (let i = 0; i < start; i++) {
        if (mask[i] === '{') { groups.push(i); }
        if (mask[i] === '}') { groups.pop(); }
    }
    for (const open of groups) {
        const close = matching(mask, open, '{', '}');
        if (close > end) { locations.push(close); }
    }
    return locations.flatMap(location => {
        const catcher = /^\s*catch\s*\(([^)]*)\)/i.exec(mask.slice(location + 1));
        const args = catcher?.[1].split(',').map(code => code.trim()).filter(Boolean);
        return args?.length ? [args] : [];
    });
}

export interface CommandCall { start: number; end: number; mask: string; text: string; }
export function commandCalls(code: string): CommandCall[] {
    const mask = maskCode(code);
    const starts: number[] = [];
    let expected = true, brackets = 0, parentheses = 0, waiting = false;
    let condition: number | undefined;
    for (const m of mask.matchAll(/\|\||[a-z_$#][\w$#]*|[^\s]/gi)) {
        const token = m[0].toLowerCase();
        if (token === '[') { brackets++; expected = false; continue; }
        if (brackets) { if (token === ']') { brackets--; } continue; }
        if (token === '(') { parentheses++; if (waiting) { condition = parentheses; waiting = false; } continue; }
        if (parentheses) {
            if (token === ')') { if (parentheses === condition) { expected = true; condition = undefined; } parentheses--; }
            continue;
        }
        if (['|', ';', '{', '}', 'else'].includes(token)) { expected = true; continue; }
        if ((expected && token === 'if') || (token === 'catch' && /^\s*\(/.test(mask.slice(m.index! + token.length)))) {
            waiting = true; expected = false; continue;
        }
        if (expected && token === '^') { continue; }
        if (expected && /^[a-z]/i.test(token)) { starts.push(m.index!); }
        expected = false;
    }
    return starts.map(start => {
        let end = start, depth = 0;
        for (; end < mask.length; end++) {
            const c = mask[end];
            if (c === '(') { depth++; }
            else if (c === ')') { depth--; }
            else if (!depth && (c === ';' || c === '{' || c === '}' || c === '['
                || (c === '|' && mask[end - 1] !== '|' && mask[end + 1] !== '|'))) { break; }
        }
        return { start, end, mask: mask.slice(start, end), text: code.slice(start, end) };
    });
}

export interface XmlElement { start: number; open: string; body: string; selfClosing: boolean; }
export function xmlElements(text: string, name: string): XmlElement[] {
    const clean = maskXmlComments(text).replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, s => s.replace(/[^\r\n]/g, ' '));
    const pattern = new RegExp(`<${name}\\b(?:"[^"]*"|'[^']*'|[^'">])*>`, 'gi');
    const result: XmlElement[] = [];
    for (const match of clean.matchAll(pattern)) {
        const start = match.index!, open = text.slice(start, start + match[0].length);
        const selfClosing = /\/\s*>$/.test(open);
        const after = start + open.length;
        const close = new RegExp(`</${name}\\s*>`, 'i').exec(clean.slice(after));
        result.push({ start, open, selfClosing, body: selfClosing ? '' : text.slice(after, close ? after + close.index : text.length) });
    }
    return result;
}

export function xmlAttribute(tag: string, name: string): string | undefined {
    return new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag)?.[2];
}
