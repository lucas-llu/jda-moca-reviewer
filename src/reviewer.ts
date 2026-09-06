import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { performDatabaseReview } from './rules/database';
import { performCsvModuleReview } from './rules/csv';
import { performReportModuleReview } from './rules/report';

export interface ReviewDocument {
    fileName: string;
    getText(): string;
}

export interface McmdIssue {
    file: string;
    line: number;
    column: number;
    severity: vscode.DiagnosticSeverity;
    message: string;
    rule: string;
}

export type ReviewKind =
    | 'mcmd'
    | 'mtrg'
    | 'jrxml'
    | 'label'
    | 'database-table'
    | 'database-index'
    | 'database-sequence'
    | 'database-view'
    | 'database-trigger'
    | 'csv'
    | 'ctl'
    | 'postinstall';

export const REVIEW_INCLUDE_GLOBS = [
    '**/*.mcmd',
    '**/*.mtrg',
    '**/*.jrxml',
    '**/les/labels/z140xiII/**/*.pof',
    '**/les/reports/z140xiII/**/*.pof',
    '**/les/db/ddl/**/Tables/**',
    '**/les/db/ddl/**/Indexes/**',
    '**/les/db/ddl/**/Sequences/**',
    '**/les/db/ddl/**/Views/**',
    '**/les/db/ddl/**/Triggers/**',
    '**/les/db/data/**/*.csv',
    '**/les/db/data/**/*.ctl',
    '**/postinstall/**/*.sh'
];

export const REVIEW_EXCLUDE_GLOB = '{**/.git/**,**/node_modules/**,**/out/**,**/dist/**}';

interface TagMatch {
    index: number;
    full: string;
    content: string;
    selfClosing: boolean;
}

interface SyntaxContext {
    content: string;
    contentOffset: number;
}

export interface BracketBlock {
    startIndex: number;
    endIndex: number;
    content: string;
}

interface RelationReference {
    index: number;
    endIndex: number;
    raw: string;
    name: string;
    derived: boolean;
}

function normalizePath(fileName: string): string {
    return fileName.replace(/\\/g, '/').toLowerCase();
}

export function isExcludedReviewPath(fileName: string): boolean {
    const normalized = `/${normalizePath(fileName)}/`;
    return path.basename(fileName).toLowerCase() === '.gitkeep'
        || ['/.git/', '/node_modules/', '/out/', '/dist/'].some(segment => normalized.includes(segment));
}

export function getReviewKind(fileName: string): ReviewKind | undefined {
    if (isExcludedReviewPath(fileName)) {
        return undefined;
    }

    const normalized = normalizePath(fileName);
    const extension = path.extname(fileName).toLowerCase();

    if (extension === '.mcmd') {
        return 'mcmd';
    }
    if (extension === '.mtrg') {
        return 'mtrg';
    }
    if (extension === '.jrxml') {
        return 'jrxml';
    }
    if (extension === '.pof' && normalized.includes('/z140xiii/')) {
        return 'label';
    }
    if (extension === '.tbl' && normalized.includes('/les/db/ddl/') && normalized.includes('/tables/')) {
        return 'database-table';
    }
    if (extension === '.idx' && normalized.includes('/les/db/ddl/') && normalized.includes('/indexes/')) {
        return 'database-index';
    }
    if (extension === '.seq' && normalized.includes('/les/db/ddl/') && normalized.includes('/sequences/')) {
        return 'database-sequence';
    }
    if (normalized.includes('/les/db/ddl/') && normalized.includes('/views/')) {
        return 'database-view';
    }
    if (normalized.includes('/les/db/ddl/') && normalized.includes('/triggers/')) {
        return 'database-trigger';
    }
    if (extension === '.csv' && normalized.includes('/les/db/data/')) {
        return 'csv';
    }
    if (extension === '.ctl' && normalized.includes('/les/db/data/')) {
        return 'ctl';
    }
    if (extension === '.sh' && normalized.includes('/postinstall/') && path.basename(fileName).toLowerCase().includes('isccustom')) {
        return 'postinstall';
    }
    return undefined;
}

export function isReviewableFile(fileName: string): boolean {
    return getReviewKind(fileName) !== undefined;
}

function findTags(text: string, tagName: string): TagMatch[] {
    const matches: TagMatch[] = [];
    const searchable = maskCdataBodies(text);
    const pattern = new RegExp(
        `<${tagName}\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/${tagName}\\s*>)`,
        'gi'
    );
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(searchable)) !== null) {
        const full = text.slice(match.index, match.index + match[0].length);
        const selfClosing = /\/\s*>$/.test(full);
        const openEnd = full.indexOf('>') + 1;
        const closeStart = selfClosing ? openEnd : full.toLowerCase().lastIndexOf(`</${tagName.toLowerCase()}`);
        matches.push({
            index: match.index,
            full,
            content: selfClosing ? '' : full.slice(openEnd, closeStart),
            selfClosing
        });
    }
    return matches;
}

function maskCdataBodies(text: string): string {
    return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, full => {
        const prefixLength = '<![CDATA['.length;
        const suffixLength = ']]>'.length;
        const body = full.slice(prefixLength, full.length - suffixLength)
            .replace(/[^\r\n]/g, ' ');
        return `<![CDATA[${body}]]>`;
    });
}

function locationAt(text: string, index: number): { line: number; column: number } {
    const safeIndex = Math.max(0, Math.min(index, text.length));
    const before = text.slice(0, safeIndex);
    const line = (before.match(/\n/g) || []).length + 1;
    const lastNewline = before.lastIndexOf('\n');
    return { line, column: safeIndex - lastNewline };
}

function issueAt(
    file: string,
    source: string,
    index: number,
    severity: vscode.DiagnosticSeverity,
    message: string,
    rule: string
): McmdIssue {
    const location = locationAt(source, index);
    return { file, ...location, severity, message, rule };
}

function getActualFileName(fullPath: string): string {
    const baseName = path.basename(fullPath);
    try {
        const files = fs.readdirSync(path.dirname(fullPath));
        return files.find(file => file.toLowerCase() === baseName.toLowerCase()) || baseName;
    } catch {
        return baseName;
    }
}

export function checkNameNoUpperCase(nameContent: string, file: string): McmdIssue[] {
    if (!/[A-Z]/.test(nameContent)) {
        return [];
    }
    const upperChars = [...new Set(nameContent.match(/[A-Z]/g) || [])];
    return [{
        file,
        line: 1,
        column: 1,
        severity: vscode.DiagnosticSeverity.Error,
        message: `<name> tag must not contain uppercase characters. Found: ${upperChars.join(', ')}`,
        rule: 'name-no-uppercase'
    }];
}

function checkCommandName(nameContent: string, file: string, source: string, index: number): McmdIssue[] {
    const issues: McmdIssue[] = [];
    if (nameContent.trim().length === 0) {
        issues.push(issueAt(file, source, index, vscode.DiagnosticSeverity.Error, '<name> tag must not be empty', 'name-empty'));
        return issues;
    }
    if (/^\s|\s$/.test(nameContent)) {
        issues.push(issueAt(file, source, index, vscode.DiagnosticSeverity.Error, '<name> must not have leading or trailing whitespace', 'name-leading-trailing-whitespace'));
    }
    if (/[\t\r\n]/.test(nameContent)) {
        issues.push(issueAt(file, source, index, vscode.DiagnosticSeverity.Error, '<name> must not contain tabs or line breaks', 'name-invalid-whitespace'));
    }
    const uppercase = /[A-Z]/.exec(nameContent);
    if (uppercase) {
        const upperChars = [...new Set(nameContent.match(/[A-Z]/g) || [])];
        issues.push(issueAt(
            file,
            source,
            index + uppercase.index,
            vscode.DiagnosticSeverity.Error,
            `<name> tag must not contain uppercase characters. Found: ${upperChars.join(', ')}`,
            'name-no-uppercase'
        ));
    }
    if (/[^a-z0-9 ]/.test(nameContent)) {
        const invalidChars = [...new Set(nameContent.match(/[^a-z0-9 ]/g) || [])];
        issues.push(issueAt(
            file,
            source,
            index,
            vscode.DiagnosticSeverity.Error,
            `<name> can only contain lowercase letters, numbers and ASCII spaces. Found: ${invalidChars.join(', ')}`,
            'name-invalid-characters'
        ));
    }
    if (/ {2,}/.test(nameContent)) {
        issues.push(issueAt(file, source, index, vscode.DiagnosticSeverity.Error, '<name> must use exactly one ASCII space between words', 'name-multiple-spaces'));
    }
    return issues;
}

export function checkFileNameNoUpperCase(fullPath: string): McmdIssue[] {
    const actualFileName = getActualFileName(fullPath);
    const upper = actualFileName.match(/[A-Z]/);
    if (!upper) {
        return [];
    }
    return [{
        file: fullPath,
        line: 1,
        column: 1,
        severity: vscode.DiagnosticSeverity.Error,
        message: `File name must not contain uppercase characters. Found: '${upper[0]}'`,
        rule: 'filename-no-uppercase'
    }];
}

export function checkFileName(fullPath: string): McmdIssue[] {
    const issues = checkFileNameNoUpperCase(fullPath);
    const actualFileName = getActualFileName(fullPath);
    const extension = path.extname(actualFileName).toLowerCase();
    const baseName = path.basename(actualFileName, path.extname(actualFileName));

    if (/\s/.test(actualFileName)) {
        issues.push({
            file: fullPath,
            line: 1,
            column: 1,
            severity: vscode.DiagnosticSeverity.Error,
            message: 'File name must not contain whitespace',
            rule: 'filename-no-whitespace'
        });
    }
    if (extension === '.mcmd' && !/^[a-z0-9_]+$/.test(baseName)) {
        issues.push({
            file: fullPath,
            line: 1,
            column: 1,
            severity: vscode.DiagnosticSeverity.Error,
            message: '.mcmd basename can only contain lowercase letters, numbers and underscores',
            rule: 'filename-invalid-characters'
        });
    }
    return issues;
}

export function checkNameMatchesFile(
    nameContent: string,
    fileNameNoExt: string,
    file: string,
    source?: string,
    sourceIndex = 0
): McmdIssue[] {
    if (nameContent.replace(/ /g, '_') === fileNameNoExt) {
        return [];
    }
    const message = `Name '${nameContent}' does not match filename '${fileNameNoExt}'`;
    return source
        ? [issueAt(file, source, sourceIndex, vscode.DiagnosticSeverity.Warning, message, 'name-mismatch')]
        : [{ file, line: 1, column: 1, severity: vscode.DiagnosticSeverity.Warning, message, rule: 'name-mismatch' }];
}

export function checkFileStructure(text: string, file: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const trimmedWithoutDeclaration = text.replace(/^\s*<\?xml[\s\S]*?\?>/i, '').trim();
    if (!/^<command\b[^>]*>[\s\S]*<\/command>$/.test(trimmedWithoutDeclaration)) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, 'Invalid or incomplete <command> root element', 'invalid-command-root'));
    }

    const names = findTags(text, 'name');
    if (names.length === 0) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, 'Missing <name> tag in .mcmd file', 'missing-name'));
    } else {
        if (names.length > 1) {
            issues.push(issueAt(file, text, names[1].index, vscode.DiagnosticSeverity.Error, 'Only one <name> tag is allowed', 'duplicate-name'));
        }
        const contentIndex = names[0].index + names[0].full.indexOf(names[0].content);
        issues.push(...checkCommandName(names[0].content, file, text, contentIndex));
    }

    const descriptions = findTags(text, 'description');
    if (descriptions.length === 0) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, 'Missing <description> tag in .mcmd file', 'missing-description'));
    } else if (descriptions.length > 1) {
        issues.push(issueAt(file, text, descriptions[1].index, vscode.DiagnosticSeverity.Error, 'Only one <description> tag is allowed', 'duplicate-description'));
    }

    const types = findTags(text, 'type');
    if (types.length === 0) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, 'Missing <type> tag in .mcmd file', 'missing-type'));
    } else if (types.length > 1) {
        issues.push(issueAt(file, text, types[1].index, vscode.DiagnosticSeverity.Error, 'Only one <type> tag is allowed', 'duplicate-type'));
    }

    const isJavaMethod = types.length === 1 && types[0].content.trim().toLowerCase() === 'java method';
    const localSyntax = findTags(text, 'local-syntax');
    const hasCdata = localSyntax.length === 1 && /<!\[CDATA\[[\s\S]*?\]\]>/.test(localSyntax[0].content);
    if (!isJavaMethod && (localSyntax.length !== 1 || !hasCdata)) {
        issues.push(issueAt(file, text, localSyntax[0]?.index ?? 0, vscode.DiagnosticSeverity.Error, 'Missing or invalid <local-syntax> CDATA in .mcmd file', 'missing-local-syntax'));
    }
    if (localSyntax.length > 1) {
        issues.push(issueAt(file, text, localSyntax[1].index, vscode.DiagnosticSeverity.Error, 'Only one <local-syntax> tag is allowed', 'duplicate-local-syntax'));
    }

    issues.push(...checkFileName(file));
    return issues;
}

function getSyntaxContext(text: string): SyntaxContext | undefined {
    const localSyntax = findTags(text, 'local-syntax')[0];
    if (!localSyntax) {
        return undefined;
    }
    const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(localSyntax.content);
    if (!cdata) {
        return undefined;
    }
    const tagContentOffset = localSyntax.index + localSyntax.full.indexOf(localSyntax.content);
    const cdataContentOffset = cdata.index + cdata[0].indexOf(cdata[1]);
    return { content: cdata[1], contentOffset: tagContentOffset + cdataContentOffset };
}

export function maskCommentsAndStrings(code: string, maskStrings = true): string {
    const chars = code.split('');
    let index = 0;
    const blank = (start: number, end: number) => {
        for (let i = start; i < end; i++) {
            if (chars[i] !== '\n' && chars[i] !== '\r') {
                chars[i] = ' ';
            }
        }
    };

    while (index < code.length) {
        if (code.startsWith('/*', index)) {
            const end = code.indexOf('*/', index + 2);
            const stop = end === -1 ? code.length : end + 2;
            blank(index, stop);
            index = stop;
            continue;
        }
        if (code.startsWith('--', index)) {
            const end = code.indexOf('\n', index + 2);
            const stop = end === -1 ? code.length : end;
            blank(index, stop);
            index = stop;
            continue;
        }
        if (maskStrings && (code[index] === "'" || code[index] === '"')) {
            const quote = code[index];
            const start = index++;
            while (index < code.length) {
                if (code[index] === quote && code[index + 1] === quote) {
                    index += 2;
                    continue;
                }
                if (code[index] === quote) {
                    index++;
                    break;
                }
                if (code[index] === '\\' && index + 1 < code.length) {
                    index += 2;
                } else {
                    index++;
                }
            }
            blank(start, index);
            continue;
        }
        index++;
    }
    return chars.join('');
}

export function extractBracketBlocks(code: string): BracketBlock[] {
    const mask = maskCommentsAndStrings(code);
    const blocks: BracketBlock[] = [];
    let depth = 0;
    let start = -1;
    for (let index = 0; index < mask.length; index++) {
        if (mask[index] === '[') {
            if (depth === 0) {
                start = index;
            }
            depth++;
        } else if (mask[index] === ']' && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) {
                blocks.push({ startIndex: start, endIndex: index, content: code.slice(start + 1, index) });
                start = -1;
            }
        }
    }
    return blocks;
}

function commandLayer(name: string): 'lc' | 'usr' | 'pd' | 'by' {
    const secondWord = name.trim().split(/\s+/)[1]?.toLowerCase();
    return secondWord === 'lc' || secondWord === 'usr' || secondWord === 'pd' ? secondWord : 'by';
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkLayerAndOverrides(
    name: string,
    syntax: SyntaxContext | undefined,
    file: string,
    source: string,
    nameIndex: number
): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const words = name.trim().split(/ +/);
    const markerIndexes = words
        .map((word, index) => ({ word, index }))
        .filter(item => ['lc', 'usr', 'pd'].includes(item.word));
    const secondWordIsLayer = ['lc', 'usr', 'pd'].includes(words[1]);
    if (!secondWordIsLayer && markerIndexes.some(item => item.index !== 1)) {
        issues.push(issueAt(file, source, nameIndex, vscode.DiagnosticSeverity.Error, 'lc/usr/pd layer marker must be the second command-name word', 'invalid-layer-marker-position'));
    }

    if (!syntax) {
        return issues;
    }

    const executable = maskCommentsAndStrings(syntax.content);
    const overridePattern = /\^\s*([a-z][a-z0-9]*(?:\s+[a-z0-9]+)*?)(?=\s+where\b|[\r\n|;{}]|$)/gi;
    let override: RegExpExecArray | null;
    while ((override = overridePattern.exec(executable)) !== null) {
        const targetName = override[1].trim();
        const layer = commandLayer(targetName);
        if (layer === 'usr' || layer === 'pd') {
            issues.push(issueAt(
                file,
                source,
                syntax.contentOffset + override.index,
                vscode.DiagnosticSeverity.Warning,
                `Override of ${layer} command '${targetName}' requires attention`,
                layer === 'usr' ? 'override-usr-command' : 'override-pd-command'
            ));
        }
    }

    if (commandLayer(name) === 'by') {
        const withoutComments = maskCommentsAndStrings(syntax.content, false).trimStart();
        const startsWithPolicy = /^list\s+policies\b/i.test(withoutComments);
        const hasIfElse = /\bif\s*\(/i.test(withoutComments) && /\belse\b/i.test(withoutComments);
        const namePattern = escapeRegExp(name.trim()).replace(/\s+/g, '\\s+');
        const callsOriginal = new RegExp(`\\^\\s*${namePattern}(?=\\s+where\\b|[\\r\\n|;}]|$)`, 'i').test(withoutComments);
        if (!startsWithPolicy || !hasIfElse || !callsOriginal) {
            issues.push(issueAt(
                file,
                source,
                syntax.contentOffset,
                vscode.DiagnosticSeverity.Error,
                'BY command customization must start with a policy check, guard all custom logic, and call the original command when disabled',
                'by-command-policy'
            ));
        }
    }
    return issues;
}

function checkGroovy(syntax: SyntaxContext, file: string, source: string): McmdIssue[] {
    const match = /\b(?:groovy|groovy\.lang|new\s+groovyshell)\b|\[\[/i.exec(maskCommentsAndStrings(syntax.content));
    return match ? [issueAt(file, source, syntax.contentOffset + match.index, vscode.DiagnosticSeverity.Error, 'Groovy is not allowed in MOCA Local Syntax; use a Java Method command', 'no-groovy')] : [];
}

function findClosingParen(mask: string, openIndex: number): number {
    let depth = 0;
    for (let index = openIndex; index < mask.length; index++) {
        if (mask[index] === '(') {
            depth++;
        } else if (mask[index] === ')') {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function skipWhitespace(text: string, index: number): number {
    while (index < text.length && /\s/.test(text[index])) {
        index++;
    }
    return index;
}

function parseRelation(mask: string, startIndex: number): RelationReference | undefined {
    const index = skipWhitespace(mask, startIndex);
    if (mask[index] === '(') {
        const close = findClosingParen(mask, index);
        return {
            index,
            endIndex: close === -1 ? index + 1 : close + 1,
            raw: mask.slice(index, close === -1 ? index + 1 : close + 1),
            name: '',
            derived: true
        };
    }
    const identifier = /^(?:"[^"]+"|[a-z_$#][\w$#]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_$#][\w$#]*))*/i.exec(mask.slice(index));
    if (!identifier) {
        return undefined;
    }
    const raw = identifier[0];
    const name = raw.split('.').pop()?.replace(/["\s]/g, '').toLowerCase() || '';
    return { index, endIndex: index + raw.length, raw, name, derived: false };
}

function isClauseStart(mask: string, index: number): boolean {
    return /^(?:where|group\s+by|order\s+by|having|union(?:\s+all)?|connect\s+by|start\s+with|model|join|left\s+join|right\s+join|full\s+join|inner\s+join|cross\s+join)\b/i.test(mask.slice(index));
}

function parseFromRelations(mask: string, afterFrom: number): RelationReference[] {
    const references: RelationReference[] = [];
    const first = parseRelation(mask, afterFrom);
    if (!first) {
        return references;
    }
    references.push(first);
    let index = first.endIndex;
    let depth = 0;
    while (index < mask.length) {
        if (mask[index] === '(') {
            depth++;
        } else if (mask[index] === ')') {
            if (depth === 0) {
                break;
            }
            depth--;
        } else if (depth === 0 && isClauseStart(mask, skipWhitespace(mask, index))) {
            break;
        } else if (depth === 0 && mask[index] === ',') {
            const next = parseRelation(mask, index + 1);
            if (!next) {
                break;
            }
            references.push(next);
            index = next.endIndex;
            continue;
        }
        index++;
    }
    return references;
}

function extractRelationReferences(mask: string): RelationReference[] {
    const references: RelationReference[] = [];
    const keyword = /\b(from|join)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = keyword.exec(mask)) !== null) {
        if (match[1].toLowerCase() === 'from') {
            references.push(...parseFromRelations(mask, keyword.lastIndex));
        } else {
            const reference = parseRelation(mask, keyword.lastIndex);
            if (reference) {
                references.push(reference);
            }
        }
    }
    return references;
}

function countMatches(text: string, pattern: RegExp): number {
    return (text.match(pattern) || []).length;
}

function complexityReasons(blocks: BracketBlock[]): string[] {
    const combined = blocks.map(block => maskCommentsAndStrings(block.content)).join('\n');
    if (!combined.trim()) {
        return [];
    }
    const joinCount = countMatches(combined, /\bjoin\b/gi);
    const unionCount = countMatches(combined, /\bunion(?:\s+all)?\b/gi);
    const subqueryCount = countMatches(combined, /\(\s*select\b/gi);
    const tableReferenceCount = blocks.reduce(
        (total, block) => total + extractRelationReferences(maskCommentsAndStrings(block.content)).length,
        0
    );
    const reasons: string[] = [];
    if (joinCount + unionCount >= 2) {
        reasons.push(`${joinCount} JOIN + ${unionCount} UNION events`);
    }
    if (subqueryCount >= 2) {
        reasons.push(`${subqueryCount} subqueries`);
    }
    if (tableReferenceCount > 2) {
        reasons.push(`${tableReferenceCount} table references`);
    }
    return reasons;
}

export function checkComplexSql(
    blocks: BracketBlock[],
    commandName: string,
    file: string,
    source: string,
    syntaxOffset: number
): McmdIssue[] {
    const reasons = complexityReasons(blocks);
    const firstWord = commandName.trim().split(/\s+/)[0]?.toLowerCase();
    if (reasons.length > 0 && firstWord !== 'list' && firstWord !== 'get') {
        return [issueAt(
            file,
            source,
            syntaxOffset + (blocks[0]?.startIndex ?? 0),
            vscode.DiagnosticSeverity.Error,
            `Complex SQL can only appear in list/get commands: ${reasons.join('; ')}`,
            'complex-sql-command-type'
        )];
    }
    return [];
}

function hasAdjacentComment(code: string, block: BracketBlock, innerIndex?: number): boolean {
    const beforeBlock = code.slice(0, block.startIndex);
    const afterBlock = code.slice(block.endIndex + 1);
    if (/(?:\/\*[\s\S]*?\*\/|--[^\r\n]*)(?:\s*)$/.test(beforeBlock)) {
        return true;
    }
    if (/^\s*(?:\/\*[\s\S]*?\*\/|--[^\r\n]*)/.test(afterBlock)) {
        return true;
    }
    if (innerIndex !== undefined) {
        const prefix = block.content.slice(0, innerIndex);
        return /(?:\/\*[\s\S]*?\*\/|--[^\r\n]*)(?:\s*)$/.test(prefix);
    }
    return false;
}

function checkDml(
    blocks: BracketBlock[],
    commandName: string,
    file: string,
    source: string,
    syntax: SyntaxContext
): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const isListOrGet = /^(?:list|get)\s/i.test(commandName.trim());
    for (const block of blocks) {
        const mask = maskCommentsAndStrings(block.content);
        const dml = /\b(insert|update|delete)\b/gi;
        let match: RegExpExecArray | null;
        let missingCommentReported = false;
        while ((match = dml.exec(mask)) !== null) {
            const operationName = match[1].toLowerCase();
            const operation = operationName.toUpperCase();
            const absoluteIndex = syntax.contentOffset + block.startIndex + 1 + match.index;
            const expectedCommand = operationName === 'insert'
                ? 'create record'
                : operationName === 'update' ? 'change record' : 'remove record';
            issues.push(issueAt(file, source, absoluteIndex, vscode.DiagnosticSeverity.Warning, `${operation} is used; confirm the direct DML is necessary`, `avoid-${operationName}`));
            if (!adjacentCommentMatches(syntax.content, block, new RegExp(`\\b${expectedCommand.replace(' ', '\\s+')}\\b`, 'i'), match.index) && !missingCommentReported) {
                issues.push(issueAt(file, source, absoluteIndex, vscode.DiagnosticSeverity.Error, `${operation} requires an adjacent comment explaining why '${expectedCommand}' cannot be used`, 'dml-missing-comment'));
                missingCommentReported = true;
            }
            if (isListOrGet) {
                issues.push(issueAt(file, source, absoluteIndex, vscode.DiagnosticSeverity.Error, `${operation} is not allowed in list/get commands`, `list-get-no-${operationName}`));
            }
        }
    }
    return issues;
}

function checkInSubqueries(blocks: BracketBlock[], file: string, source: string, syntaxOffset: number): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const block of blocks) {
        const mask = maskCommentsAndStrings(block.content);
        const pattern = /\bin\s*\(/gi;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(mask)) !== null) {
            const open = mask.indexOf('(', match.index);
            const close = findClosingParen(mask, open);
            const inner = mask.slice(open + 1, close === -1 ? mask.length : close);
            if (/\bselect\b/i.test(inner)) {
                issues.push(issueAt(
                    file,
                    source,
                    syntaxOffset + block.startIndex + 1 + match.index,
                    vscode.DiagnosticSeverity.Error,
                    'Use EXISTS instead of IN (subquery)',
                    'no-in-subquery'
                ));
            }
        }
    }
    return issues;
}

function parenDepths(text: string): number[] {
    const depths: number[] = new Array(text.length).fill(0);
    let depth = 0;
    for (let index = 0; index < text.length; index++) {
        depths[index] = depth;
        if (text[index] === '(') {
            depth++;
        } else if (text[index] === ')') {
            depth = Math.max(0, depth - 1);
        }
    }
    return depths;
}

function checkSelectClauseSubqueries(blocks: BracketBlock[], file: string, source: string, syntaxOffset: number): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const block of blocks) {
        const mask = maskCommentsAndStrings(block.content);
        const depths = parenDepths(mask);
        const selects = [...mask.matchAll(/\bselect\b/gi)];
        for (const select of selects) {
            const selectIndex = select.index ?? 0;
            const selectDepth = depths[selectIndex];
            const tokenPattern = /\b(from|union)\b/gi;
            tokenPattern.lastIndex = selectIndex + select[0].length;
            let fromIndex = -1;
            let token: RegExpExecArray | null;
            while ((token = tokenPattern.exec(mask)) !== null) {
                if (depths[token.index] !== selectDepth) {
                    continue;
                }
                if (token[1].toLowerCase() === 'from') {
                    fromIndex = token.index;
                }
                break;
            }
            if (fromIndex === -1) {
                continue;
            }
            const selectList = mask.slice(selectIndex + select[0].length, fromIndex);
            const nested = /\bselect\b/i.exec(selectList);
            if (nested) {
                issues.push(issueAt(
                    file,
                    source,
                    syntaxOffset + block.startIndex + 1 + selectIndex + select[0].length + nested.index,
                    vscode.DiagnosticSeverity.Error,
                    'Sub-select is not allowed in SELECT clause',
                    'no-sub-select-in-select'
                ));
            }
        }
    }
    return issues;
}

function extractCteNames(mask: string): Set<string> {
    const names = new Set<string>();
    const pattern = /(?:\bwith\b|,)\s*([a-z_$#][\w$#]*)\s+as\s*\(/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(mask)) !== null) {
        names.add(match[1].toLowerCase());
    }
    return names;
}

function adjacentCommentMatches(code: string, block: BracketBlock, pattern: RegExp, innerIndex?: number): boolean {
    const before = code.slice(0, block.startIndex);
    const adjacentBlockComment = /(\/\*[\s\S]*?\*\/)(?:\s*)$/.exec(before);
    if (adjacentBlockComment && pattern.test(adjacentBlockComment[1])) {
        return true;
    }
    const trailingLineComment = before.match(/--[^\r\n]*$/);
    if (trailingLineComment && pattern.test(trailingLineComment[0])) {
        return true;
    }
    const after = code.slice(block.endIndex + 1);
    const afterComment = /^\s*(\/\*[\s\S]*?\*\/|--[^\r\n]*)/.exec(after);
    if (afterComment && pattern.test(afterComment[1])) {
        return true;
    }
    if (innerIndex !== undefined) {
        const prefix = block.content.slice(0, innerIndex);
        const innerComment = /(\/\*[\s\S]*?\*\/|--[^\r\n]*)(?:\s*)$/.exec(prefix);
        return !!innerComment && pattern.test(innerComment[1]);
    }
    return false;
}

function checkNonViewTables(
    blocks: BracketBlock[],
    file: string,
    source: string,
    syntax: SyntaxContext
): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const block of blocks) {
        const mask = maskCommentsAndStrings(block.content);
        const cteNames = extractCteNames(mask);
        const references = extractRelationReferences(mask);
        const depths = parenDepths(mask);
        const selectMatches = [...mask.matchAll(/\bselect\b/gi)];
        const owningSelect = (reference: RelationReference): number => {
            const referenceDepth = depths[reference.index] ?? 0;
            let owner = -1;
            for (const select of selectMatches) {
                const selectIndex = select.index ?? 0;
                if (selectIndex > reference.index) {
                    break;
                }
                if (depths[selectIndex] === referenceDepth) {
                    owner = selectIndex;
                }
            }
            return owner;
        };
        for (const reference of references) {
            if (reference.derived || cteNames.has(reference.name)) {
                continue;
            }
            const owner = owningSelect(reference);
            if (owner === -1) {
                // FROM used by DELETE/UPDATE is a DML target, not a SELECT relation.
                continue;
            }
            const absoluteIndex = syntax.contentOffset + block.startIndex + 1 + reference.index;
            let rule: string | undefined;
            let message: string | undefined;
            if (reference.name === 'dual') {
                rule = 'select-from-dual';
                message = 'Prefer publish data instead of selecting from dual';
            } else if (reference.name === 'poldat_view') {
                rule = 'prefer-poldat';
                message = 'Use poldat instead of poldat_view and document the database-lock reason';
            } else if (!reference.name.endsWith('_view')) {
                rule = 'select-from-non-view';
                message = `Table '${reference.name}' does not end with _view`;
            }
            if (!rule || !message) {
                continue;
            }
            const hasAdjacent = hasAdjacentComment(syntax.content, block, reference.index);
            if (rule === 'select-from-non-view') {
                const sameSelectHasView = references.some(other =>
                    other !== reference
                    && !other.derived
                    && other.name.endsWith('_view')
                    && owningSelect(other) === owner
                );
                if (sameSelectHasView || adjacentCommentMatches(syntax.content, block, /(?:\bview\b|_view\b)/i)) {
                    continue;
                }
                issues.push(issueAt(file, source, absoluteIndex, vscode.DiagnosticSeverity.Warning, message, rule));
                issues.push(issueAt(
                    file,
                    source,
                    absoluteIndex,
                    vscode.DiagnosticSeverity.Error,
                    'Non-view SQL requires an adjacent comment explaining why a view/_view is not used',
                    `${rule}-missing-comment`
                ));
                continue;
            }
            issues.push(issueAt(file, source, absoluteIndex, vscode.DiagnosticSeverity.Warning, message, rule));
            const hasRequiredReason = rule === 'prefer-poldat'
                ? adjacentCommentMatches(syntax.content, block, /(?:poldat_view|database\s+lock|performance|\bview\b)/i)
                : hasAdjacent;
            if (!hasRequiredReason) {
                issues.push(issueAt(
                    file,
                    source,
                    absoluteIndex,
                    vscode.DiagnosticSeverity.Error,
                    'Non-view/dual SQL requires an adjacent comment',
                    `${rule}-missing-comment`
                ));
            }
        }
    }
    return issues;
}

function denominatorToken(mask: string, slashIndex: number): string {
    const start = skipWhitespace(mask, slashIndex + 1);
    const functionMatch = /^(nullif|decode)\s*\(/i.exec(mask.slice(start));
    if (functionMatch) {
        const open = mask.indexOf('(', start);
        const close = findClosingParen(mask, open);
        return mask.slice(start, close === -1 ? mask.length : close + 1).trim();
    }
    const numberMatch = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?/i.exec(mask.slice(start));
    if (numberMatch) {
        return numberMatch[0];
    }
    const parenthesizedNumberMatch = /^\(\s*[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?\s*\)/i.exec(mask.slice(start));
    if (parenthesizedNumberMatch) {
        return parenthesizedNumberMatch[0];
    }
    const token = /^@?[a-z0-9_$#]+(?:\.[a-z0-9_$#]+)*/i.exec(mask.slice(start));
    return token?.[0] || '';
}

function isConstantDenominator(denominator: string): boolean {
    if (!denominator) {
        return false;
    }
    const numericLiteral = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i;
    const value = denominator.trim();
    if (numericLiteral.test(value)) {
        return Number(value) !== 0;
    }
    if (!/^\([^()]*\)$/.test(value)) {
        return false;
    }
    const parenthesized = value.slice(1, -1).trim();
    return numericLiteral.test(parenthesized) && Number(parenthesized) !== 0;
}

function splitFunctionArguments(call: string): string[] {
    const open = call.indexOf('(');
    const close = call.lastIndexOf(')');
    if (open === -1 || close <= open) {
        return [];
    }
    const content = call.slice(open + 1, close);
    const args: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < content.length; index++) {
        if (content[index] === '(') {
            depth++;
        } else if (content[index] === ')') {
            depth = Math.max(0, depth - 1);
        } else if (content[index] === ',' && depth === 0) {
            args.push(content.slice(start, index).trim());
            start = index + 1;
        }
    }
    args.push(content.slice(start).trim());
    return args;
}

function isProtectedDenominator(denominator: string): boolean {
    if (/^nullif\s*\(/i.test(denominator)) {
        const args = splitFunctionArguments(denominator);
        return args.length >= 2 && /^0(?:\.0+)?$/.test(args[1]);
    }
    if (/^decode\s*\(/i.test(denominator)) {
        const args = splitFunctionArguments(denominator);
        if (args.length < 4 || !/^0(?:\.0+)?$/.test(args[1])) {
            return false;
        }
        return args[2].length > 0 && !/^[+-]?0(?:\.0+)?$/.test(args[2]);
    }
    return false;
}

function hasCaseZeroGuard(mask: string, slashIndex: number, denominator: string): boolean {
    if (!denominator) {
        return false;
    }
    const before = mask.slice(0, slashIndex);
    const caseIndex = before.toLowerCase().lastIndexOf('case');
    if (caseIndex === -1 || mask.toLowerCase().indexOf('end', slashIndex) === -1) {
        return false;
    }
    const casePrefix = mask.slice(caseIndex, slashIndex);
    const escaped = escapeRegExp(denominator);
    return new RegExp(`\\bwhen\\s+(?:${escaped}\\s*=\\s*0|0\\s*=\\s*${escaped})\\b`, 'i').test(casePrefix)
        && /\belse\b/i.test(casePrefix);
}

function checkDivisions(blocks: BracketBlock[], file: string, source: string, syntaxOffset: number): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const block of blocks) {
        const mask = maskCommentsAndStrings(block.content);
        for (let index = 0; index < mask.length; index++) {
            if (mask[index] !== '/') {
                continue;
            }
            const denominator = denominatorToken(mask, index);
            const protectedByFunction = isProtectedDenominator(denominator);
            const protectedByCase = hasCaseZeroGuard(mask, index, denominator);
            const constantDenominator = isConstantDenominator(denominator);
            if (!protectedByFunction && !protectedByCase && !constantDenominator) {
                issues.push(issueAt(
                    file,
                    source,
                    syntaxOffset + block.startIndex + 1 + index,
                    vscode.DiagnosticSeverity.Error,
                    'Division denominator must explicitly handle zero',
                    'division-zero-guard'
                ));
            }
        }
    }
    return issues;
}

function checkCopyMarkers(syntax: SyntaxContext, file: string, source: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const starts = [...syntax.content.matchAll(/\/\*\s*Start\s+copy\s+from\s+(?:BY|Core|Plugin)\s+(.+?)\s*\*\//gi)]
        .map(match => ({ index: match.index ?? 0, command: match[1].trim() }));
    const ends = [...syntax.content.matchAll(/\/\*\s*End\s+copy\s+from\s+(?:BY|Core|Plugin)\s+(.+?)\s*\*\//gi)]
        .map(match => ({ index: match.index ?? 0, command: match[1].trim() }));
    for (const start of starts) {
        if (!ends.some(end => end.index > start.index && end.command.toLowerCase() === start.command.toLowerCase())) {
            issues.push(issueAt(file, source, syntax.contentOffset + start.index, vscode.DiagnosticSeverity.Error, `Copy marker for '${start.command}' is missing a matching End marker`, 'copy-marker-missing-end'));
        }
    }
    for (const end of ends) {
        if (!starts.some(start => start.index < end.index && start.command.toLowerCase() === end.command.toLowerCase())) {
            issues.push(issueAt(file, source, syntax.contentOffset + end.index, vscode.DiagnosticSeverity.Error, `Copy marker for '${end.command}' is missing a matching Start marker`, 'copy-marker-missing-start'));
        }
    }
    return issues;
}

function checkPluginReferences(name: string, syntax: SyntaxContext, file: string, source: string): McmdIssue[] {
    if (commandLayer(name) !== 'pd' && !normalizePath(file).includes('/pd/')) {
        return [];
    }
    const issues: McmdIssue[] = [];
    const searchable = maskCommentsAndStrings(syntax.content, false);
    const pattern = /\busr_lc_[a-z0-9_$#]+\b|\blc::[a-z0-9_$#]+\b/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(searchable)) !== null) {
        issues.push(issueAt(
            file,
            source,
            syntax.contentOffset + match.index,
            vscode.DiagnosticSeverity.Error,
            `Plugin must not directly reference Local Customisation object '${match[0]}'`,
            'plugin-references-local-customisation'
        ));
    }
    return issues;
}

function checkSelectComments(blocks: BracketBlock[], syntax: SyntaxContext, file: string, source: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const requiredComment = /No existing MOCA list command, use select statement instead/i;
    for (const block of blocks) {
        const mask = maskCommentsAndStrings(block.content);
        const select = /\bselect\b/i.exec(mask);
        if (!select) {
            continue;
        }
        if (!adjacentCommentMatches(syntax.content, block, requiredComment)) {
            const absoluteIndex = syntax.contentOffset + block.startIndex + 1 + select.index;
            issues.push(issueAt(
                file,
                source,
                absoluteIndex,
                vscode.DiagnosticSeverity.Error,
                'Every SELECT requires an adjacent comment: No existing MOCA list command, use select statement instead.',
                'select-missing-comment'
            ));
        }
    }
    return issues;
}

function checkSysdate(blocks: BracketBlock[], file: string, source: string, syntaxOffset: number): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const block of blocks) {
        const mask = maskCommentsAndStrings(block.content);
        if (!/\bselect\b/i.test(mask) || !/\bfrom\s+dual\b/i.test(mask) || !/\bsysdate\b/i.test(mask)) {
            continue;
        }
        const withoutComments = maskCommentsAndStrings(block.content, false);
        if (!/\bsysdate\s+as\s+"sysdate"/i.test(withoutComments)) {
            const match = /\bsysdate\b/i.exec(mask);
            issues.push(issueAt(
                file,
                source,
                syntaxOffset + block.startIndex + 1 + (match?.index ?? 0),
                vscode.DiagnosticSeverity.Error,
                'When selecting sysdate from dual, use: select sysdate as "sysdate" from dual',
                'sysdate-missing-alias'
            ));
        }
    }
    return issues;
}

function checkValidateKeyExistence(blocks: BracketBlock[], file: string, source: string, syntaxOffset: number): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const block of blocks) {
        const mask = maskCommentsAndStrings(block.content);
        const match = /\bselect\s+'[^']+'\s+from\b/i.exec(maskCommentsAndStrings(block.content, false));
        if (!match) {
            continue;
        }
        const references = extractRelationReferences(mask);
        if (references.length === 1 && !/\bexists\b|\bjoin\b|,|\(\s*select\b/i.test(mask)) {
            issues.push(issueAt(
                file,
                source,
                syntaxOffset + block.startIndex + 1 + match.index,
                vscode.DiagnosticSeverity.Warning,
                'Prefer validate key exists/not exist over select \'x\' existence checks',
                'prefer-validate-key-exists'
            ));
        }
    }
    return issues;
}

function checkDistinctRownum(blocks: BracketBlock[], file: string, source: string, syntaxOffset: number): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const block of blocks) {
        const mask = maskCommentsAndStrings(block.content);
        const distinct = /\bdistinct\b/i.exec(mask);
        const rownum = /\brownum\b/i.exec(mask);
        if (distinct && rownum) {
            issues.push(issueAt(
                file,
                source,
                syntaxOffset + block.startIndex + 1 + distinct.index,
                vscode.DiagnosticSeverity.Error,
                'DISTINCT and ROWNUM must not be used in the same SQL block',
                'distinct-rownum-conflict'
            ));
        }
    }
    return issues;
}

function rawInSelectList(mask: string, rawIndex: number): boolean {
    const depths = parenDepths(mask);
    const selects = [...mask.slice(0, rawIndex).matchAll(/\bselect\b/gi)];
    for (const select of [...selects].reverse()) {
        const selectIndex = select.index ?? 0;
        const depth = depths[selectIndex];
        const fromMatch = /\bfrom\b/gi;
        fromMatch.lastIndex = selectIndex + select[0].length;
        let fromIndex = -1;
        let match: RegExpExecArray | null;
        while ((match = fromMatch.exec(mask)) !== null) {
            if (depths[match.index] !== depth) {
                continue;
            }
            fromIndex = match.index;
            break;
        }
        if (fromIndex !== -1 && rawIndex > selectIndex && rawIndex < fromIndex) {
            return true;
        }
    }
    return false;
}

function checkRawUsage(blocks: BracketBlock[], file: string, source: string, syntaxOffset: number): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const block of blocks) {
        const mask = maskCommentsAndStrings(block.content);
        const pattern = /:raw\b/gi;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(mask)) !== null) {
            const absoluteIndex = syntaxOffset + block.startIndex + 1 + match.index;
            issues.push(issueAt(file, source, absoluteIndex, vscode.DiagnosticSeverity.Warning, ':raw requires confirmed SQL injection protection', 'raw-usage'));
            if (rawInSelectList(mask, match.index)) {
                issues.push(issueAt(file, source, absoluteIndex, vscode.DiagnosticSeverity.Warning, ':raw in SELECT clause may expand into an illegal sub-select', 'raw-in-select'));
            }
        }
    }
    return issues;
}

function checkNobindBind(blocks: BracketBlock[], file: string, source: string, syntaxOffset: number): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const block of blocks) {
        const content = block.content;
        const markers = [...content.matchAll(/\*#(nobind|bind)\*\//gi)]
            .map(match => ({ index: match.index ?? 0, kind: match[1].toLowerCase() }))
            .sort((a, b) => a.index - b.index);
        const spans: Array<[number, number]> = [];
        let pendingNobind = -1;
        for (const marker of markers) {
            if (marker.kind === 'nobind') {
                if (pendingNobind !== -1) {
                    issues.push(issueAt(file, source, syntaxOffset + block.startIndex + 1 + marker.index, vscode.DiagnosticSeverity.Error, 'A /*#nobind*/ marker must pair with a later /*#bind*/', 'nobind-bind-unbalanced'));
                } else {
                    pendingNobind = marker.index;
                }
            } else if (pendingNobind !== -1) {
                spans.push([pendingNobind, marker.index]);
                pendingNobind = -1;
            } else {
                issues.push(issueAt(file, source, syntaxOffset + block.startIndex + 1 + marker.index, vscode.DiagnosticSeverity.Error, 'A /*#bind*/ marker must follow an earlier /*#nobind*/', 'nobind-bind-unbalanced'));
            }
        }
        if (pendingNobind !== -1) {
            issues.push(issueAt(file, source, syntaxOffset + block.startIndex + 1 + pendingNobind, vscode.DiagnosticSeverity.Error, 'A /*#nobind*/ marker must pair with a later /*#bind*/', 'nobind-bind-unbalanced'));
        }

        const concatPattern = /\|\|/gi;
        let concat: RegExpExecArray | null;
        while ((concat = concatPattern.exec(content)) !== null) {
            const concatIndex = concat.index;
            const region = content.slice(Math.max(0, concatIndex - 120), Math.min(content.length, concatIndex + 120));
            const hasBindVariable = /(?:^|[^'"])\s*@[a-z0-9_$#.]+/i.test(region);
            if (!hasBindVariable) {
                continue;
            }
            if (!spans.some(([start, end]) => concatIndex > start && concatIndex < end)) {
                issues.push(issueAt(file, source, syntaxOffset + block.startIndex + 1 + concatIndex, vscode.DiagnosticSeverity.Error, 'Concatenated bind expressions must be wrapped in /*#nobind*/ ... /*#bind*/', 'nobind-bind-required'));
            }
        }
    }
    return issues;
}

function checkPrtdsc(blocks: BracketBlock[], file: string, source: string, syntaxOffset: number): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const block of blocks) {
        const content = block.content;
        if (!/\bprtdsc\b/i.test(content) || !/\bcolval\b/i.test(content)) {
            continue;
        }
        const colvalIndex = /\bcolval\b/i.exec(content)?.index ?? 0;
        const hasNobind = /\*#nobind\*\//i.test(content.slice(0, colvalIndex));
        const hasBind = /\*#bind\*\//i.test(content.slice(colvalIndex));
        if (!hasNobind || !hasBind) {
            issues.push(issueAt(file, source, syntaxOffset + block.startIndex + 1 + colvalIndex, vscode.DiagnosticSeverity.Error, 'prtdsc.colval concatenation must be wrapped in /*#nobind*/ ... /*#bind*/', 'prtdsc-nobind-bind'));
        }
    }
    return issues;
}

function checkTimestampExpressions(blocks: BracketBlock[], file: string, source: string, syntaxOffset: number): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const block of blocks) {
        const content = block.content;
        const match = /\bfrom_tz\s*\(/i.exec(content);
        if (!match || !/\b(?:cast\s*\(|to_char\s*\(|sessiontimezone\b|at\s+time\s+zone\b)/i.test(content)) {
            continue;
        }
        const hasNobind = /\*#nobind\*\//i.test(content.slice(0, match.index));
        const hasBind = /\*#bind\*\//i.test(content.slice(match.index));
        if (!hasNobind || !hasBind) {
            issues.push(issueAt(file, source, syntaxOffset + block.startIndex + 1 + match.index, vscode.DiagnosticSeverity.Error, 'Complex timestamp expressions must be wrapped in /*#nobind*/ ... /*#bind*/', 'timestamp-nobind-bind'));
        }
    }
    return issues;
}

function checkSessionVariable(syntax: SyntaxContext, file: string, source: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const executable = maskCommentsAndStrings(syntax.content, false);
    const pattern = /\bget\s+session\s+variable\b/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(executable)) !== null) {
        const tail = executable.slice(match.index + match[0].length, match.index + match[0].length + 400);
        if (!/(?:catch\s*\(|nvl\s*\(\s*@value\b|@\w+\s*=\s*nvl\s*\()/i.test(tail)) {
            issues.push(issueAt(file, source, syntax.contentOffset + match.index, vscode.DiagnosticSeverity.Warning, 'Get Session Variable must catch errors or explicitly default @value', 'session-variable-uncaptured'));
        }
    }
    return issues;
}

function checkExecuteServerCommand(syntax: SyntaxContext, file: string, source: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const pattern = /\bexecute\s+server\s+command\b/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(syntax.content)) !== null) {
        const tail = syntax.content.slice(match.index, match.index + 400);
        const statementEnd = tail.search(/\n\s*(?:\||\}|;)/);
        const statement = statementEnd === -1 ? tail : tail.slice(0, statementEnd);
        const quoteCount = (statement.match(/'/g) || []).length;
        if (quoteCount % 2 === 1) {
            issues.push(issueAt(file, source, syntax.contentOffset + match.index, vscode.DiagnosticSeverity.Warning, 'Execute Server Command must handle single quotes in parameter values correctly', 'execute-server-command-quotes'));
        }
    }
    return issues;
}

function checkSendEmail(syntax: SyntaxContext, file: string, source: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const pattern = /\bsend\s+email\b/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(syntax.content)) !== null) {
        const tail = syntax.content.slice(match.index, match.index + 500);
        const statementEnd = tail.search(/\n\s*(?:\||\}|;)/);
        const statement = statementEnd === -1 ? tail : tail.slice(0, statementEnd);
        if (/(?:mail_from|send_from|mail_server|smtp_server)\s*=\s*(?:(?:nvl\s*\(\s*@[^,]+,\s*'[^']+'|'[^']+'))/i.test(statement)) {
            issues.push(issueAt(file, source, syntax.contentOffset + match.index, vscode.DiagnosticSeverity.Error, 'Send Email must not hardcode default sender/server configuration; keep defaults in policy', 'send-email-hardcoded-config'));
        }
    }
    return issues;
}

export function performMcmdReview(document: ReviewDocument): McmdIssue[] {
    const text = document.getText();
    const file = document.fileName;
    const issues = checkFileStructure(text, file);
    const nameTag = findTags(text, 'name')[0];
    const name = nameTag?.content ?? '';
    if (nameTag) {
        const baseName = path.basename(file, path.extname(file));
        const nameContentIndex = nameTag.index + nameTag.full.indexOf(nameTag.content);
        issues.push(...checkNameMatchesFile(name, baseName, file, text, nameContentIndex));
    }
    const syntax = getSyntaxContext(text);
    issues.push(...checkLayerAndOverrides(name, syntax, file, text, nameTag?.index ?? 0));
    if (!syntax) {
        return issues;
    }
    issues.push(...checkGroovy(syntax, file, text));
    issues.push(...checkCopyMarkers(syntax, file, text));
    issues.push(...checkPluginReferences(name, syntax, file, text));
    const blocks = extractBracketBlocks(syntax.content);
    issues.push(...checkComplexSql(blocks, name, file, text, syntax.contentOffset));
    issues.push(...checkSelectComments(blocks, syntax, file, text));
    issues.push(...checkDml(blocks, name, file, text, syntax));
    issues.push(...checkInSubqueries(blocks, file, text, syntax.contentOffset));
    issues.push(...checkSelectClauseSubqueries(blocks, file, text, syntax.contentOffset));
    issues.push(...checkNonViewTables(blocks, file, text, syntax));
    issues.push(...checkDivisions(blocks, file, text, syntax.contentOffset));
    issues.push(...checkSysdate(blocks, file, text, syntax.contentOffset));
    issues.push(...checkValidateKeyExistence(blocks, file, text, syntax.contentOffset));
    issues.push(...checkDistinctRownum(blocks, file, text, syntax.contentOffset));
    issues.push(...checkRawUsage(blocks, file, text, syntax.contentOffset));
    issues.push(...checkNobindBind(blocks, file, text, syntax.contentOffset));
    issues.push(...checkPrtdsc(blocks, file, text, syntax.contentOffset));
    issues.push(...checkTimestampExpressions(blocks, file, text, syntax.contentOffset));
    issues.push(...checkSessionVariable(syntax, file, text));
    issues.push(...checkExecuteServerCommand(syntax, file, text));
    issues.push(...checkSendEmail(syntax, file, text));
    return issues;
}

export function performTriggerReview(document: ReviewDocument): McmdIssue[] {
    const text = document.getText();
    const file = document.fileName;
    const issues = checkFileName(file);
    const syntax = getSyntaxContext(text);
    if (!syntax) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, 'Missing or invalid trigger <local-syntax> CDATA', 'trigger-missing-local-syntax'));
        return issues;
    }
    const executable = maskCommentsAndStrings(syntax.content).trim();
    const withoutTrailingTerminator = executable.replace(/;\s*$/, '').trim();
    const hasForbiddenControl = /\bpublish\s+data\b|\bif\s*\(|\belse\b|[{}|]/i.test(withoutTrailingTerminator);
    const hasMultipleSemicolons = /;/.test(withoutTrailingTerminator);
    if (!withoutTrailingTerminator || hasForbiddenControl || hasMultipleSemicolons) {
        issues.push(issueAt(
            file,
            text,
            syntax.contentOffset,
            vscode.DiagnosticSeverity.Error,
            'Trigger Local Syntax must contain exactly one MOCA command; only an optional catch(...) is allowed',
            'trigger-single-command'
        ));
    }
    return issues;
}

export function validateGitBranchName(branchName: string): McmdIssue[] {
    if (/^feature\/SWIFTLEX-[A-Za-z0-9_]+$/.test(branchName)) {
        return [];
    }
    return [{
        file: '',
        line: 1,
        column: 1,
        severity: vscode.DiagnosticSeverity.Error,
        message: `Git branch name '${branchName}' must match feature/SWIFTLEX-<ticket>_<suffix>; only underscores are allowed after the ticket`,
        rule: 'invalid-branch-name'
    }];
}

export function checkJrxmlMocaConnection(document: ReviewDocument): McmdIssue[] {
    const text = document.getText();
    const issues: McmdIssue[] = [];
    const tagPattern = /<parameter\b[^>]*\bname\s*=\s*"MOCA_REPORT_CONNECTION"[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(text)) !== null) {
        if (/\/\s*>$/.test(match[0])) {
            continue;
        }
        const bodyStart = match.index + match[0].length;
        const closeMatch = /<\/parameter\s*>/i.exec(text.slice(bodyStart));
        const body = text.slice(bodyStart, closeMatch ? bodyStart + closeMatch.index : text.length);
        const bodyWithoutComments = body.replace(/<!--[\s\S]*?-->/g, '').trim();
        const propertyMatch = /^<property\b([^>]*)\/\s*>$/i.exec(bodyWithoutComments);
        const propertyAttributes = propertyMatch?.[1] || '';
        const propertyOnly = !!propertyMatch
            && /\bname\s*=\s*["']MOCA["']/i.test(propertyAttributes)
            && /\bvalue\s*=\s*["']true["']/i.test(propertyAttributes);
        const hasDefaultElement = /<defaultValueExpression\b/i.test(body);
        const localLink = /localhost|\b(?:\d{1,3}\.){3}\d{1,3}\b|\bjdbc:|\bhttps?:\/\/|\bmoca:\/\/|\b(?:server|host|url)\s*[:=]\s*["']?[a-z0-9.:/_-]+/i.test(body);
        if (!propertyOnly || hasDefaultElement || localLink) {
            issues.push(issueAt(
                document.fileName,
                text,
                match.index,
                vscode.DiagnosticSeverity.Error,
                'MOCA_REPORT_CONNECTION must be self-closing or contain only the MOCA property without a local/hardcoded connection',
                'jrxml-moca-connection-invalid'
            ));
        }
    }
    return issues;
}

export function reviewDocument(document: ReviewDocument): McmdIssue[] {
    const kind = getReviewKind(document.fileName);
    switch (kind) {
        case 'mcmd':
            return performMcmdReview(document);
        case 'mtrg':
            return performTriggerReview(document);
        case 'jrxml':
            return [...checkJrxmlMocaConnection(document), ...performReportModuleReview(document)];
        case 'label':
            return performReportModuleReview(document);
        case 'database-table':
        case 'database-index':
        case 'database-sequence':
        case 'database-view':
        case 'database-trigger':
            return performDatabaseReview(document);
        case 'csv':
        case 'ctl':
        case 'postinstall':
            return performCsvModuleReview(document);
        default:
            return [];
    }
}
