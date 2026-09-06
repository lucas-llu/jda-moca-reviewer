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
    return /(?:\/\*[\s\S]*?\*\/|--[^\r\n]*)(?:\s*)$/.test(before);
}

function hasSqlOutsideQuotes(text: string): boolean {
    return /(?:^|[^a-z0-9_])select\s+[^\r\n]*\s+from\b|insert\s+into\b|update\s+[a-z0-9_]+\s+set\b|delete\s+from\b/i.test(text)
        || /\bselect\b[\s\S]{0,120}\bfrom\b/i.test(text);
}

function maskComments(text: string): string {
    const chars = text.split('');
    let index = 0;
    const blank = (start: number, end: number) => {
        for (let i = start; i < end; i++) {
            if (chars[i] !== '\n' && chars[i] !== '\r') {
                chars[i] = ' ';
            }
        }
    };
    while (index < text.length) {
        if (text.startsWith('/*', index)) {
            const end = text.indexOf('*/', index + 2);
            blank(index, end === -1 ? text.length : end + 2);
            index = end === -1 ? text.length : end + 2;
            continue;
        }
        if (text.startsWith('--', index)) {
            const end = text.indexOf('\n', index + 2);
            blank(index, end === -1 ? text.length : end);
            index = end === -1 ? text.length : end;
            continue;
        }
        index++;
    }
    return chars.join('');
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

    if (hasSqlOutsideQuotes(rows.slice(1).join('\n'))) {
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

    if (isUnloadPath(file)) {
        const deleteMatch = /\bdelete\s+([a-z0-9_$#]+)\b[\s\S]*?where\s+[\s\S]*?@([a-z0-9_$#]+)@[\s\S]*?catch\s*\(\s*(?:-?\s*1403|@\?)\s*\)/i.exec(text);
        if (!deleteMatch) {
            issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, 'Unload .ctl must contain a CSV-parameterized DELETE with catch(-1403) or catch(@?)', 'unload-ctl-invalid'));
        } else if (!hasUnloadCsv(file)) {
            issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `Unload .ctl for '${deleteMatch[1]}' must have a sibling directory with at least one CSV`, 'unload-ctl-missing-csv'));
        }
    } else {
        const usesInclude = /\b#?\s*include\b/i.test(text);
        const codeText = maskComments(text);
        if (!usesInclude && hasSqlOutsideQuotes(codeText)) {
            const firstMatch = /\bselect\b|\binsert\s+into\b|\bupdate\b|\bdelete\b|\[/i.exec(codeText);
            issues.push(issueAt(file, text, firstMatch?.index ?? 0, vscode.DiagnosticSeverity.Warning, '.ctl directly contains script; prefer include', 'ctl-direct-script'));
            if (firstMatch && !commentBefore(text, firstMatch.index)) {
                issues.push(issueAt(file, text, firstMatch.index, vscode.DiagnosticSeverity.Error, 'Direct .ctl script requires an adjacent comment', 'ctl-direct-script-missing-comment'));
            }
        }
    }

    if (normalized.includes('-config_actions')) {
        const versionMatch = /\bv?\s*(\d+)\.(\d+)\.(\d+)/i.exec(text);
        const version = versionMatch ? Number(versionMatch[1]) * 10000 + Number(versionMatch[2]) * 100 + Number(versionMatch[3]) : 0;
        if (version < 20703) {
            issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, 'Config Action .ctl version must be 2.7.3 or higher', 'config-action-version'));
        }
    }

    return issues;
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
    if (/\bmload_all\b/i.test(text)) {
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
                return /\bmload_all\b/i.test(fs.readFileSync(path.join(siblingDir, name), 'utf8'));
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
