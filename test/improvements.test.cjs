'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('../out/extension.js').__test;
const devin02Root = process.env.DEVIN02_ROOT || 'D:\\workspace\\devin02';
const devin02Lcint = path.join(devin02Root, 'les', 'src', 'cmdsrc', 'lcint');
const amazonPackListCommand = 'D:\\workspace\\swift-pd-customisations-amazon-messaging\\les\\src\\cmdsrc\\pdhs\\process_pd_amzmsg_ish_print_pack_list.mcmd';

function documentOf(fileName, text) {
    return { fileName, getText: () => text };
}

function ids(issues) {
    return issues.map(issue => issue.rule);
}

function fileFor(name, extension = '.mcmd') {
    return `D:\\workspace\\fixtures\\${name.replace(/ /g, '_')}${extension}`;
}

function mcmd(name, syntax = 'publish data where value = 1') {
    return [
        '<command>',
        `<name>${name}</name>`,
        `<description>${name}</description>`,
        '<type>Local Syntax</type>',
        '<local-syntax>',
        '<![CDATA[',
        syntax,
        ']]>',
        '</local-syntax>',
        '</command>'
    ].join('\n');
}

function reviewMcmd(name, syntax, fileName = fileFor(name)) {
    return rules.performMcmdReview(documentOf(fileName, mcmd(name, syntax)));
}

describe('P-01 review file routing', () => {
    test('classifies every currently supported path family', () => {
        const cases = [
            ['D:\\repo\\les\\src\\cmdsrc\\lcint\\list_lc_x.mcmd', 'mcmd'],
            ['D:\\repo\\les\\src\\cmdsrc\\lcint\\base-add_lc_x.mtrg', 'mtrg'],
            ['D:\\repo\\les\\reports\\report.jrxml', 'jrxml'],
            ['D:\\repo\\les\\labels\\z140xiII\\label.pof', 'label'],
            ['D:\\repo\\les\\db\\ddl\\lc\\Tables\\usr_lc_x.tbl', 'database-table'],
            ['D:\\repo\\les\\db\\ddl\\lc\\Indexes\\usr_lc_x.idx', 'database-index'],
            ['D:\\repo\\les\\db\\data\\load\\lc\\x.csv', 'csv'],
            ['D:\\repo\\les\\db\\data\\load\\lc\\x.ctl', 'ctl']
        ];
        for (const [fileName, expected] of cases) {
            assert.equal(rules.getReviewKind(fileName), expected);
            assert.equal(rules.isReviewableFile(fileName), true);
        }
    });

    test('excludes generated and dependency directories', () => {
        for (const fileName of [
            'D:\\repo\\.git\\saved.mcmd',
            'D:\\repo\\node_modules\\package.mcmd',
            'D:\\repo\\out\\copy.mcmd',
            'D:\\repo\\dist\\copy.mcmd',
            'D:\\repo\\les\\db\\ddl\\lc\\Tables\\.gitkeep'
        ]) {
            assert.equal(rules.isReviewableFile(fileName), false);
        }
    });

    test('project discovery applies excludes and deduplicates files from overlapping globs', async () => {
        const vscode = global.__vscodeMock.vscode;
        const originalFindFiles = vscode.workspace.findFiles;
        const calls = [];
        vscode.workspace.findFiles = async (glob, exclude) => {
            calls.push({ glob, exclude });
            if (glob === '**/*.mcmd') {
                return [
                    vscode.Uri.file('D:\\repo\\les\\src\\cmdsrc\\lcint\\list_lc_x.mcmd'),
                    vscode.Uri.file('D:\\repo\\out\\list_lc_x.mcmd')
                ];
            }
            if (glob.includes('Tables')) {
                return [
                    vscode.Uri.file('D:\\repo\\les\\db\\ddl\\lc\\Tables\\usr_lc_x.tbl'),
                    vscode.Uri.file('D:\\repo\\les\\db\\ddl\\lc\\Tables\\.gitkeep')
                ];
            }
            return [];
        };

        try {
            const files = await rules.findReviewableFiles();
            assert.deepEqual(
                files.map(file => file.fsPath).sort(),
                [
                    'D:\\repo\\les\\db\\ddl\\lc\\Tables\\usr_lc_x.tbl',
                    'D:\\repo\\les\\src\\cmdsrc\\lcint\\list_lc_x.mcmd'
                ].sort()
            );
            assert.ok(calls.every(call => call.exclude.includes('node_modules')));
        } finally {
            vscode.workspace.findFiles = originalFindFiles;
        }
    });
});

describe('P-02 through P-04 structure, command-name and file-name validation', () => {
    test('rejects an incomplete command root and unclosed Local Syntax', () => {
        const text = mcmd('list lc sample').replace('</local-syntax>', '');
        const result = rules.checkFileStructure(text, fileFor('list lc sample'));
        assert.ok(ids(result).includes('missing-local-syntax'));
    });

    test('rejects duplicate and empty name tags', () => {
        const duplicate = mcmd('list lc sample').replace(
            '<name>list lc sample</name>',
            '<name>list lc sample</name>\n<name>list lc duplicate</name>'
        );
        assert.ok(ids(rules.checkFileStructure(duplicate, fileFor('list lc sample'))).includes('duplicate-name'));
        assert.ok(ids(rules.checkFileStructure(mcmd(''), 'D:\\workspace\\fixtures\\empty.mcmd')).includes('name-empty'));
    });

    test('does not treat tag-like text inside CDATA as duplicate metadata', () => {
        const text = mcmd('list lc sample', 'publish data where xml = \'<description>embedded</description>\'');
        assert.ok(!ids(rules.checkFileStructure(text, fileFor('list lc sample'))).includes('duplicate-description'));
    });

    test('rejects leading/trailing whitespace, tabs and line breaks in name', () => {
        const names = [' list lc sample', 'list lc sample ', 'list\tlc sample', 'list\nlc sample'];
        for (const name of names) {
            const result = rules.checkFileStructure(mcmd(name), 'D:\\workspace\\fixtures\\sample.mcmd');
            assert.ok(
                ids(result).some(id => ['name-leading-trailing-whitespace', 'name-invalid-whitespace'].includes(id)),
                `expected whitespace issue for ${JSON.stringify(name)}`
            );
        }
    });

    test('requires a lowercase underscore-only .mcmd basename', () => {
        const result = rules.checkFileStructure(mcmd('list lc sample'), 'D:\\workspace\\fixtures\\list-lc-sample.mcmd');
        assert.ok(ids(result).includes('filename-invalid-characters'));
    });
});

describe('P-05 command layer, override and BY policy rules', () => {
    test('requires lc/usr/pd markers to be the second word', () => {
        const result = reviewMcmd('list sample lc', 'publish data where value = 1');
        assert.ok(ids(result).includes('invalid-layer-marker-position'));
    });

    test('does not reinterpret later usr/pd business words when the second word is already a layer', () => {
        const result = reviewMcmd('list lc usr stock level', 'publish data where value = 1');
        assert.ok(!ids(result).includes('invalid-layer-marker-position'));
    });

    test('allows lc override and warns for usr/pd override', () => {
        assert.ok(!ids(reviewMcmd('process lc wrapper', '^list lc records')).some(id => id.startsWith('override-')));
        assert.ok(ids(reviewMcmd('process lc wrapper', '^list usr records')).includes('override-usr-command'));
        assert.ok(ids(reviewMcmd('process lc wrapper', '^list pd records')).includes('override-pd-command'));
    });

    test('requires a BY customization to start with policy and call the original command', () => {
        const invalid = reviewMcmd('validate movement path criteria', '^validate movement path criteria');
        assert.ok(ids(invalid).includes('by-command-policy'));

        const validSyntax = [
            'list policies where polcod = \'LC_TEST\' catch(-1403)',
            '|',
            'if (@? = 0)',
            '{',
            '    publish data where value = 1',
            '}',
            'else',
            '{',
            '    ^validate movement path criteria',
            '}'
        ].join('\n');
        assert.ok(!ids(reviewMcmd('validate movement path criteria', validSyntax)).includes('by-command-policy'));
    });
});

describe('P-01/P-05 trigger validation', () => {
    test('accepts one command with catch', () => {
        const text = [
            '<trigger>',
            '<name>sample trigger</name>',
            '<local-syntax><![CDATA[',
            'process lc sample catch(-1403)',
            ']]></local-syntax>',
            '</trigger>'
        ].join('\n');
        const result = rules.reviewDocument(documentOf('D:\\repo\\sample-trigger.mtrg', text));
        assert.ok(!ids(result).includes('trigger-single-command'));
    });

    test('rejects publish data, if/else, pipes and multiple statements', () => {
        const invalidBodies = [
            'process lc sample | publish data where value = 1',
            'if (@x = 1) { process lc sample }',
            'process lc first; process lc second'
        ];
        for (const body of invalidBodies) {
            const text = `<trigger><name>x</name><local-syntax><![CDATA[${body}]]></local-syntax></trigger>`;
            const result = rules.reviewDocument(documentOf('D:\\repo\\sample-trigger.mtrg', text));
            assert.ok(ids(result).includes('trigger-single-command'));
        }
    });
});

describe('P-06 Complex SQL across the whole .mcmd', () => {
    test('treats repeated subqueries/table references as complex', () => {
        const syntax = '[with x as (select id from first_view where exists (select 1 from second_view) and exists (select 1 from third_view)) select id from x]';
        const result = reviewMcmd('process lc complex', syntax);
        assert.ok(ids(result).includes('complex-sql-command-type'));
    });

    test('allows two standalone non-complex SELECTs in non-list/get commands', () => {
        const syntax = '[select id from first_view]\n[select id from second_view]';
        assert.ok(!ids(reviewMcmd('process lc simple selects', syntax)).includes('complex-sql-command-type'));
    });

    test('combines JOIN and UNION counts and treats UNION ALL as one event', () => {
        const syntax = '[select a.id from a_view a join b_view b on a.id = b.id union all select id from c_view]';
        const issue = reviewMcmd('process lc complex', syntax)
            .find(item => item.rule === 'complex-sql-command-type');
        assert.ok(issue);
        assert.match(issue.message, /1 JOIN \+ 1 UNION/);
    });

    test('counts repeated table aliases and ignores keywords in comments/strings', () => {
        const repeated = '[select a.id from thing_view a join thing_view b on a.id = b.id join thing_view c on b.id = c.id]';
        const issue = reviewMcmd('process lc aliases', repeated)
            .find(item => item.rule === 'complex-sql-command-type');
        assert.ok(issue);
        assert.match(issue.message, /3 table references/);

        const ignored = "[select 'select join union' value from only_view /* select from ignored */]";
        assert.ok(!ids(reviewMcmd('process lc simple', ignored)).includes('complex-sql-command-type'));
    });

    test('allows complex SQL in list/get commands', () => {
        const syntax = '[select a.id from a_view a join b_view b on a.id = b.id join c_view c on b.id = c.id]';
        assert.ok(!ids(reviewMcmd('list lc complex', syntax)).includes('complex-sql-command-type'));
    });
});

describe('P-07/P-08 DML warnings, comments and list/get errors', () => {
    test('always warns for direct DML and requires an adjacent comment', () => {
        const withoutComment = reviewMcmd('process lc update record', '[update usr_lc_table set value = 1]');
        assert.ok(ids(withoutComment).includes('avoid-update'));
        assert.ok(ids(withoutComment).includes('dml-missing-comment'));

        const withComment = reviewMcmd('process lc update record', '/* Direct SQL required because change record cannot update this primary key. */\n[update usr_lc_table\n set value = 1]');
        assert.ok(ids(withComment).includes('avoid-update'));
        assert.ok(!ids(withComment).includes('dml-missing-comment'));

        const genericComment = reviewMcmd('process lc update record', '/* required */\n[update usr_lc_table set value = 1]');
        assert.ok(ids(genericComment).includes('dml-missing-comment'));
    });

    test('adds a list/get Error while retaining the DML Warning', () => {
        const result = reviewMcmd('list lc update records', '/* remove record cannot be used for this operation. */\n[delete\n from usr_lc_table]');
        assert.ok(ids(result).includes('avoid-delete'));
        assert.ok(ids(result).includes('list-get-no-delete'));
    });
});

describe('P-09 IN subquery handling', () => {
    test('allows small static lists', () => {
        const result = reviewMcmd('list lc static values', "[select id from values_view where status in ('A', 'B')]");
        assert.ok(!ids(result).includes('no-in-subquery'));
    });

    test('rejects multiline IN subqueries but ignores string content', () => {
        const invalid = reviewMcmd('list lc values', '[select id from values_view where id in (\nselect id from other_view\n)]');
        assert.ok(ids(invalid).includes('no-in-subquery'));

        const stringOnly = reviewMcmd('list lc values', "[select 'in (select fake)' value from values_view]");
        assert.ok(!ids(stringOnly).includes('no-in-subquery'));
    });
});

describe('P-10 SELECT-list sub-select boundaries', () => {
    test('rejects a SELECT-list subquery', () => {
        const result = reviewMcmd('list lc data', '[select id, (select max(id) from other_view) max_id from data_view]');
        assert.ok(ids(result).includes('no-sub-select-in-select'));
    });

    test('does not misclassify WHERE or FROM subqueries as SELECT-list sub-selects', () => {
        const whereSubquery = reviewMcmd('list lc data', '[select id from data_view where exists (select 1 from other_view)]');
        const fromSubquery = reviewMcmd('list lc data', '[select id from (select id from data_view) nested_data]');
        assert.ok(!ids(whereSubquery).includes('no-sub-select-in-select'));
        assert.ok(!ids(fromSubquery).includes('no-sub-select-in-select'));
    });
});

describe('P-11 FROM/JOIN View, poldat and dual checks', () => {
    test('checks JOIN targets and accepts non-view tables when a view is also used', () => {
        const result = reviewMcmd(
            'list lc joined data',
            '[select a.id from first_view a join second_table b on a.id = b.id]'
        );
        assert.ok(!ids(result).includes('select-from-non-view'));
        assert.ok(!ids(result).includes('select-from-non-view-missing-comment'));
    });

    test('adds Errors when no view is used and no standard SELECT comment exists', () => {
        const result = reviewMcmd('list lc data', '[select id from physical_table]');
        const genericComment = reviewMcmd('list lc data', '/* direct table */\n[select id from physical_table]');
        assert.ok(ids(result).includes('select-from-non-view'));
        assert.ok(ids(result).includes('select-from-non-view-missing-comment'));
        assert.ok(ids(result).includes('select-missing-comment'));
        assert.ok(ids(genericComment).includes('select-from-non-view'));
        assert.ok(ids(genericComment).includes('select-from-non-view-missing-comment'));
        assert.ok(ids(genericComment).includes('select-missing-comment'));
    });

    test('accepts a non-view table with the standard SELECT comment', () => {
        const result = reviewMcmd(
            'list lc data',
            '/* No existing MOCA list command, use select statement instead. No view exists for this table. */\n[select id from physical_table]'
        );
        assert.ok(!ids(result).includes('select-from-non-view'));
        assert.ok(!ids(result).includes('select-from-non-view-missing-comment'));
        assert.ok(!ids(result).includes('select-missing-comment'));
    });

    test('does not use the standard SELECT comment as a non-view explanation', () => {
        const result = reviewMcmd(
            'list lc data',
            '/* No existing MOCA list command, use select statement instead. */\n[select id from physical_table]'
        );
        assert.ok(!ids(result).includes('select-missing-comment'));
        assert.ok(ids(result).includes('select-from-non-view'));
        assert.ok(ids(result).includes('select-from-non-view-missing-comment'));
    });

    test('does not accept a standard comment separated from SQL by executable code', () => {
        const result = reviewMcmd(
            'list lc data',
            '/* No existing MOCA list command, use select statement instead. */\npublish data where value = 1\n|\n[select id from physical_table]'
        );
        assert.ok(ids(result).includes('select-missing-comment'));
        assert.ok(ids(result).includes('select-from-non-view-missing-comment'));
    });

    test('limits _view exemption to the same SELECT within a UNION block', () => {
        const result = reviewMcmd(
            'list lc data',
            '[select id from first_view union all select id from physical_table]'
        );
        assert.ok(ids(result).includes('select-from-non-view'));
    });

    test('implements poldat_view and dual special cases', () => {
        const poldat = reviewMcmd('list lc policy data', '/* required */\n[select * from poldat_view]');
        const dual = reviewMcmd('list lc current value', '/* required */\n[select 1 from dual]');
        assert.ok(ids(poldat).includes('prefer-poldat'));
        assert.ok(ids(poldat).includes('prefer-poldat-missing-comment'));
        assert.ok(ids(dual).includes('select-from-dual'));
    });
});

describe('P-12 explicit division-by-zero protection', () => {
    test('rejects unguarded non-constant denominators', () => {
        const result = reviewMcmd('list lc amounts', '[select amount / divisor value from amounts_view]');
        assert.ok(ids(result).includes('division-zero-guard'));
    });

    test('accepts direct numeric constant denominators', () => {
        const sql = [
            '[select amount / 1000 a,',
            '        amount / 1000.5 b,',
            '        amount / -1 c,',
            '        amount / (2000) d',
            '   from amounts_view]'
        ].join('\n');
        assert.ok(!ids(reviewMcmd('list lc constant amounts', sql)).includes('division-zero-guard'));
    });

    test('still rejects a literal zero denominator', () => {
        const result = reviewMcmd('list lc zero amounts', '[select amount / 0 value from amounts_view]');
        assert.ok(ids(result).includes('division-zero-guard'));
    });

    test('accepts NULLIF, denominator DECODE and short-circuit CASE guards', () => {
        const safeSql = [
            '[select amount / nullif(divisor, 0) a,',
            '        amount / decode(divisor, 0, null, divisor) b,',
            '        case when divisor = 0 then 0 else amount / divisor end c',
            '   from amounts_view]'
        ].join('\n');
        assert.ok(!ids(reviewMcmd('list lc safe amounts', safeSql)).includes('division-zero-guard'));
    });

    test('rejects DECODE that still evaluates division in a result argument', () => {
        const sql = '[select decode(divisor, 0, 0, amount / divisor) value from amounts_view]';
        assert.ok(ids(reviewMcmd('list lc unsafe amounts', sql)).includes('division-zero-guard'));
    });

    test('rejects a denominator DECODE whose zero branch still returns zero', () => {
        const sql = '[select amount / decode(divisor, 0, 0, divisor) value from amounts_view]';
        assert.ok(ids(reviewMcmd('list lc unsafe denominator', sql)).includes('division-zero-guard'));
    });

    test('ignores slash characters inside comments and strings', () => {
        const sql = "[select 'a/b' value from amounts_view /* amount / divisor */]";
        assert.ok(!ids(reviewMcmd('list lc slash text', sql)).includes('division-zero-guard'));
    });
});

describe('P-13 Jira parsing and real devin02 history', () => {
    test('deduplicates parsed Git output', () => {
        const output = ['---FILE---', 'a.mcmd', 'a.mcmd', '', '---FILE---', 'b.csv'].join('\n');
        assert.deepEqual(rules.parseGitChangedFilesOutput(output), ['a.mcmd', 'b.csv']);
    });

    test('finds multiple supported file families for a real ticket', {
        skip: !fs.existsSync(path.join(devin02Root, '.git'))
    }, async () => {
        const files = await rules.getGitChangedFiles('SWIFTLEX-74319', devin02Root);
        assert.equal(new Set(files).size, files.length);
        assert.ok(files.some(file => file.endsWith('.mcmd')));
        assert.ok(files.some(file => file.endsWith('.csv')));
        assert.ok(files.some(file => file.endsWith('.jrxml')));
        assert.ok(files.filter(rules.isReviewableFile).length > 0);
    });
});

describe('P-14 source positions', () => {
    test('reports a SQL issue on its real source line', () => {
        const text = mcmd('process lc update record', '\n\n[update usr_lc_table set value = 1]');
        const issue = rules.performMcmdReview(documentOf(fileFor('process lc update record'), text))
            .find(item => item.rule === 'avoid-update');
        const sqlUpdateIndex = text.indexOf('update', text.indexOf('[update'));
        const expectedLine = text.slice(0, sqlUpdateIndex).split('\n').length;
        assert.ok(issue);
        assert.equal(issue.line, expectedLine);
    });

    test('reports a name issue on the actual name line', () => {
        const text = mcmd('list LC records', 'publish data where value = 1');
        const issue = rules.performMcmdReview(documentOf('D:\\workspace\\fixtures\\list_lc_records.mcmd', text))
            .find(item => item.rule === 'name-no-uppercase');
        const expectedLine = text.slice(0, text.indexOf('LC')).split('\n').length;
        assert.ok(issue);
        assert.equal(issue.line, expectedLine);
    });
});

describe('devin02 improved-rule fixtures', () => {
    test('reviews the complete lcint mcmd/mtrg corpus without crashes or invalid locations', {
        skip: !fs.existsSync(devin02Lcint)
    }, () => {
        const files = fs.readdirSync(devin02Lcint)
            .filter(file => file.endsWith('.mcmd') || file.endsWith('.mtrg'))
            .map(file => path.join(devin02Lcint, file));
        assert.ok(files.length >= 200, 'expected the full devin02 lcint corpus');

        for (const fileName of files) {
            const text = fs.readFileSync(fileName, 'utf8');
            const result = rules.reviewDocument(documentOf(fileName, text));
            for (const issue of result) {
                const lineCount = text.split(/\r?\n/).length;
                assert.ok(issue.line >= 1 && issue.line <= lineCount, `${fileName}: invalid line ${issue.line}`);
                assert.ok(issue.column >= 1, `${fileName}: invalid column ${issue.column}`);
                assert.ok(issue.rule, `${fileName}: missing rule id`);
            }
        }
    });

    test('accepts the real BY override policy structure', {
        skip: !fs.existsSync(path.join(devin02Lcint, 'validate_movement_path_criteria.mcmd'))
    }, () => {
        const fileName = path.join(devin02Lcint, 'validate_movement_path_criteria.mcmd');
        const result = rules.performMcmdReview(documentOf(fileName, fs.readFileSync(fileName, 'utf8')));
        assert.ok(!ids(result).includes('by-command-policy'));
        assert.ok(!ids(result).some(id => id.endsWith('-missing-comment')));
    });

    test('accepts a real single-command trigger', {
        skip: !fs.existsSync(path.join(devin02Lcint, 'process_order_cancellation-log_lc_uin_order_cancel_event.mtrg'))
    }, () => {
        const fileName = path.join(devin02Lcint, 'process_order_cancellation-log_lc_uin_order_cancel_event.mtrg');
        const result = rules.reviewDocument(documentOf(fileName, fs.readFileSync(fileName, 'utf8')));
        assert.ok(!ids(result).includes('trigger-single-command'));
    });

    test('allows real static IN lists in a complex list command', {
        skip: !fs.existsSync(path.join(devin02Lcint, 'list_lc_inspect_inventory_details_in_carton.mcmd'))
    }, () => {
        const fileName = path.join(devin02Lcint, 'list_lc_inspect_inventory_details_in_carton.mcmd');
        const result = rules.performMcmdReview(documentOf(fileName, fs.readFileSync(fileName, 'utf8')));
        assert.ok(!ids(result).includes('no-in-subquery'));
    });
});

describe('reported Amazon Messaging regression', () => {
    test('requires a separate non-view explanation for shipment_line and accepts it once present', {
        skip: !fs.existsSync(amazonPackListCommand)
    }, () => {
        const text = fs.readFileSync(amazonPackListCommand, 'utf8');
        const currentResult = rules.performMcmdReview(documentOf(amazonPackListCommand, text));
        assert.ok(!ids(currentResult).includes('select-missing-comment'));
        assert.ok(!ids(currentResult).includes('select-from-non-view'));
        assert.ok(!ids(currentResult).includes('select-from-non-view-missing-comment'));

        const withoutViewReason = text.replace(/^\s*\* Retrieve data from some tables directly since there is no view for these tables\.\r?\n/im, '');
        const invalidResult = rules.performMcmdReview(documentOf(amazonPackListCommand, withoutViewReason));
        assert.ok(!ids(invalidResult).includes('select-missing-comment'));
        assert.ok(ids(invalidResult).includes('select-from-non-view'));
        assert.ok(ids(invalidResult).includes('select-from-non-view-missing-comment'));
    });
});

describe('reported Amazon Messaging DML regression', () => {
    const removeDeviceContextCommand = 'D:\\workspace\\swift-pd-customisations-amazon-messaging\\les\\src\\cmdsrc\\pdhs\\remove_pd_amzmsg_lpn_receive_device_context_f1.mcmd';

    test('checks remove record justification without applying SELECT view rules', {
        skip: !fs.existsSync(removeDeviceContextCommand)
    }, () => {
        const text = fs.readFileSync(removeDeviceContextCommand, 'utf8');
        const result = rules.performMcmdReview(documentOf(removeDeviceContextCommand, text));
        assert.ok(ids(result).includes('avoid-delete'));
        assert.ok(!ids(result).includes('dml-missing-comment'));
        assert.ok(!ids(result).includes('select-from-non-view'));
        assert.ok(!ids(result).includes('select-from-non-view-missing-comment'));
    });
});
