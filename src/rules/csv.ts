import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { maskCode, matching, adjacentComments, triviaSpans } from '../analysis';

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

const PLUGIN_ERROR_RANGES: Record<string, { start: number; end: number; group?: string }> = {
    'swift-pd-customisations-amazon-messaging': { start: 3400000, end: 3400100, group: 'pd_amzmsg_errmsg' },
    'swift-pd-customisations-dangerous-goods': { start: 3900501, end: 3900999, group: 'pd_dg_errmsg' },
    'swift-pd-customisations-kni-fw': { start: 3900000, end: 3900500, group: 'pd_kni-errmsg' },
    'swift-pd-customisations-data_take_on': { start: 3700000, end: 3799999, group: 'pd_dto_errmsg' },
    'swift-pd-customisations-edi-api-factory': { start: 3800000, end: 3899999, group: 'pd_fac_errmsg' },
    'swift-pd-customisations-otm': { start: 3600000, end: 3699999, group: 'uc_otm_errmsg' },
    'swift-pd-customisations-pditastd': { start: 3002500, end: 3005000 },
    'swift-pd-customisations-standard-documents': { start: 3500000, end: 3599999 },
    'swift-pd-customisations-warehouseautomation': { start: 3981000, end: 3981499, group: 'pd_whauto' },
    'swift-pd-customisations-streamliner': { start: 3000001, end: 3000500 },
    'swift-pd-customisations-pddeustd': { start: 3200000, end: 3200100, group: 'pddeustd_errmsg' }
};

function pluginErrorRangeFor(fileName: string): { start: number; end: number; group?: string } | undefined {
    const normalized = normalizePath(fileName);
    const match = /swift-pd-customisations-[a-z0-9_-]+/i.exec(normalized);
    if (!match) {
        return undefined;
    }
    return PLUGIN_ERROR_RANGES[match[0].toLowerCase()];
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

function parseCsvRows(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (inQuotes) {
            if (char === '"' && text[index + 1] === '"') {
                field += '"';
                index++;
            } else if (char === '"') {
                inQuotes = false;
            } else {
                field += char;
            }
            continue;
        }
        if (char === '"' && field.length === 0) {
            inQuotes = true;
        } else if (char === ',') {
            row.push(field);
            field = '';
        } else if (char === '\n' || char === '\r') {
            if (char === '\r' && text[index + 1] === '\n') {
                index++;
            }
            row.push(field);
            if (row.some(value => value.trim().length > 0)) {
                rows.push(row);
            }
            row = [];
            field = '';
        } else {
            field += char;
        }
    }
    row.push(field);
    if (row.some(value => value.trim().length > 0)) {
        rows.push(row);
    }
    return rows;
}

function headerIndex(header: string[], name: string): number {
    return header.findIndex(value => value.trim().toLowerCase() === name.toLowerCase());
}

function rowStartIndex(text: string, dataRowIndex: number): number {
    let lineStart = 0;
    for (let line = 0; line <= dataRowIndex; line++) {
        const newline = text.indexOf('\n', lineStart);
        if (newline === -1) {
            return text.length;
        }
        lineStart = newline + 1;
    }
    return lineStart;
}

function findCtlForCsv(fileName: string): string | undefined {
    const directory = path.dirname(fileName);
    const currentDirName = path.basename(directory);
    const candidateCtl = path.join(directory, '..', `${currentDirName}.ctl`);
    if (fs.existsSync(candidateCtl)) {
        return candidateCtl;
    }
    return undefined;
}

function isUnloadPath(fileName: string): boolean {
    return normalizePath(fileName).includes('/unload/');
}

function findProjectRoot(fileName: string): string | undefined {
    let current = path.dirname(fileName);
    for (let depth = 0; depth < 12; depth++) {
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

function hasUsedUnloadDirectory(workspaceRoot: string): boolean {
    const unloadRoot = path.join(workspaceRoot, 'les', 'db', 'data', 'unload');
    if (!fs.existsSync(unloadRoot)) {
        return false;
    }
    const walk = (directory: string): boolean => {
        try {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const full = path.join(directory, entry.name);
                if (entry.isDirectory() && walk(full)) {
                    return true;
                }
                if (entry.isFile() && /\.(?:ctl|csv)$/i.test(entry.name)) {
                    return true;
                }
            }
        } catch {
            return false;
        }
        return false;
    };
    return walk(unloadRoot);
}

function hasUnloadCsv(ctlFile: string): boolean {
    const directory = path.dirname(ctlFile);
    const tableName = path.basename(ctlFile, path.extname(ctlFile));
    const siblings = [
        path.join(directory, tableName),
        path.join(directory, tableName.toLowerCase()),
        directory
    ];
    for (const dir of siblings) {
        try {
            if (fs.readdirSync(dir).some(name => name.toLowerCase().endsWith('.csv'))) {
                return true;
            }
        } catch {
            // Keep searching sibling layouts.
        }
    }
    return false;
}

function commentBefore(text: string, startIndex: number): boolean {
    const before = text.slice(0, startIndex);
    return adjacentComments(before, before.length, before.length).length > 0;
}

function hasSqlOutsideQuotes(text: string): boolean {
    return /(?:^|[^a-z0-9_])select\s+[^\r\n]*\s+from\b|insert\s+into\b|update\s+[a-z0-9_]+\s+set\b|delete\s+from\b/i.test(text)
        || /\bselect\b[\s\S]{0,120}\bfrom\b/i.test(text);
}


export function performCsvReview(document: ReviewDocument): McmdIssue[] {
    const text = document.getText();
    const file = document.fileName;
    const issues: McmdIssue[] = [];
    const rows = parseCsvRows(text);
    if (rows.length === 0) {
        return issues;
    }
    const header = rows[0];
    const normalized = normalizePath(file);
    const isPlugin = normalized.includes('/pd/') || normalized.includes('swift-pd-customisations-');

    if (rows.slice(1).some(row => row.some(value => hasSqlOutsideQuotes(value)))) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, 'CSV rows must not contain SQL', 'csv-contains-sql'));
    }

    const custLvlIndex = headerIndex(header, 'cust_lvl');
    if (custLvlIndex >= 0 && !isPlugin) {
        rows.slice(1).forEach((row, rowIndex) => {
            const value = Number(row[custLvlIndex]?.trim());
            if (!Number.isFinite(value) || value < 100) {
                issues.push(issueAt(file, text, rowStartIndex(text, rowIndex), vscode.DiagnosticSeverity.Error, 'cust_lvl must be 100 or higher', 'cust-lvl-too-low'));
            }
        });
    }

    const isMlsCat = normalized.includes('/les_mls_cat/') || path.basename(file).toLowerCase().startsWith('lc_les_mls_cat');
    if (isMlsCat) {
        const mlsIdIndex = headerIndex(header, 'mls_id');
        const groupIndex = headerIndex(header, 'grp_nam');
        const pluginRange = isPlugin ? pluginErrorRangeFor(file) ?? { start: 3000000, end: 3999999 } : undefined;
        rows.slice(1).forEach((row, rowIndex) => {
            const value = row[mlsIdIndex]?.trim() || '';
            if (/^err\d+$/i.test(value)) {
                const number = Number(value.replace(/^err/i, ''));
                const range = pluginRange ?? { start: 4000000, end: 4999999 };
                if (number < range.start || number > range.end) {
                    issues.push(issueAt(file, text, rowStartIndex(text, rowIndex), vscode.DiagnosticSeverity.Error, `les_mls_cat error ids must be between err${range.start} and err${range.end}`, 'mls-cat-invalid-id'));
                }
                const group = row[groupIndex]?.trim() || '';
                if (isPlugin && pluginRange?.group && group.toLowerCase() !== pluginRange.group.toLowerCase()) {
                    issues.push(issueAt(file, text, rowStartIndex(text, rowIndex), vscode.DiagnosticSeverity.Error, `les_mls_cat error group must be '${pluginRange.group}'`, 'mls-cat-invalid-group'));
                }
            } else if (value && isPlugin && !/^pd_/i.test(value)) {
                issues.push(issueAt(file, text, rowStartIndex(text, rowIndex), vscode.DiagnosticSeverity.Error, 'les_mls_cat non-error ids must start with pd_', 'mls-cat-invalid-id'));
            } else if (value && !isPlugin && !/^lc/i.test(value)) {
                issues.push(issueAt(file, text, rowStartIndex(text, rowIndex), vscode.DiagnosticSeverity.Error, 'les_mls_cat non-error ids must start with lc', 'mls-cat-invalid-id'));
            }
        });
    }

    if (!findCtlForCsv(file)) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, 'CSV file must have a matching .ctl dependency', 'csv-missing-ctl'));
    }

    if (isUnloadPath(file)) {
        const baseName = path.basename(file);
        if (!/^(?:lc|pd)_[a-z0-9_-]+[_-]SWIFTLEX-\d+\.csv$/i.test(baseName)) {
            issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, 'Unload CSV file name does not follow KNGL naming', 'unload-csv-kngl-naming'));
        }
    }

    return issues;
}

export function performCtlReview(document: ReviewDocument): McmdIssue[] {
    const text = document.getText();
    const file = document.fileName;
    const issues: McmdIssue[] = [];
    const normalized = normalizePath(file);
    const code = maskCode(text, false);
    const script = code.replace(/^[ \t]*#[^\r\n]*|^[ \t]*include\b[^\r\n]*/gmi,
        line => line.replace(/[^\r\n]/g, ' '));
    const firstScript = /\S/.exec(script)?.index ?? 0;
    const direct = script.trim();
    if (direct) {
        issues.push(issueAt(file, text, firstScript, vscode.DiagnosticSeverity.Warning, '.ctl directly contains script; prefer include', 'ctl-direct-script'));
    }

    if (isUnloadPath(file)) {
        const executable = maskCode(text);
        let deleteMatch: RegExpExecArray | null = null;
        for (const open of executable.matchAll(/\[/g)) {
            const end = matching(executable, open.index!, '[', ']');
            if (end < 0) { continue; }
            const sql = code.slice(open.index! + 1, end);
            const deletion = /^\s*delete\s+(?:from\s+)?([a-z0-9_$#]+)\b[\s\S]*?\bwhere\b[\s\S]*?@[a-z0-9_$#]+@/i.exec(sql);
            const catcher = /^\s*catch\s*\(([^)]*)\)/i.exec(executable.slice(end + 1));
            if (deletion && catcher && catcher[1].split(',').some(code => /^(?:-?1403|@\?)$/.test(code.trim()))) { deleteMatch = deletion; break; }
        }
        if (!deleteMatch) {
            issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, 'Unload .ctl must contain a CSV-parameterized DELETE with catch(-1403) or catch(@?)', 'unload-ctl-invalid'));
        } else if (!hasUnloadCsv(file)) {
            issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `Unload .ctl for '${deleteMatch[1]}' must have a sibling directory with at least one CSV`, 'unload-ctl-missing-csv'));
        }
    } else {
        if (direct) {
            const first = firstScript;
            if (!commentBefore(text, first)) {
                issues.push(issueAt(file, text, first, vscode.DiagnosticSeverity.Error, 'Direct .ctl script requires an adjacent comment', 'ctl-direct-script-missing-comment'));
            }
        }
    }

    if (normalized.includes('-config_actions')) {
        const header = triviaSpans(text).filter(span => span.kind === 'comment' && /version|config\s+actions/i.test(span.text)).map(span => span.text).join('\n');
        const versionMatch = /\bv?\s*(\d+)\.(\d+)\.(\d+)/i.exec(header);
        const version = versionMatch ? versionMatch.slice(1).map(Number) : [0, 0, 0];
        const required = [2, 7, 3];
        const difference = version.findIndex((value, i) => value !== required[i]);
        if (difference >= 0 && version[difference] < required[difference]) {
            issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, 'Config Action .ctl version must be 2.7.3 or higher', 'config-action-version'));
        }
    }

    return issues;
}

function hasMloadInvocation(text: string): boolean {
    let quote = '', escaped = false;
    const chars = text.split('');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (escaped) { escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (quote) { if (c === quote) { quote = ''; } continue; }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '#' && (i === 0 || /\s|[;|]/.test(text[i - 1]))) {
            while (i < text.length && text[i] !== '\n') { chars[i++] = ' '; }
        }
    }
    const code = chars.join('');
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const here = /<<-?\s*(['"]?)([a-z_][\w]*)\1/i.exec(lines[i]);
        if (!here) { continue; }
        const executes = /(?:^|[;|]\s*)(?:[^\s;|]*[\\/])?moca\b/i.test(lines[i].trim());
        const delimiter = here[2];
        while (++i < lines.length) {
            const ends = lines[i].trim() === delimiter;
            if (!executes) { lines[i] = lines[i].replace(/[^\r]/g, ' '); }
            if (ends) { break; }
        }
    }
    const executable = maskCode(lines.join('\n'));
    if (/(?:^|[\n;|{])\s*mload_all\b/im.test(executable)) { return true; }
    for (const call of executable.matchAll(/(?:^|[\n;|])\s*(?:[^\s;|]*[\\/])?moca\b/gi)) {
        const start = call.index! + call[0].length;
        const span = triviaSpans(code).find(s => s.kind === 'string' && s.start >= start
            && !code.slice(start, s.start).includes('\n'));
        if (span && /\bmload_all\b/i.test(span.text)) { return true; }
    }
    return false;
}

export function performPostInstallReview(document: ReviewDocument): McmdIssue[] {
    const text = document.getText();
    const file = document.fileName;
    const fileNameLower = path.basename(file).toLowerCase();
    if (!fileNameLower.includes('isccustom')) {
        return [];
    }
    const workspaceRoot = document.workspaceRoot || findProjectRoot(file);
    if (!workspaceRoot || !hasUsedUnloadDirectory(workspaceRoot)) {
        return [];
    }
    if (hasMloadInvocation(text)) {
        return [];
    }
    const dirName = path.basename(path.dirname(file)).toLowerCase();
    try {
        const siblingDir = dirName === 'firstnode'
            ? path.join(path.dirname(file), '..', 'allnodes')
            : path.join(path.dirname(file), '..', 'firstnode');
        if (fs.existsSync(siblingDir)) {
            const shared = fs.readdirSync(siblingDir).some(name => {
                if (!name.toLowerCase().endsWith('.sh')) {
                    return false;
                }
                return hasMloadInvocation(fs.readFileSync(path.join(siblingDir, name), 'utf8'));
            });
            if (shared && fileNameLower.includes('isccustom')) {
                return [];
            }
        }
    } catch {
        // Fall through to the per-script check below.
    }
    return [issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, 'Post-install script must run mload_all for used unload directories', 'postinstall-mload-all-missing')];
}

export function performCsvModuleReview(document: ReviewDocument): McmdIssue[] {
    const extension = path.extname(document.fileName).toLowerCase();
    if (extension === '.csv') {
        return performCsvReview(document);
    }
    if (extension === '.ctl') {
        return performCtlReview(document);
    }
    if (extension === '.sh') {
        return performPostInstallReview(document);
    }
    return [];
}
