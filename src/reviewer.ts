import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { maskCode, triviaSpans, adjacentComments, commandCalls, matching, maskXmlComments, xmlElements, xmlAttribute } from './analysis';
import { performDatabaseReview } from './rules/database';
import { performCsvModuleReview } from './rules/csv';
import { performReportModuleReview } from './rules/report';

export interface ReviewDocument {
    fileName: string;
    getText(): string;
    workspaceRoot?: string;
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
    const searchable = maskCdataBodies(maskXmlComments(text));
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
    const trimmedWithoutDeclaration = maskXmlComments(text).replace(/^\s*<\?xml[\s\S]*?\?>/i, '').trim();
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
    return maskCode(code, maskStrings);
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
        const namePattern = escapeRegExp(name.trim()).replace(/\s+/g, '\\s+');
        const callsOriginal = new RegExp(`\\^\\s*${namePattern}(?=\\s+where\\b|[\\r\\n|;}]|$)`, 'i').test(withoutComments);
        if (!startsWithPolicy || !callsOriginal || !policyEnclosesCustomization(syntax.content, name)) {
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

function policyEnclosesCustomization(code: string, name: string): boolean {
    const mask = maskCode(code);
    const header = /\bif\s*\(/i.exec(mask);
    if (!header) { return false; }
    const prefix = mask.slice(0, header.index);
    const setup = commandCalls(prefix);
    if (!setup.length || !/^\s*list\s+policies\b/i.test(prefix) || /[{}\[\]]/.test(prefix)
        || setup.slice(1).some(call => !/^publish\s+data\b/i.test(call.mask))) { return false; }
    const original = (body: string): boolean => {
        const value = body.trim().replace(/;\s*$/, '').trim();
        return new RegExp(`^\\^\\s*${escapeRegExp(name.trim()).replace(/\s+/g, '\\s+')}(?=\\s+where\\b|$)`, 'i').test(value)
            && commandCalls(value).length === 1 && !/[|{}\[\];]/.test(value);
    };
    const open = header.index + header[0].lastIndexOf('(');
    const conditionEnd = matching(mask, open);
    let cursor = skipWhitespace(mask, conditionEnd + 1);
    if (conditionEnd < 0 || mask[cursor] !== '{') { return false; }
    const thenEnd = matching(mask, cursor, '{', '}');
    if (thenEnd < 0) { return false; }
    const thenBody = mask.slice(cursor + 1, thenEnd);
    cursor = skipWhitespace(mask, thenEnd + 1);
    if (mask[cursor] === '|') { return original(mask.slice(cursor + 1)); }
    if (!/^else\b/i.test(mask.slice(cursor))) { return false; }
    cursor = skipWhitespace(mask, cursor + 4);
    if (mask[cursor] !== '{') { return false; }
    const elseEnd = matching(mask, cursor, '{', '}');
    if (elseEnd < 0 || !/^[\s;]*$/.test(mask.slice(elseEnd + 1))) { return false; }
    return original(mask.slice(cursor + 1, elseEnd)) || original(thenBody);
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
    return adjacentComments(code, block.startIndex, block.endIndex + 1,
        innerIndex === undefined ? undefined : block.startIndex + 1 + innerIndex).length > 0;
}

function hasSqlCatch(code: string, block: BracketBlock): boolean {
    const mask = maskCommentsAndStrings(code);
    const caughtAfter = (end: number) => /^\s*catch\s*\(\s*[^\s)][^)]*\)/i.test(mask.slice(end + 1));
    if (caughtAfter(block.endIndex)) {
        return true;
    }
    // A catch on an enclosing MOCA group also handles the SQL failure.
    const groups: number[] = [];
    for (let i = 0; i < block.startIndex; i++) {
        if (mask[i] === '{') { groups.push(i); }
        if (mask[i] === '}') { groups.pop(); }
    }
    for (const start of groups) {
        let depth = 1;
        for (let i = start + 1; i < mask.length; i++) {
            if (mask[i] === '{') { depth++; }
            if (mask[i] === '}' && --depth === 0) {
                if (caughtAfter(i)) { return true; }
                break;
            }
        }
    }
    return false;
}

function selectItems(mask: string): { start: number; end: number }[] {
    const items: { start: number; end: number }[] = [];
    const depths = parenDepths(mask);
    for (const select of mask.matchAll(/\bselect\b/gi)) {
        const start = select.index! + select[0].length;
        const depth = depths[select.index!];
        let itemStart = start;
        for (let i = start; i <= mask.length; i++) {
            const boundary = i === mask.length || depths[i] < depth
                || (depths[i] === depth && (mask[i] === ','
                    || (!/[\w$#]/.test(mask[i - 1] ?? '')
                        && /^(?:from|into|where|union|group\s+by|order\s+by|having)\b/i.test(mask.slice(i)))));
            if (!boundary) {
                continue;
            }
            items.push({ start: itemStart, end: i });
            if (mask[i] !== ',') {
                break;
            }
            itemStart = i + 1;
        }
    }
    return items;
}

function resultAlias(expression: string): string | undefined {
    return /(?:\s+as)?\s+([a-z_$#][\w$#]*)$/i.exec(expression.trim())?.[1].toLowerCase();
}

function hasNumberStep(expression: string, aliases?: ReadonlySet<string>): boolean {
    const parents: { start: number; end: number }[] = [];
    const stack: number[] = [];
    for (let i = 0; i < expression.length; i++) {
        if (expression[i] === '(') { stack.push(i); }
        if (expression[i] === ')' && stack.length) {
            parents.push({ start: stack.pop()!, end: i });
        }
    }
    // Follow operations on the aggregate/variable itself, not unrelated arithmetic
    // in another CASE branch, a SUBSTR offset, or an NVL default argument.
    for (const match of expression.matchAll(/\b(max|min)\s*\(|@[a-z_$#][\w$#]*/gi)) {
        const variable = match[0].startsWith('@');
        if (aliases ? !variable || !aliases.has(match[0].slice(1).toLowerCase()) : variable) {
            continue;
        }
        let start = match.index!;
        let end = variable ? start + match[0].length - 1 : findClosingParen(expression, expression.indexOf('(', start));
        if (end === -1) { continue; }
        if (!variable) {
            // MAX(column + 1) is also allocation; arithmetic on SUBSTR/INSTR
            // positions inside the argument is not. Reuse the same operand walk.
            const columns = new Set<string>();
            const argument = expression.slice(expression.indexOf('(', start) + 1, end)
                .replace(/(@[a-z_$#][\w$#]*)|\b([a-z_$#][\w$#]*(?:\.[a-z_$#][\w$#]*)*)\b(?!\s*\()/gi,
                    (token, parameter: string | undefined) => {
                        if (parameter || /^(?:as|case|when|then|else|end|distinct|null)$/i.test(token)) { return token; }
                        const name = `max_arg_${columns.size}`;
                        columns.add(name);
                        return `@${name}`;
                    });
            if (columns.size && hasNumberStep(argument, columns)) { return true; }
        }
        while (true) {
            if (/^\s*[+-]\s*(?:[1-9]\d*|@[a-z_$#][\w$#]*)(?![\w$.])/i.test(expression.slice(end + 1))
                || /(?:^|[^\w$.])(?:[1-9]\d*|@[a-z_$#][\w$#]*)\s*\+\s*$/i.test(expression.slice(0, start))) {
                return true;
            }
            const parent = parents.filter(p => p.start < start && p.end >= end)
                .sort((a, b) => b.start - a.start)[0];
            if (!parent) { break; }
            const fn = /([a-z_$#][\w$#]*)\s*$/i.exec(expression.slice(0, parent.start));
            if (fn && /^(?:substr|substring|instr|charindex|length|len|count)$/i.test(fn[1])) {
                break;
            }
            start = fn ? fn.index : parent.start;
            end = parent.end;
        }
    }
    return false;
}

function splitSqlValues(expression: string): string[] {
    const depths = parenDepths(expression);
    const values: string[] = [];
    let start = 0;
    for (let i = 0; i <= expression.length; i++) {
        if (i === expression.length || (expression[i] === ',' && depths[i] === 0)) {
            values.push(expression.slice(start, i));
            start = i + 1;
        }
    }
    return values;
}

function aggregateResultSteppedLater(block: BracketBlock, alias: string, code: string): boolean {
    const tail = maskCommentsAndStrings(code).slice(block.endIndex + 1);
    const aliases = new Set([alias.toLowerCase()]);
    // Keep SQL blocks intact; MOCA pipes/braces delimit the remaining stages.
    const stages = /\[[^\[\]]*\]|[^|;{}\[\]]+/g;
    for (const match of tail.matchAll(stages)) {
        const statement = match[0].trim();
        const expressions: { value: string; output?: string }[] = [];
        if (statement.startsWith('[')) {
            const sql = statement.slice(1, -1);
            for (const item of selectItems(sql)) {
                const value = sql.slice(item.start, item.end).trim();
                expressions.push({ value, output: resultAlias(value) });
            }
            if (/^\s*update\b/i.test(sql)) {
                const set = /\bset\b([\s\S]*?)(?:\bwhere\b|$)/i.exec(sql)?.[1] ?? '';
                expressions.push(...splitSqlValues(set).map(value => ({ value })));
            }
            if (/^\s*insert\b/i.test(sql)) {
                const values = /\bvalues\s*\(/i.exec(sql);
                if (values) {
                    const open = sql.indexOf('(', values.index);
                    const close = findClosingParen(sql, open);
                    if (close !== -1) {
                        expressions.push(...splitSqlValues(sql.slice(open + 1, close)).map(value => ({ value })));
                    }
                }
            }
        } else if (/^(?:publish\s+data|create\b|add\b|change\b|update\b)/i.test(statement)) {
            const parameters = /\bwhere\b([\s\S]*)/i.exec(statement)?.[1] ?? '';
            for (const assignment of parameters.matchAll(/\b([a-z_$#][\w$#]*)\s*=\s*([\s\S]*?)(?=\band\s+[a-z_$#][\w$#]*\s*=|$)/gi)) {
                expressions.push({ value: assignment[2], output: /^publish\s+data\b/i.test(statement) ? assignment[1].toLowerCase() : undefined });
            }
        }
        const changes = new Map<string, boolean>();
        for (const expression of expressions) {
            const dependsOnAggregate = [...aliases].some(name =>
                new RegExp(`@${escapeRegExp(name)}(?![\\w$#])`, 'i').test(expression.value));
            if (dependsOnAggregate && hasNumberStep(expression.value, aliases)) {
                return true;
            }
            if (expression.output) {
                changes.set(expression.output, dependsOnAggregate);
            }
        }
        // Assignments in one publish/SELECT use the input context, then replace outputs.
        for (const [name, derived] of changes) {
            if (derived) { aliases.add(name); } else { aliases.delete(name); }
        }
        if (aliases.size === 0) {
            return false;
        }
    }
    return false;
}

function checkSqlConcurrency(blocks: BracketBlock[], file: string, source: string, syntax: SyntaxContext): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const block of blocks) {
        const mask = maskCommentsAndStrings(block.content);
        for (const match of mask.matchAll(/\b(max|min)\s*\(/gi)) {
            const open = mask.indexOf('(', match.index);
            const close = findClosingParen(mask, open);
            if (close === -1) {
                continue;
            }
            const item = selectItems(mask).filter(candidate => candidate.start <= match.index! && match.index! < candidate.end)
                .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
            const expression = item && mask.slice(item.start, item.end).trim();
            const alias = expression && resultAlias(expression);
            const argument = mask.slice(open + 1, close).trim();
            const column = /^(?:[a-z_$#][\w$#]*\s*\.\s*)*([a-z_$#][\w$#]*)$/i.exec(argument)?.[1];
            const measurement = (value: string) => /(?:qty|quantity|weight|wgt|height|hgt|width|wdt|volume|price|cost|amount|temperature|percent|timestamp|duration|dte|date|time)$|(?:^|_)untcas$/i.test(value);
            const sequenceAlias = alias && /(?:^|_)(?:id|seq|seqno|seqnum|sequence|number|lineno|notlin|invlin|ordlin)(?:_|$)/i.test(alias);
            // Known quantity/date/measurement values remain measurements when
            // offset or combined; they are not allocation counters merely because
            // an integer occurs in the formula. Explicit sequence outputs override this.
            if (!sequenceAlias && ((column && measurement(column)) || (alias && measurement(alias)))) {
                continue;
            }
            if (!expression || (!hasNumberStep(expression)
                && !(alias && aggregateResultSteppedLater(block, alias, syntax.content)))) {
                continue;
            }
            issues.push(issueAt(file, source, syntax.contentOffset + block.startIndex + 1 + match.index!,
                vscode.DiagnosticSeverity.Warning,
                `${match[1].toUpperCase()}() appears to allocate or write a number from existing rows; concurrent sessions may choose the same value. Prefer a database sequence or serialize allocation and handle duplicate-key failures`,
                'sql-min-max-race-condition'));
            // One actionable reminder per SQL block rather than one per aggregate.
            break;
        }
    }
    return issues;
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
    if (isListOrGet) {
        for (const call of commandCalls(syntax.content)) {
            const write = /^(create|change|remove)\s+record\b/i.exec(call.mask);
            if (!write) { continue; }
            const operation = write[1].toLowerCase() === 'create' ? 'insert' : write[1].toLowerCase() === 'change' ? 'update' : 'delete';
            issues.push(issueAt(file, source, syntax.contentOffset + call.start, vscode.DiagnosticSeverity.Error,
                `${write[0]} is not allowed in list/get commands`, `list-get-no-${operation}`));
        }
    }
    for (const block of blocks) {
        const mask = maskCommentsAndStrings(block.content);
        const dml = /\b(insert|update|delete)\b/gi;
        let match: RegExpExecArray | null;
        let missingCommentReported = false;
        while ((match = dml.exec(mask)) !== null) {
            const operationName = match[1].toLowerCase();
            // SELECT ... FOR UPDATE locks rows but does not assign updated values.
            if (operationName === 'update' && /\bfor\s*$/i.test(mask.slice(0, match.index))) {
                continue;
            }
            const operation = operationName.toUpperCase();
            const absoluteIndex = syntax.contentOffset + block.startIndex + 1 + match.index;
            const expectedCommand = operationName === 'insert'
                ? 'create record'
                : operationName === 'update' ? 'change record' : 'remove record';
            issues.push(issueAt(file, source, absoluteIndex, vscode.DiagnosticSeverity.Warning, `${operation} is used; confirm the direct DML is necessary`, `avoid-${operationName}`));
            if (operationName === 'update') {
                if (!hasSqlCatch(syntax.content, block)) {
                    issues.push(issueAt(file, source, absoluteIndex, vscode.DiagnosticSeverity.Error,
                        'SQL UPDATE requires catch(...) on the SQL block or an enclosing MOCA group; prefer change record except when changing primary keys', 'update-missing-catch'));
                }
                issues.push(issueAt(file, source, absoluteIndex, vscode.DiagnosticSeverity.Warning,
                    'SQL UPDATE: also update audit fields such as last_update_usr and last_update_time', 'update-audit-fields'));
            }
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
    return adjacentComments(code, block.startIndex, block.endIndex + 1,
        innerIndex === undefined ? undefined : block.startIndex + 1 + innerIndex).some(comment => pattern.test(comment));
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
                const poldat = reference.name === 'poldat';
                const reason = adjacentCommentMatches(syntax.content, block,
                    poldat ? /poldat_view|performance|database\s+lock|\bview\b/i : /(?:\bview\b|_view\b)/i, reference.index);
                if (!poldat && (sameSelectHasView || reason)) {
                    continue;
                }
                issues.push(issueAt(file, source, absoluteIndex, vscode.DiagnosticSeverity.Warning, message, rule));
                if (reason) { continue; }
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

function unwrapExpression(value: string): string {
    let result = value.trim();
    while (result.startsWith('(') && matching(result, 0) === result.length - 1) {
        result = result.slice(1, -1).trim();
    }
    return result;
}

function denominatorToken(mask: string, slashIndex: number): string {
    const start = skipWhitespace(mask, slashIndex + 1);
    if (mask[start] === '(') {
        const close = matching(mask, start);
        return close < 0 ? '' : unwrapExpression(mask.slice(start, close + 1));
    }
    const functionMatch = /^[a-z_$#][\w$#]*\s*\(/i.exec(mask.slice(start));
    if (functionMatch) {
        const close = matching(mask, mask.indexOf('(', start));
        return close < 0 ? '' : mask.slice(start, close + 1).trim();
    }
    return /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?/i.exec(mask.slice(start))?.[0]
        || /^@?[a-z0-9_$#]+(?:\.[a-z0-9_$#]+)*/i.exec(mask.slice(start))?.[0] || '';
}

function numericLiteral(value: string): number | undefined {
    const text = unwrapExpression(value);
    return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : undefined;
}

function isConstantDenominator(denominator: string): boolean {
    const number = numericLiteral(denominator);
    return number !== undefined && Number.isFinite(number) && number !== 0;
}

function splitFunctionArguments(call: string): string[] {
    const open = call.indexOf('('), close = call.lastIndexOf(')');
    return open < 0 || close <= open ? [] : splitSqlValues(call.slice(open + 1, close)).map(arg => arg.trim());
}

function isProtectedDenominator(denominator: string): boolean {
    const value = unwrapExpression(denominator);
    const open = value.indexOf('(');
    if (open < 0 || matching(value, open) !== value.length - 1) { return false; }
    const args = splitFunctionArguments(value);
    if (/^nullif\s*\(/i.test(value)) {
        return args.length === 2 && numericLiteral(args[1]) === 0;
    }
    if (!/^decode\s*\(/i.test(value) || args.length < 3) { return false; }
    const hasDefault = args.length % 2 === 0;
    const pairEnd = hasDefault ? args.length - 1 : args.length;
    const searches = new Set<number>();
    let handlesZero = false;
    // This is an explicit zero-handling format rule, not a proof of business
    // values. Reject literal-zero branches; do not assume other columns are zero.
    const safe = (result: string): boolean => result.trim().length > 0 && numericLiteral(result) !== 0;
    for (let i = 1; i + 1 < pairEnd; i += 2) {
        const search = numericLiteral(args[i]);
        if (search !== undefined && searches.has(search)) { continue; }
        if (search !== undefined) { searches.add(search); }
        if (search === 0) { handlesZero = true; }
        if (!safe(args[i + 1])) { return false; }
    }
    return handlesZero && (!hasDefault || safe(args[args.length - 1]));
}

function provesNonzero(condition: string, denominator: string, truth: boolean): boolean {
    const clean = unwrapExpression(condition);
    const depths = parenDepths(clean);
    for (const operator of ['or', 'and']) {
        const parts: string[] = [];
        let start = 0;
        for (const m of clean.matchAll(new RegExp('\\b' + operator + '\\b', 'gi'))) {
            if (depths[m.index!] === 0) { parts.push(clean.slice(start, m.index)); start = m.index! + m[0].length; }
        }
        if (parts.length) {
            parts.push(clean.slice(start));
            const all = (operator === 'or') === truth;
            return all ? parts.every(p => provesNonzero(p, denominator, truth))
                : parts.some(p => provesNonzero(p, denominator, truth));
        }
    }
    const name = unwrapExpression(denominator).replace(/\s/g, '').toLowerCase();
    const comparison = clean.replace(/\s/g, '').toLowerCase();
    if (!name) { return false; }
    return truth
        ? [name + '<>0', name + '!=0', '0<>' + name, '0!=' + name].includes(comparison)
        : [name + '=0', '0=' + name].includes(comparison);
}

function hasCaseZeroGuard(mask: string, slashIndex: number, denominator: string): boolean {
    const frames: { subject: string; start: number; conditions: string[]; branch: string; conditionStart: number }[] = [];
    for (const m of mask.slice(0, slashIndex).matchAll(/\b(case|when|then|else|end)\b/gi)) {
        const word = m[1].toLowerCase(), index = m.index!, after = index + m[0].length;
        if (word === 'case') { frames.push({ subject: '', start: after, conditions: [], branch: '', conditionStart: after }); continue; }
        const frame = frames[frames.length - 1];
        if (!frame) { continue; }
        if (word === 'end') { frames.pop(); }
        else if (word === 'when') {
            if (!frame.conditions.length) { frame.subject = mask.slice(frame.start, index).trim(); }
            frame.conditionStart = after; frame.branch = 'condition';
        } else if (word === 'then') {
            const condition = mask.slice(frame.conditionStart, index).trim();
            frame.conditions.push(frame.subject ? frame.subject + '=' + condition : condition);
            frame.branch = 'then';
        } else if (word === 'else') { frame.branch = 'else'; }
    }
    return frames.some(frame => {
        const previous = frame.branch === 'then' ? frame.conditions.slice(0, -1)
            : frame.branch === 'else' ? frame.conditions : [];
        return previous.some(c => provesNonzero(c, denominator, false))
            || (frame.branch === 'then' && provesNonzero(frame.conditions[frame.conditions.length - 1] || '', denominator, true));
    });
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
        if (!adjacentCommentMatches(syntax.content, block, requiredComment, select.index)) {
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
        const markers = triviaSpans(content).filter(span => span.kind === 'comment' && /^\/\*\s*#(?:nobind|bind)\s*\*\/$/i.test(span.text))
            .map(span => ({ index: span.start, kind: /#(nobind|bind)/i.exec(span.text)![1].toLowerCase() }))
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
        const executable = maskCode(content);
        while ((concat = concatPattern.exec(executable)) !== null) {
            const concatIndex = concat.index;
            const region = executable.slice(Math.max(0, concatIndex - 120), Math.min(content.length, concatIndex + 120));
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
        const content = maskCode(block.content);
        if (!/\bprtdsc\b/i.test(content) || !/\bcolval\b/i.test(content)) {
            continue;
        }
        const colvalIndex = /\bcolval\b/i.exec(content)?.index ?? 0;
        const markerComments = triviaSpans(block.content).filter(span => span.kind === 'comment');
        const hasNobind = markerComments.some(span => span.start < colvalIndex && /^\/\*\s*#nobind\s*\*\/$/i.test(span.text));
        const hasBind = markerComments.some(span => span.start > colvalIndex && /^\/\*\s*#bind\s*\*\/$/i.test(span.text));
        if (!hasNobind || !hasBind) {
            issues.push(issueAt(file, source, syntaxOffset + block.startIndex + 1 + colvalIndex, vscode.DiagnosticSeverity.Error, 'prtdsc.colval concatenation must be wrapped in /*#nobind*/ ... /*#bind*/', 'prtdsc-nobind-bind'));
        }
    }
    return issues;
}

function checkTimestampExpressions(blocks: BracketBlock[], file: string, source: string, syntaxOffset: number): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const block of blocks) {
        const content = maskCode(block.content);
        const match = /\bfrom_tz\s*\(/i.exec(content);
        if (!match || !/\b(?:cast\s*\(|to_char\s*\(|sessiontimezone\b|at\s+time\s+zone\b)/i.test(content)) {
            continue;
        }
        const markers = triviaSpans(block.content).filter(span => span.kind === 'comment');
        const hasNobind = markers.some(span => span.start < match.index && /^\/\*\s*#nobind\s*\*\/$/i.test(span.text));
        const hasBind = markers.some(span => span.start > match.index && /^\/\*\s*#bind\s*\*\/$/i.test(span.text));
        if (!hasNobind || !hasBind) {
            issues.push(issueAt(file, source, syntaxOffset + block.startIndex + 1 + match.index, vscode.DiagnosticSeverity.Error, 'Complex timestamp expressions must be wrapped in /*#nobind*/ ... /*#bind*/', 'timestamp-nobind-bind'));
        }
    }
    return issues;
}

function checkSessionVariable(syntax: SyntaxContext, file: string, source: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const call of commandCalls(syntax.content)) {
        if (!/^get\s+session\s+variable(?=\s+(?:where|catch)\b|\s*(?:>>|$))/i.test(call.mask)) { continue; }
        const tail = maskCode(syntax.content.slice(call.end, call.end + 400));
        if (!/catch\s*\(/i.test(call.mask) && !/(?:nvl\s*\(\s*@value\b|@\w+\s*=\s*nvl\s*\()/i.test(tail)) {
            issues.push(issueAt(file, source, syntax.contentOffset + call.start, vscode.DiagnosticSeverity.Warning,
                'Get Session Variable must catch errors or explicitly default @value', 'session-variable-uncaptured'));
        }
    }
    return issues;
}

function checkListExecuteCommands(commandName: string, syntax: SyntaxContext, file: string, source: string): McmdIssue[] {
    if (!/^list(?:\s|$)/i.test(commandName.trim())) { return []; }
    return commandCalls(syntax.content).filter(call => /^execute\b/i.test(call.mask)).map(call =>
        issueAt(file, source, syntax.contentOffset + call.start, vscode.DiagnosticSeverity.Error,
            'List commands must not invoke MOCA commands starting with execute', 'list-no-execute-command'));
}

function checkExecuteServerCommand(syntax: SyntaxContext, file: string, source: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const call of commandCalls(syntax.content)) {
        if (/^execute\s+server\s+command\b/i.test(call.mask) && (call.text.match(/'/g) || []).length % 2 === 1) {
            issues.push(issueAt(file, source, syntax.contentOffset + call.start, vscode.DiagnosticSeverity.Warning,
                'Execute Server Command must handle single quotes in parameter values correctly', 'execute-server-command-quotes'));
        }
    }
    return issues;
}

function checkSendEmail(syntax: SyntaxContext, file: string, source: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    for (const call of commandCalls(syntax.content)) {
        if (!/^send\s+email\b/i.test(call.mask)) { continue; }
        const hardcoded = [...call.mask.matchAll(/\b(?:mail_from|send_from|mail_server|smtp_server)\s*=/gi)].some(param =>
            /^(?:mail_from|send_from|mail_server|smtp_server)\s*=\s*(?:nvl\s*\(\s*@[^,]+,\s*'[^']+'|'[^']+')/i.test(call.text.slice(param.index)));
        if (hardcoded) {
            issues.push(issueAt(file, source, syntax.contentOffset + call.start, vscode.DiagnosticSeverity.Error,
                'Send Email must not hardcode default sender/server configuration; keep defaults in policy', 'send-email-hardcoded-config'));
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
    issues.push(...checkListExecuteCommands(name, syntax, file, text));
    const blocks = extractBracketBlocks(syntax.content);
    issues.push(...checkComplexSql(blocks, name, file, text, syntax.contentOffset));
    issues.push(...checkSelectComments(blocks, syntax, file, text));
    issues.push(...checkDml(blocks, name, file, text, syntax));
    issues.push(...checkSqlConcurrency(blocks, file, text, syntax));
    issues.push(...checkInSubqueries(blocks, file, text, syntax.contentOffset));
    issues.push(...checkSelectClauseSubqueries(blocks, file, text, syntax.contentOffset));
    issues.push(...checkNonViewTables(blocks, file, text, syntax));
    issues.push(...checkDivisions(blocks, file, text, syntax.contentOffset));
    issues.push(...checkSysdate(blocks, file, text, syntax.contentOffset));
    issues.push(...checkValidateKeyExistence(blocks, file, text, syntax.contentOffset));
    issues.push(...checkDistinctRownum(blocks, file, text, syntax.contentOffset));
    issues.push(...checkRawUsage(blocks, file, text, syntax.contentOffset));
    for (const match of maskCode(syntax.content).matchAll(/:raw\b/gi)) {
        issues.push(issueAt(file, text, syntax.contentOffset + match.index!, vscode.DiagnosticSeverity.Warning,
            ':raw requires confirmed SQL injection protection', 'raw-usage'));
    }
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
    if (!withoutTrailingTerminator || hasForbiddenControl || hasMultipleSemicolons || commandCalls(syntax.content).length !== 1) {
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
    if (branchName === 'develop' || /^feature\/SWIFTLEX-[A-Za-z0-9_-]+$/.test(branchName)) {
        return [];
    }
    return [{
        file: '',
        line: 1,
        column: 1,
        severity: vscode.DiagnosticSeverity.Error,
        message: `Git branch name '${branchName}' must be develop or match feature/SWIFTLEX-<ticket>[_-]<suffix>; letters, digits, underscores and hyphens are allowed after SWIFTLEX-`,
        rule: 'invalid-branch-name'
    }];
}

export function checkJrxmlMocaConnection(document: ReviewDocument): McmdIssue[] {
    const text = document.getText(), issues: McmdIssue[] = [];
    for (const parameter of xmlElements(text, 'parameter')) {
        if (xmlAttribute(parameter.open, 'name') !== 'MOCA_REPORT_CONNECTION' || parameter.selfClosing) { continue; }
        const body = maskXmlComments(parameter.body).trim();
        const properties = xmlElements(body, 'property');
        const property = properties[0];
        const propertyOnly = properties.length === 1 && property.selfClosing
            && body === property.open
            && xmlAttribute(property.open, 'name') === 'MOCA'
            && xmlAttribute(property.open, 'value') === 'true';
        if (!propertyOnly) {
            issues.push(issueAt(document.fileName, text, parameter.start, vscode.DiagnosticSeverity.Error,
                'MOCA_REPORT_CONNECTION must be self-closing or contain only the MOCA property without a local/hardcoded connection',
                'jrxml-moca-connection-invalid'));
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
