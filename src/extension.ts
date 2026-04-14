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

            if (!document.fileName.endsWith('.mcmd')) {
                vscode.window.showInformationMessage('This extension only reviews .mcmd files');
                return;
            }

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
    const commandName = baseName.replace('.mcmd', '');

    issues.push(...checkFileStructure(text, fileName));

    const nameMatch = text.match(/<name>([\s\S]*?)<\/name>/i);
    if (nameMatch) {
        const nameContent = nameMatch[1].trim();

        issues.push(...checkNameMatchesFile(nameContent, commandName, fileName));

        issues.push(...checkNameContainsLc(nameContent, fileName));
    }

    const localSyntaxMatch = text.match(/<local-syntax>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>/i);
    if (localSyntaxMatch) {
        const sqlCode = localSyntaxMatch[1];

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
    }

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

    const localSyntaxMatch = text.match(/<local-syntax>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>/i);
    if (!localSyntaxMatch) {
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

function checkNameMatchesFile(nameContent: string, fileName: string, file: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const expectedName = nameContent.toLowerCase().replace(/\s+/g, '_');

    if (fileName.toLowerCase() !== expectedName) {
        issues.push({
            file,
            line: 1,
            column: 1,
            severity: vscode.DiagnosticSeverity.Warning,
            message: `Name '${nameContent}' does not match filename. Expected: '${nameContent.replace(/\s+/g, '_')}'`,
            rule: 'name-mismatch'
        });
    }

    return issues;
}

function checkNameContainsLc(nameContent: string, file: string): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const lowerName = nameContent.toLowerCase();

    const firstSpaceIndex = lowerName.indexOf(' ');
    if (firstSpaceIndex > 0 && firstSpaceIndex < lowerName.length - 1) {
        const afterFirstSpace = lowerName.substring(firstSpaceIndex + 1);
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
    const lowerName = commandName.toLowerCase();
    const isListOrGet = lowerName.startsWith('list ') || lowerName.startsWith('get ');

    const selectCount = (sqlCode.match(/\bselect\b/gi) || []).length;
    if (selectCount > 1) {
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
        tables.push(match[1].toLowerCase());
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

    const inPattern = /\bin\s*\(/gi;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        let match;
        while ((match = inPattern.exec(line)) !== null) {
            issues.push({
                file,
                line: lineNumber,
                column: match.index + 1,
                severity: vscode.DiagnosticSeverity.Error,
                message: 'Use EXISTS instead of IN clause',
                rule: 'no-in-clause'
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
    const lowerName = commandName.toLowerCase();
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

    vscode.window.showInformationMessage(`Found ${issues.length} issues in .mcmd files. Check the Problems panel.`);
}

export function deactivate() {}