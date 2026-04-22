import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Global diagnostic collection for storing and displaying code issues
let diagnosticCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
    console.log('Code Reviewer extension is now active!');

    // Create a diagnostic collection for storing issues
    diagnosticCollection = vscode.languages.createDiagnosticCollection('code-reviewer');
    context.subscriptions.push(diagnosticCollection);

    // Register command for reviewing a single file
    const reviewFileCommand = vscode.commands.registerCommand(
        'code-reviewer.reviewFile',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor found');
                return;
            }

            const document = editor.document;

            // Only process .mcmd files
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

    // Register command for reviewing the entire project
    const reviewProjectCommand = vscode.commands.registerCommand(
        'code-reviewer.reviewProject',
        async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showInformationMessage('No workspace folder found');
                return;
            }

            diagnosticCollection.clear();

            // Find all .mcmd files in the workspace
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

    const localSyntaxMatch = text.match(/<local-syntax>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>/i);
    let sqlCode = '';
    if (localSyntaxMatch) {
        sqlCode = localSyntaxMatch[1];
    }

    const nameMatch = text.match(/<name>([\s\S]*?)<\/name>/i);
    if (nameMatch) {
        const nameContent = nameMatch[1].trim();
        issues.push(...checkNameMatchesFile(nameContent, fileNameNoExt, fileName));
        issues.push(...checkNameContainsLc(nameContent, fileName, sqlCode));
    }

    if (localSyntaxMatch) {
        const cdataStart = text.indexOf('<![CDATA[');
        const linesBeforeSql = text.substring(0, cdataStart).split('\n').length;
        sqlCode = removeComments(sqlCode);

        const nameMatch = text.match(/<name>([\s\S]*?)<\/name>/i);
        const nameContent = nameMatch ? nameMatch[1].trim() : '';

        issues.push(...checkComplexSql(sqlCode, nameContent, fileName, linesBeforeSql));
        issues.push(...checkInsertUpdateDelete(sqlCode, nameContent, fileName, linesBeforeSql));
        issues.push(...checkInClause(sqlCode, fileName, linesBeforeSql));
        issues.push(...checkSubSelectInSelectClause(sqlCode, fileName, linesBeforeSql));
        issues.push(...checkDivisionWithDecode(sqlCode, fileName, linesBeforeSql));
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
        const upperChars = nameContent.match(/[A-Z]/g) || [];
        issues.push({
            file,
            line: 1,
            column: 1,
            severity: vscode.DiagnosticSeverity.Error,
            message: `<name> tag must not contain uppercase characters. Found: ${[...new Set(upperChars)].join(', ')}`,
            rule: 'name-no-uppercase'
        });
    }

    if (/[^a-z0-9\s]/.test(nameContent)) {
        const invalidChars = nameContent.match(/[^a-z0-9\s]/g) || [];
        issues.push({
            file,
            line: 1,
            column: 1,
            severity: vscode.DiagnosticSeverity.Error,
            message: `<name> tag can only contain lowercase letters, numbers and spaces. Found: ${[...new Set(invalidChars)].join(', ')}`,
            rule: 'name-invalid-characters'
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

function checkNameContainsLc(nameContent: string, file: string, sqlCode: string = ''): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const lowerName = nameContent.toLowerCase();
    const hasLc = lowerName.includes('lc');

    if (!hasLc && sqlCode) {
        const trimmedCode = sqlCode.trim();
        const startsWithListPolicies = /^list\s+policies/i.test(trimmedCode);
        const hasIfElse = /\bif\s*\([^)]*\)\s*\{[\s\S]*?\}\s*\belse\s*\{[\s\S]*?\}/i.test(trimmedCode);
        
        if (!startsWithListPolicies || !hasIfElse) {
            issues.push({
                file,
                line: 1,
                column: 1,
                severity: vscode.DiagnosticSeverity.Warning,
                message: `Name '${nameContent}' does not contain 'lc' and does not start with 'list policies' and 'if(...){...}else{...}' structure. This may be an invalid command.`,
                rule: 'missing-lc'
            });
        }
    } else if (!hasLc) {
        const firstSpaceIndex = nameContent.indexOf(' ');
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
    }

    return issues;
}

function checkComplexSql(sqlCode: string, commandName: string, file: string, lineOffset: number = 0): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const lowerName = commandName;
    const isListOrGet = lowerName.startsWith('list ') || lowerName.startsWith('get ');

    const blocks: string[] = [];
    let currentBlock = '';
    let inBracket = false;
    let bracketDepth = 0;
    
    for (let i = 0; i < sqlCode.length; i++) {
        const char = sqlCode[i];
        
        if (!inBracket && char === '[') {
            inBracket = true;
            bracketDepth = 1;
            currentBlock = char;
        } else if (inBracket) {
            currentBlock += char;
            if (char === '[') {
                bracketDepth++;
            } else if (char === ']') {
                bracketDepth--;
                if (bracketDepth === 0) {
                    inBracket = false;
                    blocks.push(currentBlock);
                    currentBlock = '';
                }
            }
        }
    }

    let maxSelectInBlock = 0;
    let totalSelectBlocks = 0;

    for (const block of blocks) {
        if (/\bselect\b/i.test(block)) {
            totalSelectBlocks++;
            const selectMatches = block.match(/\bselect\b/gi) || [];
            const selectCount = selectMatches.length;
            if (selectCount > maxSelectInBlock) {
                maxSelectInBlock = selectCount;
            }
        }
    }

    if (totalSelectBlocks > 2) {
        if (!isListOrGet) {
            issues.push({
                file,
                line: 1,
                column: 1,
                severity: vscode.DiagnosticSeverity.Error,
                message: `Complex SQL (${totalSelectBlocks} SELECT blocks) can only appear in list/get commands`,
                rule: 'complex-sql-select'
            });
        }
    }

    if (maxSelectInBlock > 2) {
        if (!isListOrGet) {
            issues.push({
                file,
                line: 1,
                column: 1,
                severity: vscode.DiagnosticSeverity.Error,
                message: `Complex SQL (${maxSelectInBlock} SELECT statements in one block) can only appear in list/get commands`,
                rule: 'complex-sql-subquery'
            });
        }
    }

    for (const block of blocks) {
        if (/\bselect\b/i.test(block)) {
            const tablePattern = /\bfrom\s+(\w+)/gi;
            const tablesInBlock: string[] = [];
            let match;
            while ((match = tablePattern.exec(block)) !== null) {
                tablesInBlock.push(match[1]);
            }
            const uniqueTablesInBlock = new Set(tablesInBlock);
            
            if (uniqueTablesInBlock.size > 2) {
                if (!isListOrGet) {
                    issues.push({
                        file,
                        line: 1,
                        column: 1,
                        severity: vscode.DiagnosticSeverity.Error,
                        message: `Complex SQL (${uniqueTablesInBlock.size} tables in one block: ${[...uniqueTablesInBlock].join(', ')}) can only appear in list/get commands`,
                        rule: 'complex-sql-tables'
                    });
                }
            }
        }
    }

    return issues;
}

function checkInsertUpdateDelete(sqlCode: string, commandName: string, file: string, lineOffset: number = 0): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const lowerName = commandName.toLowerCase();
    const isListOrGet = lowerName.startsWith('list ') || lowerName.startsWith('get ');

    if (isListOrGet) {
        return issues;
    }

    const lines = sqlCode.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        const lineWithoutStrings = removeStringLiterals(line);

        const insertMatch = /\binsert\s+into\b/i.exec(lineWithoutStrings);
        if (insertMatch) {
            issues.push({
                file,
                line: lineNumber + lineOffset,
                column: line.indexOf('insert') + 1,
                severity: vscode.DiagnosticSeverity.Warning,
                message: `INSERT is used in this command, please note`,
                rule: 'avoid-insert'
            });
        }

        const updateMatch = /\bupdate\b/i.exec(lineWithoutStrings);
        if (updateMatch) {
            issues.push({
                file,
                line: lineNumber + lineOffset,
                column: line.indexOf('update') + 1,
                severity: vscode.DiagnosticSeverity.Warning,
                message: `UPDATE is used in this command, please note`,
                rule: 'avoid-update'
            });
        }

        const deleteMatch = /\bdelete\b/i.exec(lineWithoutStrings);
        if (deleteMatch) {
            issues.push({
                file,
                line: lineNumber + lineOffset,
                column: line.indexOf('delete') + 1,
                severity: vscode.DiagnosticSeverity.Warning,
                message: `DELETE is used in this command, please note`,
                rule: 'avoid-delete'
            });
        }
    }

    return issues;
}

function removeStringLiterals(line: string): string {
    let result = '';
    let i = 0;
    while (i < line.length) {
        const char = line[i];
        if (char === "'" || char === '"') {
            const quote = char;
            i++;
            while (i < line.length && line[i] !== quote) {
                if (line[i] === '\\' && i + 1 < line.length) {
                    i += 2;
                } else {
                    i++;
                }
            }
            i++;
        } else {
            result += char;
            i++;
        }
    }
    return result;
}

function checkInClause(sqlCode: string, file: string, lineOffset: number = 0): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const lines = sqlCode.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        const inPattern = /\bin\s*\(/gi;
        let match;
        while ((match = inPattern.exec(line)) !== null) {
            const inIndex = match.index;
            const inColumn = inIndex + 1;

            const afterParen = line.substring(inIndex + match[0].length).trim();

            const isValueList = /^["']/.test(afterParen);
            const isVariable = /^@/.test(afterParen);

            if (!isValueList && !isVariable) {
                const nextLines = lines.slice(i + 1).join(' ');
                const combinedContent = afterParen + ' ' + nextLines;

                if (/^\s*select\b/i.test(combinedContent)) {
                    issues.push({
                        file,
                        line: lineNumber + lineOffset,
                        column: inColumn,
                        severity: vscode.DiagnosticSeverity.Error,
                        message: 'Use EXISTS instead of IN (subquery) clause',
                        rule: 'no-in-subquery'
                    });
                }
            }
        }
    }

    return issues;
}

function checkSubSelectInSelectClause(sqlCode: string, file: string, lineOffset: number = 0): McmdIssue[] {
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
                    line: lineNumber + lineOffset,
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

function checkDivisionWithDecode(sqlCode: string, file: string, lineOffset: number = 0): McmdIssue[] {
    const issues: McmdIssue[] = [];
    const lines = sqlCode.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        const divisionPattern = /\s\/\s*@?(\w+\.\w+|\w+)/g;
        let match;
        while ((match = divisionPattern.exec(line)) !== null) {
            const divisionText = match[0].trim();
            const divisor = divisionText.substring(1).trim();

            const isConstantDivision = /^\d+\.?\d*$/.test(divisor);
            if (isConstantDivision) {
                continue;
            }

            const beforeDivision = line.substring(0, match.index);
            const divisorWithoutAt = divisor.replace(/^@/, '');

            const hasDecodeProtection = new RegExp(`decode\\s*\\(\\s*@?${divisorWithoutAt}\\s*,\\s*0\\s*,\\s*0\\s*,`, 'i').test(beforeDivision);

            if (!hasDecodeProtection) {
                issues.push({
                    file,
                    line: lineNumber + lineOffset,
                    column: match.index + 1,
                    severity: vscode.DiagnosticSeverity.Warning,
                    message: 'Division by variable should check for zero using DECODE',
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

        const line = Math.max(1, issue.line);
        const column = Math.max(1, issue.column);

        const range = new vscode.Range(
            line - 1,
            column - 1,
            line - 1,
            column
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