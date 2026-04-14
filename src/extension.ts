import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('Code Reviewer extension is now active!');

    const reviewFileCommand = vscode.commands.registerCommand(
        'code-reviewer.reviewFile',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor found');
                return;
            }

            const document = editor.document;
            const issues = await performCodeReview(document);

            if (issues.length === 0) {
                vscode.window.showInformationMessage('No issues found in the code!');
            } else {
                showIssuesInProblemsPanel(issues);
            }
        }
    );

    const reviewProjectCommand = vscode.commands.registerCommand(
        'code-reviewer.reviewProject',
        async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showInformationMessage('No workspace folder found');
                return;
            }

            const files = await vscode.workspace.findFiles('**/*.{ts,js,json,md}');
            const allIssues: CodeIssue[] = [];

            for (const file of files) {
                const document = await vscode.workspace.openTextDocument(file);
                const issues = await performCodeReview(document);
                allIssues.push(...issues);
            }

            if (allIssues.length === 0) {
                vscode.window.showInformationMessage('No issues found in the project!');
            } else {
                showIssuesInProblemsPanel(allIssues);
            }
        }
    );

    context.subscriptions.push(reviewFileCommand, reviewProjectCommand);
}

interface CodeIssue {
    file: string;
    line: number;
    column: number;
    severity: vscode.DiagnosticSeverity;
    message: string;
    rule: string;
}

async function performCodeReview(document: vscode.TextDocument): Promise<CodeIssue[]> {
    const issues: CodeIssue[] = [];
    const text = document.getText();
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.length > 120) {
            issues.push({
                file: document.fileName,
                line: i + 1,
                column: 1,
                severity: vscode.DiagnosticSeverity.Warning,
                message: `Line too long (${line.length} > 120 characters)`,
                rule: 'max-line-length'
            });
        }

        if (line.trim().endsWith('\\')) {
            issues.push({
                file: document.fileName,
                line: i + 1,
                column: line.indexOf('\\') + 1,
                severity: vscode.DiagnosticSeverity.Warning,
                message: 'Avoid using trailing backslashes for line continuation',
                rule: 'no-trailing-backslash'
            });
        }

        const consoleLogMatch = line.match(/console\.(log|debug|info)/);
        if (consoleLogMatch) {
            issues.push({
                file: document.fileName,
                line: i + 1,
                column: line.indexOf(consoleLogMatch[0]) + 1,
                severity: vscode.DiagnosticSeverity.Information,
                message: `Avoid using ${consoleLogMatch[0]} in production code`,
                rule: 'no-console'
            });
        }

        if (line.includes('TODO') || line.includes('FIXME')) {
            issues.push({
                file: document.fileName,
                line: i + 1,
                column: line.indexOf('TODO') + 1 || line.indexOf('FIXME') + 1,
                severity: vscode.DiagnosticSeverity.Hint,
                message: 'Found TODO/FIXME comment',
                rule: 'todo-comment'
            });
        }
    }

    return issues;
}

function showIssuesInProblemsPanel(issues: CodeIssue[]): void {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('code-reviewer');

    const issuesByFile = new Map<string, vscode.Diagnostic[]>();

    for (const issue of issues) {
        if (!issuesByFile.has(issue.file)) {
            issuesByFile.set(issue.file, []);
        }

        const range = new vscode.Range(
            issue.line - 1,
            issue.column - 1,
            issue.line - 1,
            issue.column
        );

        const diagnostic = new vscode.Diagnostic(range, issue.message, issue.severity);
        diagnostic.code = issue.rule;
        issuesByFile.get(issue.file)!.push(diagnostic);
    }

    for (const [file, diagnostics] of issuesByFile) {
        const uri = vscode.Uri.file(file);
        diagnosticCollection.set(uri, diagnostics);
    }

    vscode.window.showInformationMessage(`Found ${issues.length} issues in the code. Check the Problems panel.`);
}

export function deactivate() {}