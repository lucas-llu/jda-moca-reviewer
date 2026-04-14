import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let diagnosticCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
    console.log('Code Reviewer extension is now active!');

    diagnosticCollection = vscode.languages.createDiagnosticCollection('code-reviewer');
    context.subscriptions.push(diagnosticCollection);

    const reviewFileCommand = vscode.commands.registerCommand(
        'code-reviewer.reviewFile',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor found');
                return;
            }

            const document = editor.document;

            if (!document.fileName.endsWith('.mcmd')) {
                vscode.window.showInformationMessage('This extension only reviews .mcmd files');
                return;
            }

            diagnosticCollection.clear();

            const issues = await performMcmdReview(document);

            if (issues.length === 0) {
                vscode.window.showInformationMessage('No issues found in the .mcmd file!');
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

            diagnosticCollection.clear();

            const files = await vscode.workspace.findFiles('**/*.mcmd');
            const allIssues: McmdIssue[] = [];

            for (const file of files) {
                const document = await vscode.workspace.openTextDocument(file);
                const issues = await performMcmdReview(document);
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

interface McmdIssue {
    file: string;
    line: number;
    column: number;
    severity: vscode.DiagnosticSeverity;
    message: string;
    rule: string;
}

async function performMcmdReview(document: vscode.TextDocument): Promise<McmdIssue[]> {
    const issues: McmdIssue[] = [];
    const text = document.getText();
    const fileName = document.fileName;
    const baseName = fileName.split(/[/\\]/).pop() || '';
    const fileNameNoExt = baseName.replace('.mcmd', '');

    issues.push(...checkFileStructure(text, fileName));

    const nameMatch = text.match(/<name>([\s\S]*?)<\/name>/i);
    if (nameMatch) {
        const nameContent = nameMatch[1].trim();
        issues.push(...checkNameMatchesFile(nameContent, fileNameNoExt, fileName));
        issues.push(...checkNameContainsLc(nameContent, fileName));
    }

    const localSyntaxMatch = text.match(/<local-syntax>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>/i);
    if (localSyntaxMatch) {
        let sqlCode = localSyntaxMatch[1];
        sqlCode = removeComments(sqlCode);

        const nameMatch = text.match(/<name>([\s\S]*?)<\/name>/i);
        const nameContent = nameMatch ? nameMatch[1].trim() : '';

        issues.push(...checkComplexSql(sqlCode, nameContent, fileName));
        issues.push(...checkInsertUpdateDelete(sqlCode, nameContent, fileName));
        issues.push(...checkInClause(sqlCode, fileName));
        issues.push(...checkSubSelectInSelectClause(sqlCode, fileName));
        issues.push(...checkDivisionWithDecode(sqlCode, fileName));
        issues.push(...checkListGetNoDml(sqlCode, nameContent, fileName));
    }

    return issues;
}

function removeComments(code: string): string {
    let result = code;
    result = result.replace(/\/\*[\s\S]*?\*\//g, '');
    result = result.replace(/--.*$/gm, '');
    return result;
}

function checkNameNoUpperCase(nameContent: string, file: string): McmdIssue[] {
    const issues: McmdIssue[] = [];

    if (/[A-Z]/.test(nameContent)) {
        const upperChars = nameMatch[1].match(/[A-Z]/g) || [];
        issues.push({
            file,
            line: 1,
            column: 1,
            severity: vscode.DiagnosticSeverity.Error,
            message: `<name> tag must not contain uppercase characters. Found: ${[...new Set(upperChars)].join(', ')}`,
            rule: 'name-no-uppercase'
        });
    }

    if (nameContent.includes('  ')) {
        issues.push({
            file,
            line: 1,
            column: 1,
            severity: vscode.DiagnosticSeverity.Error,
            message: `<name> tag must not have multiple consecutive spaces. Only one space between words`,
            rule: 'name-multiple-spaces'
        });
    }

    return issues;
}

function getActualFileName(fullPath: string): string {
    const baseName = path.basename(fullPath);
    try {
        const dirPath = path.dirname(fullPath);
        const files = fs.readdirSync(dirPath);
        const actualFile = files.find(f => f.toLowerCase() === baseName.toLowerCase());
        return actualFile || baseName;
    } catch {
        return baseName;
    }
}

function checkFileNameNoUpperCase(fullPath: string): McmdIssue[] {
    const issues: McmdIssue[] = [];

    const actualFileName = getActualFileName(fullPath);

    for (let i = 0; i < actualFileName.length; i++) {
        const char = actualFileName[i];
        if (char >= 'A' && char <= 'Z') {
            issues.push({
                file: fullPath,
                line: 1,
                column: 1,
                severity: vscode.DiagnosticSeverity.Error,
                message: `File name must not contain uppercase characters. Found: '${char}'`,
                rule: 'filename-no-uppercase'
            });
            break;
        }
    }

    if (actualFileName.includes(' ')) {
        issues.push({
            file: fullPath,
            line: 1,
            column: 1,
            severity: vscode.DiagnosticSeverity.Error,
            message: `File name must not contain spaces. Use underscore '_' instead`,
            rule: 'filename-no-space'
        });
    }

    return issues;
}

function checkFileStructure(text: string, file: string): McmdIssue[] {
    const issues: McmdIssue[] = [];

    const nameMatch = text.match(/<name>([\s\S]*?)<\/name>/i);
    if (!nameMatch) {
        issues.push({
            file,
            line: 1,
            column: 1,
            severity: vscode.DiagnosticSeverity.Error,
            message: 'Missing <name> tag in .mcmd file',
            rule: 'missing-name'
        });
    } else {
        issues.push(...checkNameNoUpperCase(nameMatch[1], file));
    }

    issues.push(...checkFileNameNoUpperCase(file));

    const descriptionMatch = text.match(/<description>([\s\S]*?)<\/description>/i);
    if (!descriptionMatch) {
        issues.push({
            file,
            line: 1,
            column: 1,
            severity: vscode.DiagnosticSeverity.Error,
            message: 'Missing <description> tag in .mcmd file',
            rule: 'missing-description'
        });
    }

    const typeMatch = text.match(/<type>([\s\S]*?)<\/type>/i);
    if (!typeMatch) {
        issues.push({
            file,
            line: 1,
            column: 1,
            severity: vscode.DiagnosticSeverity.Error,
            message: 'Missing <type> tag in .mcmd file',
            rule: 'missing-type'
        });
    }

    const typeMatch = text.match(/<type>([\s\S]*?)<\/type>/i);
    const isJavaMethod = typeMatch && typeMatch[1].trim().toLowerCase() === 'java method';

    const localSyntaxMatch = text.match(/<local-syntax>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>/i);
    if (!localSyntaxMatch && !isJavaMethod) {
        issues.push({
            file,
            line: 1,
            column: 1,
            severity: vscode.DiagnosticSeverity.Error,
            message: 'Missing <local-syntax> tag or CDATA in .mcmd file',
            rule: 'missing-local-syntax'
        });
    }

    return issues;
}

function checkNameMatchesFile(nameContent: string, fileNameNoExt: string, file: string): McmdIssue[] {
    const issues: McmdIssue[] = [];

    const nameWithUnderscore = nameContent.replace(/\s+/g, '_');

    if (nameWithUnderscore !== fileNameNoExt) {
        issues.push({
            file,
            line: 1,
            column: 1,
            severity: vscode.DiagnosticSeverity.Warning,
            message: `Name '${nameContent}' does not match filename '${fileNameNoExt}'`,
            rule: 'name-mismatch'
        });
    }

    return issues;
}

function checkNameContainsLc(nameContent: string, file: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const lowerName = nameContent;

    const firstSpaceIndex = lowerName.indexOf(' ');
    if (firstSpaceIndex > 0 && firstSpaceIndex < nameContent.length - 1) {
        const afterFirstSpace = nameContent.substring(firstSpaceIndex + 1);
        if (!afterFirstSpace.includes('lc ')) {
            issues.push({
                file,
                line: 1,
                column: 1,
                severity: vscode.DiagnosticSeverity.Warning,
                message: `Name '${nameContent}' may be missing 'lc' prefix after first word. Please verify.`,
                rule: 'missing-lc'
            });
        }
    }

    return issues;
}

function checkComplexSql(sqlCode: string, commandName: string, file: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const lowerName = commandName;
    const isListOrGet = lowerName.startsWith('list ') || lowerName.startsWith('get ');

    const selectCount = (sqlCode.match(/\bselect\b/gi) || []).length;
    if (selectCount > 2) {
        if (!isListOrGet) {
            issues.push({
                file,
                line: 1,
                column: 1,
                severity: vscode.DiagnosticSeverity.Error,
                message: `Complex SQL (${selectCount} SELECT statements) can only appear in list/get commands`,
                rule: 'complex-sql-select'
            });
        }
    }

    const joinCount = (sqlCode.match(/\bjoin\b/gi) || []).length;
    const unionCount = (sqlCode.match(/\bunion\s+all\b|\bunion\b/gi) || []).length;
    if (joinCount > 2 || unionCount > 2) {
        if (!isListOrGet) {
            issues.push({
                file,
                line: 1,
                column: 1,
                severity: vscode.DiagnosticSeverity.Error,
                message: `Complex SQL (${joinCount} JOINs, ${unionCount} UNIONs) can only appear in list/get commands`,
                rule: 'complex-sql-join-union'
            });
        }
    }

    const subqueryCount = (sqlCode.match(/\(select\s+/gi) || []).length;
    if (subqueryCount > 2) {
        if (!isListOrGet) {
            issues.push({
                file,
                line: 1,
                column: 1,
                severity: vscode.DiagnosticSeverity.Error,
                message: `Complex SQL (${subqueryCount} subqueries) can only appear in list/get commands`,
                rule: 'complex-sql-subquery'
            });
        }
    }

    const tablePattern = /\bfrom\s+(\w+)/gi;
    const tables: string[] = [];
    let match;
    while ((match = tablePattern.exec(sqlCode)) !== null) {
        tables.push(match[1]);
    }
    const uniqueTables = new Set(tables);
    if (uniqueTables.size > 2) {
        if (!isListOrGet) {
            issues.push({
                file,
                line: 1,
                column: 1,
                severity: vscode.DiagnosticSeverity.Error,
                message: `Complex SQL (${uniqueTables.size} tables: ${[...uniqueTables].join(', ')}) can only appear in list/get commands`,
                rule: 'complex-sql-tables'
            });
        }
    }

    return issues;
}

function checkInsertUpdateDelete(sqlCode: string, commandName: string, file: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const lines = sqlCode.split('\n');

    const insertPattern = /\binsert\s+into\b/i;
    const updatePattern = /\bupdate\s+\w+\s+set\b/i;
    const deletePattern = /\bdelete\s+from\b/i;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        if (insertPattern.test(line)) {
            issues.push({
                file,
                line: lineNumber,
                column: line.indexOf('insert') + 1,
                severity: vscode.DiagnosticSeverity.Warning,
                message: `Avoid using INSERT in command '${commandName}'`,
                rule: 'avoid-insert'
            });
        }

        if (updatePattern.test(line)) {
            issues.push({
                file,
                line: lineNumber,
                column: line.indexOf('update') + 1,
                severity: vscode.DiagnosticSeverity.Warning,
                message: `Avoid using UPDATE in command '${commandName}'`,
                rule: 'avoid-update'
            });
        }

        if (deletePattern.test(line)) {
            issues.push({
                file,
                line: lineNumber,
                column: line.indexOf('delete') + 1,
                severity: vscode.DiagnosticSeverity.Warning,
                message: `Avoid using DELETE in command '${commandName}'`,
                rule: 'avoid-delete'
            });
        }
    }

    return issues;
}

function checkInClause(sqlCode: string, file: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const lines = sqlCode.split('\n');

    const inWithSelectPattern = /\bin\s*\(\s*select\b/gi;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        let match;
        while ((match = inWithSelectPattern.exec(line)) !== null) {
            issues.push({
                file,
                line: lineNumber,
                column: match.index + 1,
                severity: vscode.DiagnosticSeverity.Error,
                message: 'Use EXISTS instead of IN (subquery) clause',
                rule: 'no-in-subquery'
            });
        }
    }

    return issues;
}

function checkSubSelectInSelectClause(sqlCode: string, file: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const lines = sqlCode.split('\n');

    const selectClausePattern = /select\s+([\s\S]*?)\s+from/i;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        const match = line.match(selectClausePattern);
        if (match && match[1]) {
            const selectClause = match[1];
            if (/\(select\s+/i.test(selectClause)) {
                issues.push({
                    file,
                    line: lineNumber,
                    column: 1,
                    severity: vscode.DiagnosticSeverity.Error,
                    message: 'Sub-select is not allowed in SELECT clause',
                    rule: 'no-sub-select-in-select'
                });
            }
        }
    }

    return issues;
}

function checkDivisionWithDecode(sqlCode: string, file: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const lines = sqlCode.split('\n');

    const divisionPattern = /\/\s*(@?\w+|\d+)/g;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        const hasDivision = divisionPattern.test(line);
        if (hasDivision) {
            if (!/decode\s*\(/i.test(line)) {
                issues.push({
                    file,
                    line: lineNumber,
                    column: line.indexOf('/') + 1,
                    severity: vscode.DiagnosticSeverity.Warning,
                    message: 'Division operation should use DECODE function to handle divide by zero',
                    rule: 'division-decode'
                });
            }
        }
    }

    return issues;
}

function checkListGetNoDml(sqlCode: string, commandName: string, file: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const lowerName = commandName;
    const isListOrGet = lowerName.startsWith('list ') || lowerName.startsWith('get ');

    if (isListOrGet) {
        const lines = sqlCode.split('\n');

        const insertPattern = /\binsert\s+into\b/i;
        const updatePattern = /\bupdate\s+\w+\s+set\b/i;
        const deletePattern = /\bdelete\s+from\b/i;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNumber = i + 1;

            if (insertPattern.test(line)) {
                issues.push({
                    file,
                    line: lineNumber,
                    column: line.indexOf('insert') + 1,
                    severity: vscode.DiagnosticSeverity.Error,
                    message: `INSERT is not allowed in list/get command '${commandName}'`,
                    rule: 'list-get-no-insert'
                });
            }

            if (updatePattern.test(line)) {
                issues.push({
                    file,
                    line: lineNumber,
                    column: line.indexOf('update') + 1,
                    severity: vscode.DiagnosticSeverity.Error,
                    message: `UPDATE is not allowed in list/get command '${commandName}'`,
                    rule: 'list-get-no-update'
                });
            }

            if (deletePattern.test(line)) {
                issues.push({
                    file,
                    line: lineNumber,
                    column: line.indexOf('delete') + 1,
                    severity: vscode.DiagnosticSeverity.Error,
                    message: `DELETE is not allowed in list/get command '${commandName}'`,
                    rule: 'list-get-no-delete'
                });
            }
        }
    }

    return issues;
}

function showIssuesInProblemsPanel(issues: McmdIssue[]): void {
    diagnosticCollection.clear();

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

    vscode.window.showInformationMessage(`Found ${issues.length} issues in .mcmd files. Check the Problems panel.`);
}

export function deactivate() {
    if (diagnosticCollection) {
        diagnosticCollection.clear();
    }
}