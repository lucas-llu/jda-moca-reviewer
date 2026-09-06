'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('../out/extension.js').__test;

const devin02Root = process.env.DEVIN02_ROOT || 'D:\\workspace\\devin02';

function documentOf(fileName, text) {
    return { fileName, getText: () => text };
}

function ids(issues) {
    return issues.map(issue => issue.rule);
}

describe('U-01 module path routing', () => {
    test('classifies postinstall, label and data module paths', () => {
        assert.equal(rules.getReviewKind('D:\\repo\\rpmbuild\\app\\postinstall\\allnodes\\01-isccustom.sh'), 'postinstall');
        assert.equal(rules.getReviewKind('D:\\repo\\les\\labels\\z140xiII\\label.pof'), 'label');
        assert.equal(rules.getReviewKind('D:\\repo\\les\\reports\\z140xiII\\label.pof'), 'label');
        assert.equal(rules.getReviewKind('D:\\repo\\les\\db\\ddl\\lc\\Tables\\usr_lc_x.tbl'), 'database-table');
        assert.equal(rules.getReviewKind('D:\\repo\\les\\db\\ddl\\lc\\Sequences\\usr_lc_x.seq'), 'database-sequence');
        assert.equal(rules.getReviewKind('D:\\repo\\les\\db\\ddl\\pd\\amazon-messaging\\Tables\\usr_pd_x.tbl'), 'database-table');
        assert.equal(rules.getReviewKind('D:\\repo\\les\\db\\ddl\\pd\\amazon-messaging\\Indexes\\usr_pd_x.idx'), 'database-index');
        assert.equal(rules.getReviewKind('D:\\repo\\les\\db\\ddl\\pd\\amazon-messaging\\Sequences\\usr_pd_x.seq'), 'database-sequence');
        assert.equal(rules.getReviewKind('D:\\repo\\les\\db\\ddl\\lc\\Views\\usr_lc_x.vw'), 'database-view');
        assert.equal(rules.getReviewKind('D:\\repo\\les\\db\\ddl\\pd\\amazon-messaging\\Triggers\\usr_pd_x.trg'), 'database-trigger');
        assert.equal(rules.getReviewKind('D:\\repo\\les\\db\\data\\load\\lc\\safetoload\\x\\y.csv'), 'csv');
        assert.equal(rules.getReviewKind('D:\\repo\\rpmbuild\\app\\postinstall\\allnodes\\cleanup.sh'), undefined);
    });
});

describe('U-22 database object rules', () => {
    test('checks view and database-trigger names and layer prefixes', () => {
        const validView = documentOf(
            'D:\\workspace\\fixtures\\les\\db\\ddl\\lc\\Views\\usr_lc_orders.vw',
            'CREATE OR REPLACE VIEW usr_lc_orders AS SELECT 1 FROM dual'
        );
        assert.deepEqual(rules.performDatabaseReview(validView), []);

        const invalidTrigger = documentOf(
            'D:\\workspace\\fixtures\\les\\db\\ddl\\pd\\plugin\\Triggers\\bad_name.trg',
            'CREATE OR REPLACE TRIGGER different_name BEFORE INSERT ON usr_pd_table'
        );
        const issues = rules.performDatabaseReview(invalidTrigger);
        assert.ok(ids(issues).includes('database-name-mismatch'));
        assert.ok(ids(issues).includes('database-prefix-invalid'));
    });

    test('rejects a table name/file mismatch and a missing primary key', () => {
        const text = '[CREATE_TABLE(usr_lc_wrong_name)\n(\n col STRING_TY(20)\n)]';
        const issues = rules.performDatabaseReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\ddl\\lc\\Tables\\usr_lc_right_name.tbl',
            text
        ));
        const result = ids(issues);
        assert.ok(result.includes('database-name-mismatch'));
        assert.ok(result.includes('database-table-missing-primary-key'));
    });

    test('rejects BY/Core/Plugin table prefixes', () => {
        const text = '[CREATE_TABLE(by_table)\n(\n id STRING_TY(20) not null /* PK */\n)]';
        const issues = rules.performDatabaseReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\ddl\\lc\\Tables\\by_table.tbl',
            text
        ));
        assert.ok(ids(issues).includes('database-prefix-invalid'));
    });

    test('rejects an index file name mismatch', () => {
        const text = '[CREATE_INDEX_BEGIN(usr_lc_table, usr_lc_wrong_index)\nCREATE_INDEX_END]';
        const issues = rules.performDatabaseReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\ddl\\lc\\Indexes\\usr_lc_right_index.idx',
            text
        ));
        assert.ok(ids(issues).includes('database-name-mismatch'));
    });

    test('rejects an ALTER column missing from CREATE_TABLE', () => {
        const text = [
            '[CREATE_TABLE(usr_lc_sample)',
            '(id STRING_TY(20) not null /* PK */)]',
            '[ALTER_TABLE_ADD_COLUMN_BEGIN(usr_lc_sample, new_col)',
            'ALTER_TABLE_ADD_COLUMN_END]'
        ].join('\n');
        const issues = rules.performDatabaseReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\ddl\\lc\\Tables\\usr_lc_sample.tbl',
            text
        ));
        assert.ok(ids(issues).includes('database-alter-column-missing-in-create'));
    });

    test('rejects a sequence name/file mismatch', () => {
        const text = '[CREATE SEQUENCE usr_lc_wrong_seq START WITH 1] catch(-955) RUN_DDL';
        const issues = rules.performDatabaseReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\ddl\\lc\\Sequences\\usr_lc_right_seq.seq',
            text
        ));
        assert.ok(ids(issues).includes('database-name-mismatch'));
    });

    test('rejects omitted _idx/_seq suffix like LC naming rules', () => {
        const index = rules.performDatabaseReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\ddl\\pd\\amazon-messaging\\Indexes\\usr_pd_amzmsg_x.idx',
            '[CREATE_INDEX_BEGIN(usr_pd_amzmsg_x, usr_pd_amzmsg_x_idx)\nCREATE_INDEX_END]'
        ));
        const sequence = rules.performDatabaseReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\ddl\\pd\\amazon-messaging\\Sequences\\usr_pd_amzmsg_x.seq',
            '[CREATE SEQUENCE usr_pd_amzmsg_x_seq START WITH 1] catch(-955) RUN_DDL'
        ));
        assert.ok(ids(index).includes('database-name-mismatch'));
        assert.ok(ids(sequence).includes('database-name-mismatch'));
    });
});

describe('U-23 CSV/CTL rules', () => {
    test('rejects a cust_lvl below 100', () => {
        const text = 'colnam,cust_lvl\nopt_nam,10\n';
        const issues = rules.performCsvModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\data\\load\\lc\\safetoload\\sample\\lc_sample.csv',
            text
        ));
        assert.ok(ids(issues).includes('cust-lvl-too-low'));
    });

    test('rejects les_mls_cat error ids outside 4000000-4999999', () => {
        const text = 'mls_id,locale_id\nerr3999999,EN-GB\n';
        const issues = rules.performCsvModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\data\\load\\lc\\safetoload\\les_mls_cat\\lc_les_mls_cat_x.csv',
            text
        ));
        assert.ok(ids(issues).includes('mls-cat-invalid-id'));
    });

    test('rejects unload ctl without parameterized DELETE catch(-1403)', () => {
        const text = '[delete les_cmd where les_cmd_id = \'@les_cmd_id@\']';
        const issues = rules.performCsvModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\data\\unload\\safetoload\\les_cmd.ctl',
            text
        ));
        assert.ok(ids(issues).includes('unload-ctl-invalid'));
    });

    test('accepts unload ctl with catch(@?)', () => {
        const text = "[delete les_cmd where les_cmd_id = '@les_cmd_id@'] catch(@?)";
        const issues = rules.performCsvModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\data\\unload\\pd\\bootstraponly\\amazon-messaging\\les_cmd.ctl',
            text
        ));
        assert.ok(!ids(issues).includes('unload-ctl-invalid'));
    });

    test('does not mistake select inside a comment for direct SQL', () => {
        const text = [
            '/*No existing MOCA list command, use select statement instead.*/',
            '[select id from sample_table where operation = @operation]'
        ].join('\n');
        const issues = rules.performCsvModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\data\\load\\lc\\safetoload\\sample.ctl',
            text
        ));
        assert.ok(!ids(issues).includes('ctl-direct-script-missing-comment'));
    });

    test('accepts plugin pd_ unload CSV names only with SWIFTLEX suffix', () => {
        const withTicket = rules.performCsvModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\data\\unload\\pd\\bootstraponly\\amazon-messaging\\doc_lblfmt\\pd_amzmsg_doc_lblfmt_SWIFTLEX-71722.csv',
            'colnam,cust_lvl\nx,100\n'
        ));
        const withoutTicket = rules.performCsvModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\data\\unload\\pd\\bootstraponly\\amazon-messaging\\doc_lblfmt\\pd_amzmsg_flex_palbl_doc_lblfmt.csv',
            'colnam,cust_lvl\nx,100\n'
        ));
        assert.ok(!ids(withTicket).includes('unload-csv-kngl-naming'));
        assert.ok(ids(withoutTicket).includes('unload-csv-kngl-naming'));
    });

    test('accepts pd-config_actions version 2.7.3', () => {
        const text = '/* Config actions import script v2.7.3 */\npublish data where value = 1';
        const issues = rules.performCsvModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\data\\load\\pd\\bootstraponly\\amazon-messaging\\pd-config_actions.ctl',
            text
        ));
        assert.ok(!ids(issues).includes('config-action-version'));
    });

    test('skips cust_lvl checks for plugin data', () => {
        const issues = rules.performCsvModuleReview(documentOf(
            'D:\\workspace\\swift-pd-customisations-amazon-messaging\\fixtures\\load\\pd\\sample.csv',
            'colnam,cust_lvl\nx,10\n'
        ));
        assert.ok(!ids(issues).includes('cust-lvl-too-low'));
    });

    test('applies plugin les_mls_cat ranges and group names', () => {
        const valid = [
            'mls_id,locale_id,prod_id,appl_id,frm_id,vartn,srt_seq,cust_lvl,mls_text,grp_nam',
            'err3400000,US_ENGLISH,LES,LES,LES,LES,0,100,Message,pd_amzmsg_errmsg',
            'pd_amzmsg_value,US_ENGLISH,LES,LES,LES,LES,0,100,Value,pd_amzmsg_dcs_fieldnames'
        ].join('\n');
        const validIssues = rules.performCsvModuleReview(documentOf(
            'D:\\workspace\\swift-pd-customisations-amazon-messaging\\les\\db\\data\\load\\pd\\safetoload\\amazon-messaging\\les_mls_cat\\pd_amzmsg_les_mls_cat_SWIFTLEX-x.csv',
            valid
        ));
        assert.ok(!ids(validIssues).includes('mls-cat-invalid-id'));
        assert.ok(!ids(validIssues).includes('mls-cat-invalid-group'));

        const outOfRange = valid.replace('err3400000', 'err3400200');
        assert.ok(ids(rules.performCsvModuleReview(documentOf(
            'D:\\workspace\\swift-pd-customisations-amazon-messaging\\les\\db\\data\\load\\pd\\safetoload\\amazon-messaging\\les_mls_cat\\pd_amzmsg_les_mls_cat_SWIFTLEX-x.csv',
            outOfRange
        ))).includes('mls-cat-invalid-id'));
    });

    test('reports csv data row issues on the correct line', () => {
        const text = [
            'mls_id,locale_id,prod_id,appl_id,frm_id,vartn,srt_seq,cust_lvl,mls_text,grp_nam',
            'lc_good,EN-GB,LES,LES,LES,LES,0,100,msg,g',
            'bad_value,EN-GB,LES,LES,LES,LES,0,100,msg,g'
        ].join('\n');
        const issues = rules.performCsvModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\data\\load\\lc\\safetoload\\les_mls_cat\\lc_les_mls_cat.csv',
            text
        ));
        const issue = issues.find(item => item.rule === 'mls-cat-invalid-id');
        assert.ok(issue);
        assert.equal(issue.line, 3);
    });

    test('requires a same-named sibling ctl for csv files', () => {
        const issues = rules.performCsvModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\db\\data\\load\\lc\\safetoload\\missing_ctl\\lc_missing.csv',
            'colnam,cust_lvl\nx,100\n'
        ));
        assert.ok(ids(issues).includes('csv-missing-ctl'));
    });
});

describe('U-24 report/label rules', () => {
    test('rejects a label file name longer than 20 characters', () => {
        const issues = rules.performReportModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\labels\\z140xiII\\a234567890123456789012.pof',
            '^XA\n^XZ'
        ));
        assert.ok(ids(issues).includes('label-filename-too-long'));
    });

    test('rejects a jrxml file name longer than 30 characters and rpt_id mismatch', () => {
        const text = '<jasperReport name="x"><parameter name="rpt_id" value="Other"/></jasperReport>';
        const issues = rules.performReportModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\reports\\a234567890123456789012345678901.jrxml',
            text
        ));
        const result = ids(issues);
        assert.ok(result.includes('report-filename-too-long'));
        assert.ok(result.includes('rpt-id-mismatch'));
    });

    test('ignores rpt_id MOCA placeholder values', () => {
        const text = '<parameter name="rpt_id" class="java.lang.String"><property name="prompt" value="^rpt_id^"/></parameter>';
        const issues = rules.performReportModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\reports\\Pd-amzmsg-ish-LoadingList.jrxml',
            text
        ));
        assert.ok(!ids(issues).includes('rpt-id-mismatch'));
    });

    test('rpt_id comparison is case-sensitive', () => {
        const text = '<parameter name="rpt_id" value="Report"/><parameter name="MOCA_REPORT_CONNECTION"/>';
        const issues = rules.performReportModuleReview(documentOf(
            'D:\\workspace\\fixtures\\les\\reports\\report.jrxml',
            text
        ));
        assert.ok(ids(issues).includes('rpt-id-mismatch'));
    });
});

describe('devin02 module integration', () => {
    test('accepts the real unload .ctl', {
        skip: !fs.existsSync(path.join(devin02Root, 'les', 'db', 'data', 'unload', 'safetoload', 'les_cmd.ctl'))
    }, () => {
        const fileName = path.join(devin02Root, 'les', 'db', 'data', 'unload', 'safetoload', 'les_cmd.ctl');
        const issues = rules.performCsvModuleReview(documentOf(fileName, fs.readFileSync(fileName, 'utf8')));
        assert.ok(!ids(issues).includes('unload-ctl-invalid'));
        assert.ok(!ids(issues).includes('unload-ctl-missing-csv'));
    });

    test('accepts the real Config Action version', {
        skip: !fs.existsSync(path.join(devin02Root, 'les', 'db', 'data', 'load', 'lc', 'safetoload', 'lc-config_actions.ctl'))
    }, () => {
        const fileName = path.join(devin02Root, 'les', 'db', 'data', 'load', 'lc', 'safetoload', 'lc-config_actions.ctl');
        const issues = rules.performCsvModuleReview(documentOf(fileName, fs.readFileSync(fileName, 'utf8')));
        assert.ok(!ids(issues).includes('config-action-version'));
    });

    test('allows the real prtdsc nobind/bind pattern', {
        skip: !fs.existsSync(path.join(devin02Root, 'les', 'src', 'cmdsrc', 'lcint', 'list_lc_inspect_inventory_details_in_carton.mcmd'))
    }, () => {
        const fileName = path.join(devin02Root, 'les', 'src', 'cmdsrc', 'lcint', 'list_lc_inspect_inventory_details_in_carton.mcmd');
        const issues = rules.performMcmdReview(documentOf(fileName, fs.readFileSync(fileName, 'utf8')));
        assert.ok(!ids(issues).includes('prtdsc-nobind-bind'));
    });

    test('allows the real postinstall mload_all shared call', {
        skip: !fs.existsSync(path.join(devin02Root, 'rpmbuild', 'app', 'postinstall', 'allnodes', '01-isccustom.sh'))
    }, () => {
        const fileName = path.join(devin02Root, 'rpmbuild', 'app', 'postinstall', 'allnodes', '01-isccustom.sh');
        const issues = rules.performCsvModuleReview(documentOf(fileName, fs.readFileSync(fileName, 'utf8')));
        assert.ok(!ids(issues).includes('postinstall-mload-all-missing'));
    });

    test('does not require mload_all for unrelated scripts or projects without unload artifacts', () => {
        const unrelated = documentOf(
            'D:\\workspace\\fixtures\\rpmbuild\\app\\postinstall\\allnodes\\cleanup.sh',
            'echo cleanup'
        );
        assert.deepEqual(rules.performCsvModuleReview(unrelated), []);

        const noUnload = {
            fileName: 'D:\\empty-repo\\rpmbuild\\app\\postinstall\\allnodes\\01-isccustom.sh',
            workspaceRoot: 'D:\\empty-repo',
            getText: () => 'echo no unload data'
        };
        assert.deepEqual(rules.performCsvModuleReview(noUnload), []);
    });

    test('scans the real module corpus without crashes or invalid locations', {
        skip: !fs.existsSync(devin02Root)
    }, () => {
        const directories = [
            path.join(devin02Root, 'les', 'db', 'ddl', 'lc', 'Tables'),
            path.join(devin02Root, 'les', 'db', 'ddl', 'lc', 'Indexes'),
            path.join(devin02Root, 'les', 'db', 'ddl', 'lc', 'Sequences'),
            path.join(devin02Root, 'les', 'db', 'data'),
            path.join(devin02Root, 'les', 'labels', 'z140xiII'),
            path.join(devin02Root, 'les', 'reports'),
            path.join(devin02Root, 'rpmbuild', 'app', 'postinstall')
        ];
        const files = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (/\.(pof|jrxml|tbl|idx|seq|csv|ctl|sh)$/i.test(entry.name)) {
                    files.push(full);
                }
            }
        };
        for (const directory of directories) {
            if (fs.existsSync(directory)) {
                walk(directory);
            }
        }
        assert.ok(files.length > 0, 'expected module files in devin02');
        for (const fileName of files) {
            const text = fs.readFileSync(fileName, 'utf8');
            const result = rules.reviewDocument(documentOf(fileName, text));
            const lineCount = text.split(/\r?\n/).length;
            for (const issue of result) {
                assert.ok(issue.line >= 1 && issue.line <= lineCount, `${fileName}: invalid line ${issue.line}`);
                assert.ok(issue.column >= 1, `${fileName}: invalid column ${issue.column}`);
                assert.ok(issue.rule, `${fileName}: missing rule id`);
            }
        }
    });

    test('accepts real devin02 sequence naming and idempotency', {
        skip: !fs.existsSync(path.join(devin02Root, 'les', 'db', 'ddl', 'lc', 'Sequences', 'usr_lc_dna_id.seq'))
    }, () => {
        const directory = path.join(devin02Root, 'les', 'db', 'ddl', 'lc', 'Sequences');
        const files = fs.readdirSync(directory).filter(name => name.endsWith('.seq'));
        assert.ok(files.length > 0, 'expected .seq files');
        for (const name of files) {
            const fileName = path.join(directory, name);
            const issues = rules.performDatabaseReview(documentOf(fileName, fs.readFileSync(fileName, 'utf8')));
            assert.ok(!ids(issues).includes('database-prefix-invalid'));
            assert.ok(!ids(issues).includes('database-sequence-not-idempotent'));
            if (name.toLowerCase() === 'usr_lc_schneider_dto_opers_id.seq') {
                assert.ok(ids(issues).includes('database-name-mismatch'));
            } else {
                assert.ok(!ids(issues).includes('database-name-mismatch'));
            }
        }
    });
});
