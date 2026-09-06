import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import {
    McmdIssue,
    REVIEW_EXCLUDE_GLOB,
    REVIEW_INCLUDE_GLOBS,
    checkFileNameNoUpperCase,
    checkFileStructure,
    checkJrxmlMocaConnection,
    checkNameMatchesFile,
    checkNameNoUpperCase,
    getReviewKind,
    isReviewableFile,
    performMcmdReview,
    reviewDocument,
    validateGitBranchName
} from './reviewer';
import { performDatabaseReview } from './rules/database';
import { performCsvModuleReview } from './rules/csv';
import { performReportModuleReview } from './rules/report';

let diagnosticCollection: vscode.DiagnosticCollection;

function workspaceRootFor(document?: vscode.TextDocument): string | undefined {
    if (document) {
        const folder = vscode.workspace.getWorkspaceFolder?.(document.uri);
        if (folder) {
            return folder.uri.fsPath;
        }
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function ensureValidBranch(workspaceRoot: string): Promise<boolean> {
    try {
        const branchName = await getGitBranchName(workspaceRoot);
        const issues = validateGitBranchName(branchName);
        if (issues.length > 0) {
            showIssuesInProblemsPanel(issues);
            return false;
        }
    } catch {
        // Branch behavior for non-Git/detached workspaces is deferred in the PRD.
    }
    return true;
}

async function findReviewableFiles(): Promise<vscode.Uri[]> {
    const groups = await Promise.all(
        REVIEW_INCLUDE_GLOBS.map(glob => vscode.workspace.findFiles(glob, REVIEW_EXCLUDE_GLOB))
    );
    const unique = new Map<string, vscode.Uri>();
    for (const uri of groups.flat()) {
        if (isReviewableFile(uri.fsPath)) {
            unique.set(uri.fsPath.toLowerCase(), uri);
        }
    }
    return [...unique.values()];
}

async function reviewFiles(files: readonly vscode.Uri[]): Promise<McmdIssue[]> {
    const allIssues: McmdIssue[] = [];
    for (const file of files) {
        try {
            const document = await vscode.workspace.openTextDocument(file);
            allIssues.push(...reviewDocument(document));
        } catch {
            console.log(`Skipping file (may be deleted or unavailable): ${file.fsPath}`);
        }
    }
    return allIssues;
}

export function activate(context: vscode.ExtensionContext): void {
    console.log('Code Reviewer extension is now active!');
    diagnosticCollection = vscode.languages.createDiagnosticCollection('code-reviewer');
    context.subscriptions.push(diagnosticCollection);

    const reviewFileCommand = vscode.commands.registerCommand('code-reviewer.reviewFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active editor found');
            return;
        }
        const document = editor.document;
        const kind = getReviewKind(document.fileName);
        if (!kind) {
            vscode.window.showInformationMessage('This file type or path is not in the Code Reviewer scope');
            return;
        }

        diagnosticCollection.clear();
        const workspaceRoot = workspaceRootFor(document);
        if (workspaceRoot && !(await ensureValidBranch(workspaceRoot))) {
            return;
        }
        const issues = reviewDocument(document);
        if (issues.length === 0) {
            vscode.window.showInformationMessage(`No issues found in the ${kind} file!`);
        } else {
            showIssuesInProblemsPanel(issues);
        }
    });

    const reviewProjectCommand = vscode.commands.registerCommand('code-reviewer.reviewProject', async () => {
        const workspaceRoot = workspaceRootFor();
        if (!workspaceRoot) {
            vscode.window.showInformationMessage('No workspace folder found');
            return;
        }
        diagnosticCollection.clear();
        if (!(await ensureValidBranch(workspaceRoot))) {
            return;
        }
        const files = await findReviewableFiles();
        const issues = await reviewFiles(files);
        if (issues.length === 0) {
            vscode.window.showInformationMessage(`No issues found in ${files.length} reviewable project files!`);
        } else {
            showIssuesInProblemsPanel(issues);
        }
    });

    const reviewByJiraCommand = vscode.commands.registerCommand('code-reviewer.reviewByJiraTicket', async () => {
        const ticket = await vscode.window.showInputBox({
            prompt: 'Enter Jira ticket number (e.g. SWIFTLEX-51198)',
            placeHolder: 'SWIFTLEX-12345',
            validateInput: value => value.trim().length === 0 ? 'Jira ticket number cannot be empty' : null
        });
        if (!ticket) {
            return;
        }
        const workspaceRoot = workspaceRootFor();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }
        diagnosticCollection.clear();
        if (!(await ensureValidBranch(workspaceRoot))) {
            return;
        }

        let changedFiles: string[];
        try {
            changedFiles = await getGitChangedFiles(ticket.trim(), workspaceRoot);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to search git history: ${message}`);
            return;
        }

        const reviewableFiles = changedFiles
            .filter(isReviewableFile)
            .map(relativePath => vscode.Uri.file(path.join(workspaceRoot, relativePath)));
        if (reviewableFiles.length === 0) {
            vscode.window.showInformationMessage(`No reviewable files found for ticket '${ticket.trim()}'`);
            return;
        }
        const issues = await reviewFiles(reviewableFiles);
        if (issues.length === 0) {
            vscode.window.showInformationMessage(`No issues found in ${reviewableFiles.length} files for ticket '${ticket.trim()}'`);
        } else {
            showIssuesInProblemsPanel(issues);
        }
    });

    const reviewJrxmlCommand = vscode.commands.registerCommand('code-reviewer.reviewJrxml', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || getReviewKind(editor.document.fileName) !== 'jrxml') {
            vscode.window.showInformationMessage('This command only reviews .jrxml files');
            return;
        }
        diagnosticCollection.clear();
        const workspaceRoot = workspaceRootFor(editor.document);
        if (workspaceRoot && !(await ensureValidBranch(workspaceRoot))) {
            return;
        }
        const issues = reviewDocument(editor.document);
        if (issues.length === 0) {
            vscode.window.showInformationMessage('No issues found in the .jrxml file!');
        } else {
            showIssuesInProblemsPanel(issues);
        }
    });

    context.subscriptions.push(reviewFileCommand, reviewProjectCommand, reviewByJiraCommand, reviewJrxmlCommand);
}

export function showIssuesInProblemsPanel(issues: McmdIssue[]): void {
    diagnosticCollection.clear();
    const issuesByFile = new Map<string, vscode.Diagnostic[]>();
    for (const issue of issues) {
        const fileKey = issue.file || '(workspace)';
        const line = Math.max(1, issue.line);
        const column = Math.max(1, issue.column);
        const range = new vscode.Range(line - 1, column - 1, line - 1, column);
        const diagnostic = new vscode.Diagnostic(range, issue.message, issue.severity);
        diagnostic.code = issue.rule;
        const diagnostics = issuesByFile.get(fileKey) || [];
        diagnostics.push(diagnostic);
        issuesByFile.set(fileKey, diagnostics);
    }
    for (const [file, diagnostics] of issuesByFile) {
        if (file === '(workspace)') {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder) {
                diagnosticCollection.set(workspaceFolder.uri, diagnostics);
            }
        } else {
            diagnosticCollection.set(vscode.Uri.file(file), diagnostics);
        }
    }
    vscode.window.showInformationMessage(`Found ${issues.length} code review issue(s). Check the Problems panel.`);
}

export function getGitBranchName(workspaceRoot: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspaceRoot }, (error, stdout) => {
            if (error) {
                reject(new Error(`Git command failed: ${error.message}`));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

export function parseGitChangedFilesOutput(stdout: string): string[] {
    return [...new Set(
        stdout.split('---FILE---')
            .flatMap(chunk => chunk.split(/\r?\n/))
            .map(file => file.trim())
            .filter(Boolean)
    )];
}

function runGitOutput(args: string[], workspaceRoot: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            'git',
            args,
            { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 },
            (error, stdout) => {
                if (error) {
                    reject(new Error(`Git command failed: ${error.message}`));
                    return;
                }
                resolve(stdout);
            }
        );
    });
}

function parseGitStatusPaths(stdout: string): string[] {
    const paths: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        const raw = line.length > 3 ? line.substring(3).trim() : '';
        if (!raw) {
            continue;
        }
        const renameIndex = raw.indexOf(' -> ');
        const target = renameIndex === -1 ? raw : raw.slice(renameIndex + 4).trim();
        if (target) {
            paths.push(target);
        }
    }
    return paths;
}

export async function getGitChangedFiles(ticket: string, workspaceRoot: string): Promise<string[]> {
    const [logOutput, statusOutput] = await Promise.all([
        runGitOutput([
            'log',
            '--fixed-strings',
            `--grep=${ticket}`,
            '--name-only',
            '--no-renames',
            '--pretty=format:---FILE---'
        ], workspaceRoot),
        runGitOutput(['status', '--porcelain', '--untracked-files=all'], workspaceRoot)
    ]);
    const files = new Set<string>();
    for (const relativePath of parseGitChangedFilesOutput(logOutput)) {
        if (fs.existsSync(path.join(workspaceRoot, relativePath))) {
            files.add(relativePath);
        }
    }
    for (const relativePath of parseGitStatusPaths(statusOutput)) {
        if (fs.existsSync(path.join(workspaceRoot, relativePath))) {
            files.add(relativePath);
        }
    }
    return [...files];
}

export const __test = {
    checkFileStructure,
    checkNameNoUpperCase,
    checkFileNameNoUpperCase,
    checkNameMatchesFile,
    validateGitBranchName,
    checkJrxmlMocaConnection,
    performMcmdReview,
    reviewDocument,
    performDatabaseReview,
    performCsvModuleReview,
    performReportModuleReview,
    getReviewKind,
    isReviewableFile,
    parseGitChangedFilesOutput,
    parseGitStatusPaths,
    getGitChangedFiles,
    findReviewableFiles,
    showIssuesInProblemsPanel
};

export function deactivate(): void {
    diagnosticCollection?.clear();
}
