import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

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

    const reviewByJiraCommand = vscode.commands.registerCommand(
        'code-reviewer.reviewByJiraTicket',
        async () => {
            const ticket = await vscode.window.showInputBox({
                prompt: 'Enter Jira ticket number (e.g. SWIFTLEX-51198)',
                placeHolder: 'SWIFTLEX-12345',
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Jira ticket number cannot be empty';
                    }
                    return null;
                }
            });

            if (!ticket) {
                return;
            }

            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showErrorMessage('No workspace folder found');
                return;
            }
            const workspaceRoot = workspaceFolders[0].uri.fsPath;

            let changedFiles: string[];
            try {
                changedFiles = await getGitChangedFiles(ticket.trim(), workspaceRoot);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to search git history: ${err.message}`);
                return;
            }

            if (changedFiles.length === 0) {
                vscode.window.showInformationMessage(
                    `No files found in commits for ticket "${ticket.trim()}"`
                );
                return;
            }

            // Separate .mcmd files (full review) from other files (basic review)
            const mcmdFiles = changedFiles.filter(f => f.endsWith('.mcmd'));
            const otherFiles = changedFiles.filter(f => !f.endsWith('.mcmd'));

            diagnosticCollection.clear();
            const allIssues: McmdIssue[] = [];

            for (const relativePath of mcmdFiles) {
                const absolutePath = path.join(workspaceRoot, relativePath);
                try {
                    const document = await vscode.workspace.openTextDocument(absolutePath);
                    const issues = await performMcmdReview(document);
                    allIssues.push(...issues);
                } catch {
                    console.log(`Skipping file (may be deleted): ${absolutePath}`);
                }
            }

            for (const relativePath of otherFiles) {
                const absolutePath = path.join(workspaceRoot, relativePath);
                try {
                    const document = await vscode.workspace.openTextDocument(absolutePath);
                    const issues = await performFileReview(document);
                    allIssues.push(...issues);
                } catch {
                    console.log(`Skipping file (may be deleted): ${absolutePath}`);
                }
            }

            const totalCount = mcmdFiles.length + otherFiles.length;
            if (allIssues.length === 0) {
                vscode.window.showInformationMessage(
                    `No issues found in ${totalCount} file(s) from ticket "${ticket.trim()}".`
                );
            } else {
                showIssuesInProblemsPanel(allIssues);
            }
        }
    );

    context.subscriptions.push(reviewFileCommand, reviewProjectCommand, reviewByJiraCommand);
}

interface McmdIssue {
    file: string;
    line: number;
    column: number;
    severity: vscode.DiagnosticSeverity;
    message: string;
    rule: string;
}

/**
 * Basic file review for source-code files (non-.mcmd). Checks line length, console.log
 * usage, TODO/FIXME hints, and trailing backslashes. Skips data/config files like .csv,
 * .seq, .pof where these rules are not meaningful.
 */
async function performFileReview(document: vscode.TextDocument): Promise<McmdIssue[]> {
    // Only review source-code files; skip data/config/binary files
    const sourceExts = new Set([
        '.js', '.ts', '.jsx', '.tsx', '.java', '.py', '.rb', '.go', '.rs',
        '.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt', '.scala',
        '.xml', '.html', '.css', '.scss', '.less',
        '.json', '.yaml', '.yml', '.toml',
        '.sh', '.bat', '.ps1', '.gradle', '.properties',
        '.sql', '.groovy', '.jsp', '.asp', '.php',
        '.action',          // MOCA web action files (Groovy/Java-like)
        '.md', '.txt',      // documentation
    ]);
    const ext = path.extname(document.fileName).toLowerCase();
    if (!sourceExts.has(ext)) {
        return [];
    }

    const issues: McmdIssue[] = [];
    const fileName = document.fileName;
    const lines = document.getText().split('\n');
    const maxLineLength = 120;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        // Line length check
        if (line.length > maxLineLength) {
            issues.push({
                file: fileName,
                line: lineNumber,
                column: maxLineLength + 1,
                severity: vscode.DiagnosticSeverity.Warning,
                message: `Line exceeds ${maxLineLength} characters (${line.length})`,
                rule: 'line-too-long'
            });
        }

        // console.log check (skip if inside a string literal on the same line)
        if (/\bconsole\.log\s*\(/i.test(line)) {
            issues.push({
                file: fileName,
                line: lineNumber,
                column: line.indexOf('console') + 1,
                severity: vscode.DiagnosticSeverity.Warning,
                message: 'console.log should not be used in production code',
                rule: 'no-console-log'
            });
        }

        // TODO / FIXME hints
        const todoMatch = /\b(TODO|FIXME|HACK)\b/.exec(line);
        if (todoMatch) {
            issues.push({
                file: fileName,
                line: lineNumber,
                column: todoMatch.index + 1,
                severity: vscode.DiagnosticSeverity.Information,
                message: `${todoMatch[1]} comment found: ${line.trim()}`,
                rule: 'todo-comment'
            });
        }

        // Trailing backslash
        if (line.trimEnd().endsWith('\\')) {
            issues.push({
                file: fileName,
                line: lineNumber,
                column: line.length,
                severity: vscode.DiagnosticSeverity.Warning,
                message: 'Line ends with trailing backslash',
                rule: 'trailing-backslash'
            });
        }
    }

    return issues;
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
        const nameMatch = text.match(/<name>([\s\S]*?)<\/name>/i);
        const nameContent = nameMatch ? nameMatch[1].trim() : '';

        issues.push(...checkSelectFromNonView(sqlCode, fileName, linesBeforeSql));
        sqlCode = removeComments(sqlCode);
        // MOCA embeds SQL inside [...] bracket blocks. Anything outside the brackets
        // is MOCA command verbs (e.g. "create receive invoice from master", "process lc
        // inb dto update") and must NOT be treated as SQL. Strip it while preserving line
        // numbers so per-line checks below only see real SQL.
        sqlCode = stripOutsideBrackets(sqlCode);
        const linesBeforeSqlAdjusted = linesBeforeSql;

        issues.push(...checkComplexSql(sqlCode, nameContent, fileName, linesBeforeSqlAdjusted));
        issues.push(...checkInsertUpdateDelete(sqlCode, nameContent, fileName, linesBeforeSqlAdjusted));
        issues.push(...checkInClause(sqlCode, fileName, linesBeforeSqlAdjusted));
        issues.push(...checkSubSelectInSelectClause(sqlCode, fileName, linesBeforeSqlAdjusted));
        issues.push(...checkDivisionWithDecode(sqlCode, fileName, linesBeforeSqlAdjusted));
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

function checkSelectFromNonView(sqlCode: string, file: string, lineOffset: number = 0): McmdIssue[] {
    const issues: McmdIssue[] = [];

    // MOCA embeds SQL inside [...] bracket blocks. The word "from" also appears in
    // MOCA command verbs outside the brackets (e.g. "create receive invoice from master"),
    // which must NOT be treated as a SQL "FROM <table>". Only scan inside bracket blocks.
    const blocks = extractBracketBlocks(sqlCode);

    for (const block of blocks) {
        const blockStartLine = sqlCode.substring(0, block.startIndex).split('\n').length - 1;
        const lines = block.content.split('\n');

        const fromPatternLocal = /\bfrom\s+(\w+)/gi;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNumber = i + 1 + blockStartLine;

            let match;
            while ((match = fromPatternLocal.exec(line)) !== null) {
                const tableName = match[1];
                if (!tableName.toLowerCase().endsWith('_view')) {
                    const codeBeforeFrom = sqlCode.substring(0, block.startIndex + match.index + line.length);
                    if (hasViewCommentInCode(codeBeforeFrom)) {
                        continue;
                    }
                    issues.push({
                        file,
                        line: lineNumber + lineOffset,
                        column: match.index + 1,
                        severity: vscode.DiagnosticSeverity.Warning,
                        message: `SELECT FROM table '${tableName}' that does not end with '_view'. Please add a comment to explain why you are selecting from a non-view table.`,
                        rule: 'select-from-non-view'
                    });
                }
            }
        }
    }

    return issues;
}

interface BracketBlock {
    startIndex: number;  // absolute index in sqlCode of the '['
    content: string;      // text inside the brackets (excluding the brackets themselves)
}

/**
 * Extract all top-level [...] bracket blocks from the code. MOCA uses these to wrap
 * embedded SQL. Nested brackets are not split (the inner brackets are part of the SQL).
 */
function extractBracketBlocks(code: string): BracketBlock[] {
    const blocks: BracketBlock[] = [];
    let i = 0;
    while (i < code.length) {
        const open = code.indexOf('[', i);
        if (open === -1) {
            break;
        }
        // find the matching close bracket (no nested [] splitting; SQL may contain [
        // for things like pckwrk[...], but the outer bracket block is what we want).
        // We scan forward balancing only '[' and ']' that are at the bracket-block level.
        let depth = 1;
        let j = open + 1;
        while (j < code.length && depth > 0) {
            if (code[j] === '[') {
                depth++;
            } else if (code[j] === ']') {
                depth--;
            }
            if (depth === 0) {
                break;
            }
            j++;
        }
        if (depth === 0) {
            blocks.push({
                startIndex: open,
                content: code.substring(open + 1, j)
            });
            i = j + 1;
        } else {
            i = open + 1;
        }
    }
    return blocks;
}

/**
 * Replace all text OUTSIDE [...] bracket blocks with empty lines (preserving newlines
 * and total line count). MOCA embeds SQL only inside the brackets; everything outside is
 * MOCA command verbs and must not be treated as SQL for syntax/usage checks.
 * Brackets themselves are also removed; only the bracket content remains on its line.
 */
function stripOutsideBrackets(code: string): string {
    const result: string[] = [];
    let i = 0;
    const flushOutside = (start: number, end: number) => {
        // Replace the outside-chunk with empty lines, preserving every newline.
        for (let k = start; k < end; k++) {
            if (code[k] === '\n') {
                result.push('\n');
            } else {
                // keep nothing for non-newline chars outside brackets
            }
        }
    };
    while (i < code.length) {
        const open = code.indexOf('[', i);
        if (open === -1) {
            flushOutside(i, code.length);
            break;
        }
        // chars before this '[' are outside a bracket
        flushOutside(i, open);
        // skip the '['
        let depth = 1;
        let j = open + 1;
        while (j < code.length && depth > 0) {
            if (code[j] === '[') {
                depth++;
            } else if (code[j] === ']') {
                depth--;
            }
            if (depth === 0) {
                break;
            }
            j++;
        }
        if (depth === 0) {
            // copy bracket content (between '[' and ']')
            result.push(code.substring(open + 1, j));
            i = j + 1;
        } else {
            // unmatched bracket; treat rest as outside
            flushOutside(open, code.length);
            break;
        }
    }
    return result.join('');
}

function hasViewCommentInCode(code: string): boolean {
    const commentPattern = /\/\*([\s\S]*?)\*\//g;
    let match;
    while ((match = commentPattern.exec(code)) !== null) {
        const commentContent = match[1];
        if (commentContent.toLowerCase().includes('view')) {
            return true;
        }
    }
    return false;
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

/**
 * Search git history on the current branch for commits containing the given ticket number,
 * and return a deduplicated list of changed .mcmd file paths (relative to repo root).
 */
function getGitChangedFiles(ticket: string, workspaceRoot: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const gitCmd = `git log --grep="${ticket}" --name-only --pretty=format:"---FILE---"`;
        exec(gitCmd, { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 }, (error: Error | null, stdout: string, _stderr: string) => {
            if (error) {
                reject(new Error(`Git command failed: ${error.message}`));
                return;
            }
            const files: string[] = [...new Set(
                stdout.split('---FILE---')
                    .flatMap((chunk: string) => chunk.split('\n'))
                    .map((s: string) => s.trim())
                    .filter((s: string) => s.length > 0)
            )];
            resolve(files);
        });
    });
}

export function deactivate() {
    if (diagnosticCollection) {
        diagnosticCollection.clear();
    }
}