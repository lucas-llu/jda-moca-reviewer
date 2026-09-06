import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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

function normalizePath(fileName: string): string {
    return fileName.replace(/\\/g, '/').toLowerCase();
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

function maskComments(code: string): string {
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
            blank(index, end === -1 ? code.length : end + 2);
            index = end === -1 ? code.length : end + 2;
            continue;
        }
        if (code.startsWith('--', index)) {
            const end = code.indexOf('\n', index + 2);
            blank(index, end === -1 ? code.length : end);
            index = end === -1 ? code.length : end;
            continue;
        }
        index++;
    }
    return chars.join('');
}

function extractCreateTableNames(text: string): string[] {
    const mask = maskComments(text);
    const names: string[] = [];
    const pattern = /\bCREATE_TABLE\s*\(\s*("[^"]+"|[a-z0-9_$#]+)\s*\)/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(mask)) !== null) {
        names.push(match[1].replace(/["\s]/g, ''));
    }
    return names;
}

function extractCreateIndex(text: string): { table: string; index: string } | undefined {
    const mask = maskComments(text);
    const match = /\bCREATE_INDEX_BEGIN\s*\(\s*("[^"]+"|[a-z0-9_$#]+)\s*,\s*("[^"]+"|[a-z0-9_$#]+)\s*\)/i.exec(mask);
    if (!match) {
        return undefined;
    }
    return { table: match[1].replace(/["\s]/g, ''), index: match[2].replace(/["\s]/g, '') };
}

function extractCreateSequenceName(text: string): string | undefined {
    const mask = maskComments(text);
    const match = /\bCREATE\s+SEQUENCE\s+("[^"]+"|[a-z0-9_$#]+)/i.exec(mask);
    return match?.[1].replace(/["\s]/g, '');
}

function extractCreateViewName(text: string): string | undefined {
    const mask = maskComments(text);
    const macro = /\bCREATE_VIEW_BEGIN\s*\(\s*("[^"]+"|[a-z0-9_$#]+)\s*\)/i.exec(mask);
    if (macro) {
        return macro[1].replace(/["\s]/g, '');
    }
    const sql = /\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+("[^"]+"|[a-z0-9_$#]+)/i.exec(mask);
    return sql?.[1].replace(/["\s]/g, '');
}

function extractCreateTriggerName(text: string): string | undefined {
    const mask = maskComments(text);
    const macro = /\bCREATE_TRIGGER_BEGIN\s*\(\s*("[^"]+"|[a-z0-9_$#]+)\s*\)/i.exec(mask);
    if (macro) {
        return macro[1].replace(/["\s]/g, '');
    }
    const sql = /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+("[^"]+"|[a-z0-9_$#]+)/i.exec(mask);
    return sql?.[1].replace(/["\s]/g, '');
}

function findClosingParen(text: string, openIndex: number): number {
    let depth = 0;
    for (let index = openIndex; index < text.length; index++) {
        if (text[index] === '(') {
            depth++;
        } else if (text[index] === ')') {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function extractCreateTableBlock(text: string): string | undefined {
    const mask = maskComments(text);
    const match = /\bCREATE_TABLE\s*\(\s*("[^"]+"|[a-z0-9_$#]+)\s*\)\s*\(/i.exec(mask);
    if (!match) {
        return undefined;
    }
    const open = match.index + match[0].length - 1;
    const close = findClosingParen(mask, open);
    return close === -1 ? undefined : mask.slice(open + 1, close);
}

function extractAlterColumns(text: string): { table: string; column: string; index: number }[] {
    const mask = maskComments(text);
    const result: { table: string; column: string; index: number }[] = [];
    const pattern = /\bALTER_TABLE_(?:ADD_COLUMN|MODIFY_COLUMN_DATATYPE)_BEGIN\s*\(\s*("[^"]+"|[a-z0-9_$#]+)\s*,\s*("[^"]+"|[a-z0-9_$#]+)\s*\)/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(mask)) !== null) {
        result.push({
            table: match[1].replace(/["\s]/g, ''),
            column: match[2].replace(/["\s]/g, ''),
            index: match.index
        });
    }
    return result;
}

function findProjectRoot(fileName: string): string | undefined {
    let current = path.dirname(fileName);
    for (let depth = 0; depth < 10; depth++) {
        try {
            if (fs.existsSync(path.join(current, 'les')) || fs.existsSync(path.join(current, '.git'))) {
                return current;
            }
        } catch {
            return undefined;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
    return undefined;
}

function findOrcaCsvFiles(workspaceRoot: string): string[] {
    const candidates = [
        path.join(workspaceRoot, 'les', 'db', 'data', 'load', 'lc', 'bootstraponly', 'usr_lc_orca_tables'),
        path.join(workspaceRoot, 'les', 'db', 'data', 'load', 'lc', 'orcaload')
    ];
    const files: string[] = [];
    for (const directory of candidates) {
        if (!fs.existsSync(directory)) {
            continue;
        }
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.name.toLowerCase().endsWith('.csv')) {
                    files.push(full);
                }
            }
        };
        walk(directory);
    }
    return files;
}

function findIndexUnloadFiles(workspaceRoot: string): string[] {
    const candidates = [
        path.join(workspaceRoot, 'les', 'db', 'ddl', 'lc', 'indexunload'),
        path.join(workspaceRoot, 'les', 'db', 'data', 'unload')
    ];
    const files: string[] = [];
    for (const directory of candidates) {
        if (!fs.existsSync(directory)) {
            continue;
        }
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.name.toLowerCase().endsWith('.sql') || entry.name.toLowerCase().endsWith('.ctl')) {
                    files.push(full);
                }
            }
        };
        walk(directory);
    }
    return files;
}

function isLocalCustomisationObject(name: string): boolean {
    return /^usr_lc_/i.test(name);
}

function isPluginObject(name: string): boolean {
    return /^usr_pd_/i.test(name);
}

export function performDatabaseTableReview(document: ReviewDocument): McmdIssue[] {
    const text = document.getText();
    const file = document.fileName;
    const issues: McmdIssue[] = [];
    const normalizedPath = normalizePath(file);
    const workspaceRoot = document.workspaceRoot || findProjectRoot(file);
    const actualBaseName = path.basename(file, path.extname(file));
    const names = extractCreateTableNames(text);
    const tableName = names[0] || actualBaseName;

    if (names.length > 0 && tableName.toLowerCase() !== actualBaseName.toLowerCase()) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `File name '${actualBaseName}' does not match table '${tableName}'`, 'database-name-mismatch'));
    }
    if (tableName.length > 30) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `Table name '${tableName}' exceeds 30 characters`, 'database-name-too-long'));
    }

    const expectedPrefix = normalizedPath.includes('/les/db/ddl/pd/') ? 'usr_pd_' : 'usr_lc_';
    if (!new RegExp(`^${expectedPrefix}`, 'i').test(tableName)) {
        issues.push(issueAt(
            file,
            text,
            text.indexOf(tableName) === -1 ? 0 : text.indexOf(tableName),
            vscode.DiagnosticSeverity.Error,
            `Database object '${tableName}' must start with '${expectedPrefix}'`,
            'database-prefix-invalid'
        ));
    }

    if (names.length > 0 && !/CREATE_PK_CONSTRAINT_BEGIN|\bPRIMARY\s+KEY\b|\/\*\s*PK\s*\*\//i.test(maskComments(text))) {
        issues.push(issueAt(file, text, text.indexOf('CREATE_TABLE') === -1 ? 0 : text.indexOf('CREATE_TABLE'), vscode.DiagnosticSeverity.Error, `Table '${tableName}' must define a primary key`, 'database-table-missing-primary-key'));
    }

    const createBlock = extractCreateTableBlock(text);
    for (const alter of extractAlterColumns(text)) {
        if (!isLocalCustomisationObject(alter.table) && !isPluginObject(alter.table)) {
            issues.push(issueAt(file, text, alter.index, vscode.DiagnosticSeverity.Error, `New fields must not be added to BY/Core/Plugin table '${alter.table}'`, 'database-alter-non-lc-table'));
        }
        if (createBlock && !new RegExp(`\\b${alter.column}\\b`, 'i').test(createBlock)) {
            issues.push(issueAt(file, text, alter.index, vscode.DiagnosticSeverity.Error, `ALTER column '${alter.column}' is missing from the CREATE_TABLE definition`, 'database-alter-column-missing-in-create'));
        }
    }

    const alterPattern = /ALTER_TABLE_ADD_COLUMN_BEGIN[\s\S]*?ALTER_TABLE_ADD_COLUMN_END\]/gi;
    let alterBlock: RegExpExecArray | null;
    while ((alterBlock = alterPattern.exec(maskComments(text))) !== null) {
        const after = maskComments(text).slice(alterBlock.index + alterBlock[0].length, alterBlock.index + alterBlock[0].length + 300);
        if (!/ERR_COLUMN_ALREADY_EXISTS|-?1400|-?904|-?1442|-?2714/i.test(after)) {
            issues.push(issueAt(file, text, alterBlock.index, vscode.DiagnosticSeverity.Error, 'ALTER_TABLE_ADD_COLUMN must be idempotent and catch an already-exists error', 'database-alter-not-idempotent'));
        }
    }

    if (workspaceRoot && isLocalCustomisationObject(tableName)) {
        const orcaFiles = findOrcaCsvFiles(workspaceRoot);
        const registered = orcaFiles.some(csvFile => {
            const content = fs.readFileSync(csvFile, 'utf8');
            return new RegExp(`(?:^|,|\\s)${tableName}(?:,|\\s|$)`, 'i').test(content);
        });
        if (!registered) {
            issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `New LC table '${tableName}' must be registered in an usr_lc_orca_tables CSV`, 'orca-table-not-registered'));
        }
    }

    return issues;
}

export function performDatabaseIndexReview(document: ReviewDocument): McmdIssue[] {
    const text = document.getText();
    const file = document.fileName;
    const issues: McmdIssue[] = [];
    const workspaceRoot = document.workspaceRoot || findProjectRoot(file);
    const actualBaseName = path.basename(file, path.extname(file));
    const create = extractCreateIndex(text);
    if (!create) {
        return issues;
    }
    if (create.index.toLowerCase() !== actualBaseName.toLowerCase()) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `File name '${actualBaseName}' does not match index '${create.index}'`, 'database-name-mismatch'));
    }
    const expectedPrefix = normalizePath(file).includes('/les/db/ddl/pd/') ? 'usr_pd_' : 'usr_lc_';
    if (!new RegExp(`^${expectedPrefix}`, 'i').test(create.index)) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `Index '${create.index}' must start with '${expectedPrefix}'`, 'database-prefix-invalid'));
    }
    if (!isLocalCustomisationObject(create.table)) {
        if (workspaceRoot) {
            const unloadFiles = findIndexUnloadFiles(workspaceRoot);
            const hasUnload = unloadFiles.some(fileName => {
                const content = fs.readFileSync(fileName, 'utf8');
                return content.toLowerCase().includes(create.index.toLowerCase());
            });
            if (!hasUnload) {
                issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `Index '${create.index}' on BY/Core/Plugin table requires an index unload DDL file`, 'index-unload-missing'));
            }
        }
    }
    return issues;
}

export function performDatabaseSequenceReview(document: ReviewDocument): McmdIssue[] {
    const text = document.getText();
    const file = document.fileName;
    const issues: McmdIssue[] = [];
    const normalizedPath = normalizePath(file);
    const actualBaseName = path.basename(file, path.extname(file));
    const sequenceName = extractCreateSequenceName(text) || actualBaseName;

    if (extractCreateSequenceName(text) && sequenceName.toLowerCase() !== actualBaseName.toLowerCase()) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `File name '${actualBaseName}' does not match sequence '${sequenceName}'`, 'database-name-mismatch'));
    }
    const expectedPrefix = normalizedPath.includes('/les/db/ddl/pd/') ? 'usr_pd_' : 'usr_lc_';
    if (!new RegExp(`^${expectedPrefix}`, 'i').test(sequenceName)) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `Sequence '${sequenceName}' must start with '${expectedPrefix}'`, 'database-prefix-invalid'));
    }
    if (!/catch\s*\(\s*-?955\b/i.test(text)) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `Sequence '${sequenceName}' must catch -955 to be idempotent`, 'database-sequence-not-idempotent'));
    }
    return issues;
}

function performDatabaseNamedObjectReview(
    document: ReviewDocument,
    objectType: 'view' | 'trigger'
): McmdIssue[] {
    const text = document.getText();
    const file = document.fileName;
    const actualBaseName = path.basename(file, path.extname(file));
    const objectName = objectType === 'view' ? extractCreateViewName(text) : extractCreateTriggerName(text);
    const effectiveName = objectName || actualBaseName;
    const expectedPrefix = normalizePath(file).includes('/les/db/ddl/pd/') ? 'usr_pd_' : 'usr_lc_';
    const issues: McmdIssue[] = [];

    if (objectName && objectName.toLowerCase() !== actualBaseName.toLowerCase()) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `File name '${actualBaseName}' does not match ${objectType} '${objectName}'`, 'database-name-mismatch'));
    }
    if (!new RegExp(`^${expectedPrefix}`, 'i').test(effectiveName)) {
        const index = text.toLowerCase().indexOf(effectiveName.toLowerCase());
        issues.push(issueAt(file, text, index < 0 ? 0 : index, vscode.DiagnosticSeverity.Error, `Database ${objectType} '${effectiveName}' must start with '${expectedPrefix}'`, 'database-prefix-invalid'));
    }
    return issues;
}

export function performDatabaseReview(document: ReviewDocument): McmdIssue[] {
    const normalized = normalizePath(document.fileName);
    if (normalized.includes('/tables/')) {
        return performDatabaseTableReview(document);
    }
    if (normalized.includes('/indexes/')) {
        return performDatabaseIndexReview(document);
    }
    if (normalized.includes('/sequences/')) {
        return performDatabaseSequenceReview(document);
    }
    if (normalized.includes('/views/')) {
        return performDatabaseNamedObjectReview(document, 'view');
    }
    if (normalized.includes('/triggers/')) {
        return performDatabaseNamedObjectReview(document, 'trigger');
    }
    return [];
}
