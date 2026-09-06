'use strict';

const { beforeEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const vscodeMock = global.__vscodeMock;
const extension = require('../out/extension.js');
const rulesApi = extension.__test;

const devin02Root = process.env.DEVIN02_ROOT || 'D:\\workspace\\devin02';
const devin02Lcint = path.join(devin02Root, 'les', 'src', 'cmdsrc', 'lcint');

function documentOf(fileName, text) {
    return {
        fileName,
        getText: () => text
    };
}

function ruleIds(issues) {
    return issues.map(issue => issue.rule);
}

function validLocalSyntax(name = 'list lc sample records') {
    return [
        '<command>',
        `<name>${name}</name>`,
        `<description>${name}</description>`,
        '<type>Local Syntax</type>',
        '<local-syntax><![CDATA[',
        'publish data where value = 1',
        ']]></local-syntax>',
        '</command>'
    ].join('\n');
}

beforeEach(() => {
    vscodeMock.reset();
});

describe('VS Code integration surface', () => {
    test('activation registers the four commands and a diagnostic collection', () => {
        const context = { subscriptions: [] };

        extension.activate(context);

        assert.deepEqual(
            vscodeMock.state.commands.map(command => command.id).sort(),
            [
                'code-reviewer.reviewByJiraTicket',
                'code-reviewer.reviewFile',
                'code-reviewer.reviewJrxml',
                'code-reviewer.reviewProject'
            ]
        );
        assert.equal(vscodeMock.state.collections.length, 1);
        assert.equal(vscodeMock.state.collections[0].name, 'code-reviewer');
        assert.equal(context.subscriptions.length, 5);
    });

    test('issues are converted to Problems diagnostics with rule codes', () => {
        extension.activate({ subscriptions: [] });

        rulesApi.showIssuesInProblemsPanel([{
            file: 'D:\\workspace\\sample.mcmd',
            line: 2,
            column: 3,
            severity: vscodeMock.vscode.DiagnosticSeverity.Error,
            message: 'sample issue',
            rule: 'sample-rule'
        }]);

        const diagnostics = vscodeMock.state.collections[0].entries.get('D:\\workspace\\sample.mcmd');
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0].code, 'sample-rule');
        assert.deepEqual(diagnostics[0].range.start, { line: 1, character: 2 });
    });
});

describe('.mcmd structure and naming rules', () => {
    test('reports a missing name tag', () => {
        const text = validLocalSyntax().replace('<name>list lc sample records</name>\n', '');
        assert.ok(ruleIds(rulesApi.checkFileStructure(text, 'sample.mcmd')).includes('missing-name'));
    });

    test('reports missing description and type tags', () => {
        const text = validLocalSyntax()
            .replace('<description>list lc sample records</description>\n', '')
            .replace('<type>Local Syntax</type>\n', '');
        const ids = ruleIds(rulesApi.checkFileStructure(text, 'sample.mcmd'));
        assert.ok(ids.includes('missing-description'));
        assert.ok(ids.includes('missing-type'));
    });

    test('requires Local Syntax CDATA for non-Java commands', () => {
        const text = validLocalSyntax().replace(/<local-syntax>[\s\S]*?<\/local-syntax>\n/, '');
        assert.ok(ruleIds(rulesApi.checkFileStructure(text, 'sample.mcmd')).includes('missing-local-syntax'));
    });

    test('allows Java Method commands without Local Syntax using a real devin02 file', {
        skip: !fs.existsSync(path.join(devin02Lcint, 'validate_lc_sql_injection.mcmd'))
    }, () => {
        const fileName = path.join(devin02Lcint, 'validate_lc_sql_injection.mcmd');
        const text = fs.readFileSync(fileName, 'utf8');
        const ids = ruleIds(rulesApi.checkFileStructure(text, fileName));
        assert.ok(!ids.includes('missing-local-syntax'));
        assert.ok(!ids.includes('missing-name'));
        assert.ok(!ids.includes('missing-description'));
        assert.ok(!ids.includes('missing-type'));
    });

    test('reports uppercase characters in command names', () => {
        assert.ok(ruleIds(rulesApi.checkNameNoUpperCase('list LC records', 'sample.mcmd')).includes('name-no-uppercase'));
    });

    test('reports uppercase characters in the actual file name', () => {
        const fileName = path.join(devin02Lcint, 'Invalid_Name.mcmd');
        assert.ok(ruleIds(rulesApi.checkFileNameNoUpperCase(fileName)).includes('filename-no-uppercase'));
    });

    test('matches command name spaces to file-name underscores', () => {
        assert.deepEqual(
            rulesApi.checkNameMatchesFile('list lc sample records', 'list_lc_sample_records', 'sample.mcmd'),
            []
        );
        assert.ok(
            ruleIds(rulesApi.checkNameMatchesFile('list lc other records', 'list_lc_sample_records', 'sample.mcmd'))
                .includes('name-mismatch')
        );
    });
});

describe('Git branch character rule', () => {
    test('accepts the allowed character set', () => {
        assert.deepEqual(rulesApi.validateGitBranchName('feature/SWIFTLEX-123_test'), []);
    });

    test('rejects non feature/SWIFTLEX prefixes and extra symbols', () => {
        for (const branch of [
            'release/2026.1',
            'feature bad',
            '功能/SWIFTLEX-1',
            'feature/SWIFTLEX-123-fix',
            'feature/SWIFTLEX-123/extra',
            'feature/SWIFTLEX-123.test'
        ]) {
            assert.ok(ruleIds(rulesApi.validateGitBranchName(branch)).includes('invalid-branch-name'));
        }
    });
});

describe('Git status path parsing', () => {
    test('parses modified, renamed and untracked paths', () => {
        const status = [
            ' M les/src/example.mcmd',
            'R  les/src/old.mcmd -> les/src/new.mcmd',
            '?? les/db/data/new.csv'
        ].join('\n');
        assert.deepEqual(rulesApi.parseGitStatusPaths(status), [
            'les/src/example.mcmd',
            'les/src/new.mcmd',
            'les/db/data/new.csv'
        ]);
    });
});

describe('JRXML MOCA connection rule', () => {
    test('accepts the canonical self-closing parameter', () => {
        const text = '<parameter name="MOCA_REPORT_CONNECTION" class="com.redprairie.moca.jrds.JRMocaConnection" isForPrompting="false"/>';
        assert.deepEqual(rulesApi.checkJrxmlMocaConnection(documentOf('report.jrxml', text)), []);
    });

    test('accepts a non-self-closing parameter with only the MOCA property', () => {
        const text = [
            '<parameter name="MOCA_REPORT_CONNECTION" class="com.redprairie.moca.jrds.JRMocaConnection" isForPrompting="false">',
            '    <property name="MOCA" value="true"/>',
            '</parameter>'
        ].join('\n');
        assert.deepEqual(rulesApi.checkJrxmlMocaConnection(documentOf('report.jrxml', text)), []);
    });

    test('rejects defaultValueExpression even when it is empty', () => {
        const text = [
            '<parameter name="MOCA_REPORT_CONNECTION" class="com.redprairie.moca.jrds.JRMocaConnection" isForPrompting="false">',
            '    <property name="MOCA" value="true"/>',
            '    <defaultValueExpression><![CDATA[]]></defaultValueExpression>',
            '</parameter>'
        ].join('\n');
        assert.ok(
            ruleIds(rulesApi.checkJrxmlMocaConnection(documentOf('report.jrxml', text)))
                .includes('jrxml-moca-connection-invalid')
        );
    });

    test('accepts the MOCA property regardless of attribute order and rejects extra children', () => {
        const valid = '<parameter name="MOCA_REPORT_CONNECTION"><property value="true" name="MOCA"/></parameter>';
        assert.deepEqual(rulesApi.checkJrxmlMocaConnection(documentOf('report.jrxml', valid)), []);

        const invalid = '<parameter name="MOCA_REPORT_CONNECTION"><property name="MOCA" value="true"/><property name="extra" value="x"/></parameter>';
        assert.ok(
            ruleIds(rulesApi.checkJrxmlMocaConnection(documentOf('report.jrxml', invalid)))
                .includes('jrxml-moca-connection-invalid')
        );
    });

    test('rejects a non-self-closing parameter with a hardcoded server value', () => {
        const text = '<parameter name="MOCA_REPORT_CONNECTION" class="com.redprairie.moca.jrds.JRMocaConnection"><defaultValueExpression>server</defaultValueExpression></parameter>';
        assert.ok(
            ruleIds(rulesApi.checkJrxmlMocaConnection(documentOf('report.jrxml', text)))
                .includes('jrxml-moca-connection-invalid')
        );
    });

    test('rejects a property parameter that still contains a localhost connection', () => {
        const text = [
            '<parameter name="MOCA_REPORT_CONNECTION" class="com.redprairie.moca.jrds.JRMocaConnection">',
            '    <property name="MOCA" value="true"/>',
            '    <defaultValueExpression>localhost:8080</defaultValueExpression>',
            '</parameter>'
        ].join('\n');
        assert.ok(
            ruleIds(rulesApi.checkJrxmlMocaConnection(documentOf('report.jrxml', text)))
                .includes('jrxml-moca-connection-invalid')
        );
    });
});

describe('devin02 real-code baseline', () => {
    test('all lcint .mcmd files satisfy the already-compliant structure, uppercase and name/file rules', {
        skip: !fs.existsSync(devin02Lcint)
    }, () => {
        const files = fs.readdirSync(devin02Lcint)
            .filter(file => file.endsWith('.mcmd'))
            .map(file => path.join(devin02Lcint, file));
        assert.ok(files.length > 0, 'expected real .mcmd files in devin02 lcint');

        const coveredRuleIds = new Set([
            'missing-name',
            'missing-description',
            'missing-type',
            'missing-local-syntax',
            'name-no-uppercase',
            'filename-no-uppercase',
            'name-mismatch'
        ]);
        const failures = [];

        for (const fileName of files) {
            const text = fs.readFileSync(fileName, 'utf8');
            const issues = rulesApi.checkFileStructure(text, fileName)
                .filter(issue => coveredRuleIds.has(issue.rule));
            const nameMatch = text.match(/<name>([\s\S]*?)<\/name>/i);
            if (nameMatch) {
                const fileBase = path.basename(fileName, '.mcmd');
                issues.push(...rulesApi.checkNameMatchesFile(nameMatch[1].trim(), fileBase, fileName));
            }
            if (issues.length > 0) {
                failures.push({ file: path.relative(devin02Root, fileName), rules: ruleIds(issues) });
            }
        }

        assert.deepEqual(failures, []);
    });
});
