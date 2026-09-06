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

export function performLabelReview(document: ReviewDocument): McmdIssue[] {
    const text = document.getText();
    const file = document.fileName;
    const baseName = path.basename(file, path.extname(file));
    const issues: McmdIssue[] = [];
    if ([...baseName].length > 20) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `Label file name '${baseName}' exceeds 20 characters`, 'label-filename-too-long'));
    }
    const rptIdMatch = /\brpt_id\b\s*[=:]\s*["']?([^"'^\r\n]+)/i.exec(text);
    if (rptIdMatch && !/^\^[^^]*\^$/.test(rptIdMatch[1]) && rptIdMatch[1].trim() !== baseName) {
        issues.push(issueAt(file, text, rptIdMatch.index, vscode.DiagnosticSeverity.Error, `rpt_id '${rptIdMatch[1]}' does not match label file name '${baseName}'`, 'rpt-id-mismatch'));
    }
    return issues;
}

export function performJrxmlReview(document: ReviewDocument): McmdIssue[] {
    const text = document.getText();
    const file = document.fileName;
    const baseName = path.basename(file, path.extname(file));
    const issues: McmdIssue[] = [];
    if ([...baseName].length > 30) {
        issues.push(issueAt(file, text, 0, vscode.DiagnosticSeverity.Error, `Report file name '${baseName}' exceeds 30 characters`, 'report-filename-too-long'));
    }
    const rptIdMatch = /\bname\s*=\s*"rpt_id"[\s\S]{0,160}?value\s*=\s*"([^"]+)"/i.exec(text)
        || /\brpt_id\b\s*[=:]\s*["']?([a-z0-9_-]+)/i.exec(text);
    if (rptIdMatch && !/^\^[^^]*\^$/.test(rptIdMatch[1]) && rptIdMatch[1] !== baseName) {
        issues.push(issueAt(file, text, rptIdMatch.index, vscode.DiagnosticSeverity.Error, `rpt_id '${rptIdMatch[1]}' does not match report file name '${baseName}'`, 'rpt-id-mismatch'));
    }
    return issues;
}

export function performReportModuleReview(document: ReviewDocument): McmdIssue[] {
    const extension = path.extname(document.fileName).toLowerCase();
    if (extension === '.pof') {
        return performLabelReview(document);
    }
    if (extension === '.jrxml') {
        return performJrxmlReview(document);
    }
    return [];
}
