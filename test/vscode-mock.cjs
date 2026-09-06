'use strict';

const Module = require('node:module');

const state = {
    commands: [],
    collections: [],
    messages: []
};

class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
    }
}

class Diagnostic {
    constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
        this.code = undefined;
    }
}

function createDiagnosticCollection(name) {
    const entries = new Map();
    const collection = {
        name,
        entries,
        clear() {
            entries.clear();
        },
        set(uri, diagnostics) {
            entries.set(uri.fsPath || String(uri), diagnostics);
        },
        dispose() {
            entries.clear();
        }
    };
    state.collections.push(collection);
    return collection;
}

const vscode = {
    DiagnosticSeverity: {
        Error: 0,
        Warning: 1,
        Information: 2,
        Hint: 3
    },
    Range,
    Diagnostic,
    Uri: {
        file(filePath) {
            return { fsPath: filePath, path: filePath, toString: () => filePath };
        }
    },
    languages: {
        createDiagnosticCollection
    },
    commands: {
        registerCommand(id, callback) {
            const registration = { id, callback, dispose() {} };
            state.commands.push(registration);
            return registration;
        }
    },
    workspace: {
        workspaceFolders: [{ uri: { fsPath: 'D:\\workspace\\vscode_plugin' } }],
        findFiles: async () => [],
        openTextDocument: async () => {
            throw new Error('openTextDocument is not implemented by the unit-test mock');
        }
    },
    window: {
        activeTextEditor: undefined,
        showInputBox: async () => undefined,
        showInformationMessage(message) {
            state.messages.push({ type: 'info', message });
        },
        showErrorMessage(message) {
            state.messages.push({ type: 'error', message });
        }
    }
};

function reset() {
    state.commands.length = 0;
    state.collections.length = 0;
    state.messages.length = 0;
}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
        return vscode;
    }
    return originalLoad.call(this, request, parent, isMain);
};

global.__vscodeMock = { vscode, state, reset };
