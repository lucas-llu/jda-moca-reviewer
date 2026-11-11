'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const rules = require('../out/extension.js').__test;
const base = 'D:/checklist-fixtures';
const doc = (fileName, text) => ({ fileName, getText: () => text });
const review = (file, text) => rules.reviewDocument(doc(path.join(base, file), text));
const mcmd = (syntax, name = 'process lc probe') => review(`${name.replace(/ /g, '_')}.mcmd`,
    `<command><name>${name}</name><description>probe</description><type>Local Syntax</type><local-syntax><![CDATA[${syntax}]]></local-syntax></command>`);
const only = (issues, rule) => issues.filter(issue => issue.rule === rule);
const csv = (text, table = 'sample', unload = false) => review(`les/db/data/${unload ? 'unload' : 'load'}/lc/safetoload/${table}/lc_sample.csv`, text);
const ddl = text => review('les/db/ddl/lc/Tables/usr_lc_sample.tbl', text);

describe('checklist: added column documentation', () => {
    const macro = '[ALTER_TABLE_ADD_COLUMN_BEGIN(usr_lc_sample, new_col)\nALTER_TABLE_ADD_COLUMN_END] catch(-1442)';
    const documentation = 'create db documentation where table="usr_lc_sample" and new_col="A new field"\n/';
    for (const [id, source, count] of [
        ['missing documentation', macro, 1],
        ['matching documentation', `${macro}\n${documentation}`, 0],
        ['case insensitive names and single quotes', `${macro}\nCREATE DB DOCUMENTATION WHERE TABLE='USR_LC_SAMPLE' AND NEW_COL='Description'\n/`, 0],
        ['empty description', `${macro}\n${documentation.replace('A new field', '  ')}`, 1],
        ['wrong table', `${macro}\n${documentation.replace('usr_lc_sample', 'usr_lc_other')}`, 1],
        ['wrong column', `${macro}\n${documentation.replace('new_col=', 'different_col=')}`, 1],
        ['comment cannot document a column', `${macro}\n/* ${documentation} */`, 1],
        ['literal cannot document a column', `${macro}\npublish data where note='create db documentation where table="usr_lc_sample" and new_col="Description"'`, 1],
        ['comment cannot add a column', `/* ${macro} */`, 0],
        ['double-quoted literal cannot add a column', 'publish data where note="ALTER TABLE usr_lc_sample ADD new_col VARCHAR2(20)"', 0],
        ['modify is not an ADD', macro.replace('ADD_COLUMN', 'MODIFY_COLUMN_DATATYPE'), 0],
        ['native ADD', 'ALTER TABLE usr_lc_sample ADD new_col VARCHAR2(20);', 1],
        ['native ADD COLUMN documented', `ALTER TABLE usr_lc_sample ADD COLUMN new_col VARCHAR2(20);\n${documentation}`, 0],
        ['quoted native identifiers', `ALTER TABLE "USR_LC_SAMPLE" ADD "NEW_COL" NUMBER;\n${documentation}`, 0],
        ['qualified native table', `ALTER TABLE owner.usr_lc_sample ADD new_col NUMBER;\n${documentation}`, 0],
        ['multiple ADD columns and datatype commas', `ALTER TABLE usr_lc_sample ADD (new_col NUMBER(10,2), other_col VARCHAR2(20));\n${documentation}`, 1],
        ['ADD constraint is not a column', 'ALTER TABLE usr_lc_sample ADD CONSTRAINT sample_pk PRIMARY KEY (id);', 0],
        ['duplicate additions are reported once', `${macro}\n${macro}`, 1],
        ['old CREATE columns are not inferred as newly added', 'CREATE TABLE usr_lc_sample (id INT PRIMARY KEY);', 0]
    ]) test(id, () => {
        const result = only(ddl(source), 'database-added-column-documentation');
        assert.equal(result.length, count, JSON.stringify(result));
        result.forEach(issue => assert.equal(issue.severity, 0));
    });
    for (const [id, include, target, content, count] of [
        ['sibling .tdoc', '', 'Documentation/usr_lc_sample.tdoc', documentation, 0],
        ['sibling .doc', '', 'Documentation/usr_lc_sample.doc', documentation, 0],
        ['explicit relative include', '#include "column-notes.doc"', 'Tables/column-notes.doc', documentation, 0],
        ['header search in Documentation', '#include <column-notes.tdoc>', 'Documentation/column-notes.tdoc', documentation, 0],
        ['relative sibling Documentation', '#include "../Documentation/column-notes.doc"', 'Documentation/column-notes.doc', documentation, 0],
        ['wrong table cannot be borrowed', '', 'Documentation/usr_lc_sample.tdoc', documentation.replace('usr_lc_sample', 'usr_lc_other'), 1],
        ['commented include not followed', '/* #include <column-notes.doc> */', 'Documentation/column-notes.doc', documentation, 1],
        ['cannot leave DDL layer', '#include "../../outside.doc"', '../outside.doc', documentation, 1]
    ]) test(id, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moca-checklist-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const layer = path.join(root, 'les/db/ddl/lc');
        const file = path.join(layer, 'Tables/usr_lc_sample.tbl');
        const dependency = path.join(layer, target);
        fs.mkdirSync(path.dirname(dependency), { recursive: true });
        fs.writeFileSync(dependency, content);
        const result = rules.reviewDocument(doc(file, `${include}\n${macro}`));
        assert.equal(only(result, 'database-added-column-documentation').length, count);
    });
});

describe('checklist: duplicate CTL includes', () => {
    for (const [source, count] of [
        ['#include <base.h>\n#include <base.h>', 1],
        ['# include "base.h"\ninclude \'./base.h\'', 1],
        ['include sub/base.h\ninclude sub/base.h\ninclude sub/base.h', 2],
        ['#include <first/base.h>\n#include <second/base.h>', 0],
        ['#include <base.h>\n#include <Base.h>', 0],
        ['/* #include <base.h> */\n#include <base.h>', 0],
        ['/*\n#include <base.h>\n*/\n#include <base.h>', 0],
        ['publish data where note=\'\n#include <base.h>\n\'\n#include <base.h>', 0],
        ['#include <base.h>\r\n#include <base.h> -- explanation', 1]
    ]) test(source, () => {
        const issues = only(review('les/db/data/load/lc/safetoload/sample.ctl', source), 'ctl-duplicate-include');
        assert.equal(issues.length, count, JSON.stringify(issues));
        if (issues.length) { assert.equal(issues[0].line, source.split('\n').findLastIndex(line => line.includes('include')) + 1 - (count - 1)); }
    });
});

describe('checklist: CSV control flow', () => {
    for (const [source, count] of [
        ['if,description\n1,text\n', 1],
        ['action\nif (@x=1) { publish data where x=1 }\n', 1],
        ['action\n"IF (@x=1) {\n publish data where x=1\n} ELSE { publish data where x=2 }"\n', 1],
        ['action\nelse\n', 1],
        ['action\nelse if (@x) { publish data where x=1 }\n', 1],
        ['action\nelse publish data where x=1\n', 1],
        ['description\nuse if and else words in this sentence\n', 0],
        ['action\npublish data where msg=\'if (@x=1) else { }\'\n', 0],
        ['action\n/* if (@x=1) { } */ publish data where x=1\n', 0],
        ['action\npublish data where x=iif(@a=1,1,0)\n', 0],
        ['if_flag,elsewhere\n1,2\n', 0]
    ]) test(source, () => assert.equal(only(csv(source), 'csv-control-flow').length, count));
    test('diagnostics retain logical CSV row locations after multiline quoted fields', () => {
        const source = 'action\n"publish data where msg=\'first\nsecond\'"\nif (@x) { publish data where x=1 }\n';
        assert.equal(only(csv(source), 'csv-control-flow')[0].line, 4);
    });
});

describe('checklist: Configurable RF and job CSV', () => {
    for (const [id, source, table, count] of [
        ['RF global filled category', 'wh_id,category,mnu_grp\n----,CUSTOM,\n', 'usr_uc_rf_process', 1],
        ['RF global filled menu', 'wh_id,category,mnu_grp\n----,,MENU\n', 'usr_uc_rf_process', 1],
        ['RF menu_item alias', 'wh_id,category,menu_item\n----,,MENU\n', 'rf_config', 1],
        ['RF global empty', 'wh_id,category,mnu_grp\n----, , \n', 'usr_uc_rf_process', 0],
        ['specific warehouse not required to fill menu', 'wh_id,category,mnu_grp\nWH1,,\n', 'usr_uc_rf_process', 0],
        ['unrelated table', 'wh_id,category,mnu_grp\n----,CUSTOM,MENU\n', 'sample', 0]
    ]) test(id, () => assert.equal(only(csv(source, table), 'rf-global-menu-fields').length, count));
    test('unload RF keys are not treated as active menu configuration', () => {
        assert.equal(only(csv('wh_id,category,mnu_grp\n----,CUSTOM,MENU\n', 'usr_uc_rf_process', true), 'rf-global-menu-fields').length, 0);
    });
    for (const [id, source, count] of [
        ['missing hostname', 'job_id,log_file\nSAMPLE,$LESDIR/log/job.log\n', 1],
        ['braced hostname', 'job_id,log_file\nSAMPLE,$LESDIR/log/${HOSTNAME}_job.log\n', 0],
        ['unbraced hostname', 'job_id,logfile\nSAMPLE,$LESDIR/log/$HOSTNAME-job.log\n', 0],
        ['empty logfile', 'job_id,log_file\nSAMPLE,\n', 1],
        ['missing logfile column', 'job_id,command\nSAMPLE,process lc sample\n', 1],
        ['plain hostname is not a variable', 'job_id,log_file\nSAMPLE,$LESDIR/log/HOSTNAME_job.log\n', 1],
        ['no job rows', 'job_id,log_file\n', 0]
    ]) test(id, () => assert.equal(only(csv(source, 'job_definition'), 'job-logfile-hostname').length, count));
    test('unload job keys do not require logfile', () => assert.equal(only(csv('job_id\nSAMPLE\n', 'job_definition', true), 'job-logfile-hostname').length, 0));
});

describe('checklist: command reminders', () => {
    for (const [syntax, count] of [
        ["publish data where msg='Shipment' || @ship_id", 1],
        ["publish data where msg='Shipment ' || @ship_id || ' done'", 1],
        ["[select first_name || last_name value from sample_view]", 1],
        ["/* || */ publish data where msg='a || b'", 0],
        ['publish data where x=1 | publish data where y=2', 0]
    ]) test(`concat ${syntax}`, () => assert.equal(only(mcmd(syntax), 'string-concatenation-spacing').length, count));
    for (const [syntax, count] of [
        ['commit', 1], ['CoMmIt;', 1], ['{ commit }', 1], ['[commit]', 1],
        ['/* required */\ncommit', 0], ['-- safe transaction\ncommit', 0], ['commit /* safe */', 0],
        ['/* safe */ [commit]', 0], ['[/* safe */ commit]', 0], ['[commit /* safe */]', 0],
        ['/* old */ publish data where x=1 | commit', 1],
        ["publish data where msg='commit' /* commit */", 0], ['commit lc custom operation', 0]
    ]) test(`commit ${syntax}`, () => {
        const result = only(mcmd(syntax), 'commit-safety-comment');
        assert.equal(result.length, count);
        result.forEach(issue => assert.equal(issue.severity, 1));
    });
    for (const [syntax, count] of [
        ['[select /*+ INDEX(t) */ id from sample_view t]', 1],
        ['[select --+ INDEX(t)\n id from sample_view t]', 1],
        ['/* required */ [select /*+ INDEX(t) */ id from sample_view t]', 0],
        ['[select /* purpose */ /*+ INDEX(t) */ id from sample_view t]', 0],
        ['/* old */ publish data where x=1 | [select /*+ INDEX(t) */ id from sample_view t]', 1],
        ["[select '/*+ INDEX(t) */' text from sample_view]", 0],
        ['/* [select /*+ INDEX(t) */ publish data where x=1', 0]
    ]) test(`hint ${syntax}`, () => {
        const result = only(mcmd(syntax), 'optimizer-hint-comment');
        assert.equal(result.length, count);
        result.forEach(issue => assert.equal(issue.severity, 1));
    });
    for (const [literal, count] of [
        ['$LESDIR/files/shared/output.txt', 0], ['${LESDIR}/files/SHARED/output.txt', 0],
        ['/files/shared/output.txt', 0], ['C:\\files\\shared\\output.txt', 0],
        ['$LESDIR/files/output.txt', 1], ['/tmp/output.txt', 1], ['C:\\temp\\output.txt', 1],
        ['\\\\server\\folder\\file.txt', 1], ['/files/not_shared/output.txt', 1], ['/files/shared.txt', 1],
        ['http://example.invalid/files/data', 0], ['/', 0], ['DD/MM/YYYY', 0], ['relative/output.txt', 0]
    ]) test(`path ${literal}`, () => assert.equal(only(mcmd(`publish data where filename='${literal}'`), 'command-path-not-shared').length, count));
    test('comments and runtime-only path variables do not imply a known path', () => {
        assert.equal(only(mcmd("/* '/tmp/output' */ publish data where filename=@output_path"), 'command-path-not-shared').length, 0);
    });
    for (const syntax of [
        "publish data where script='/* dynamic command */ publish data where x=1'",
        "publish data where script='\n/* dynamic command */\npublish data where x=1'",
        "publish data where xpath='/root/item'",
        "publish data where xml_path='/root/item[@id]'"
    ]) test(`non-filesystem literal ${syntax}`, () => assert.equal(only(mcmd(syntax), 'command-path-not-shared').length, 0));
    for (const [syntax, count] of [
        ["publish data where filename='$LESDIR/files/shared' || '/output.txt'", 0],
        ["publish data where filename='$LESDIR/files/' || 'shared/' || 'output.txt'", 0],
        ["publish data where filename=@base_path || '/suffix.txt'", 0],
        ["publish data where filename='$LESDIR/files/' || @subdir || '/output.txt'", 1]
    ]) test(`path concatenation ${syntax}`, () => assert.equal(only(mcmd(syntax), 'command-path-not-shared').length, count));
});

describe('SQL XML XPath parameters are not filesystem directories', () => {
    for (const [id, syntax, expected] of [
        ['extractvalue XPath', "[select extractvalue(xmltype(@xml), '/Envelope/code') value from dual]", 0],
        ['nested XML input with commas', "[select extractvalue(xmltype(replace(@xml, 'x,y', 'z')), '/Envelope/code') value from dual]", 0],
        ['SYS-qualified XML function', "[select SYS . EXTRACTVALUE(xmltype(@xml), '/Envelope/code') value from dual]", 0],
        ['extract XPath', "[select extract(@xml, '/Envelope/code').getStringVal() value from dual]", 0],
        ['existsnode XPath', "[select existsnode(@xml, '/Envelope/code') value from dual]", 0],
        ['grouped XPath literal', "[select extractvalue(xmltype(@xml), (('/Envelope/code'))) value from dual]", 0],
        ['quoted punctuation inside XPath', `[select extractvalue(xmltype(@xml), '/Envelope/code[concat(")", ",")]') value from dual]`, 0],
        ['multiple XML expressions', "[select extractvalue(@xml, '/Envelope/a') a, extractvalue(@xml, '/Envelope/b') b from dual]", 0],
        ['comments do not change argument position', "[select extractvalue(xmltype(@xml) /* comma , close ) */, /* XPath */ '/Envelope/code') value from dual]", 0],
        ['first argument is not a XPath exemption', "[select extractvalue('/tmp/document.xml', '/Envelope/code') value from dual]", 1],
        ['third argument is not a XPath exemption', "[select extractvalue(@xml, '/Envelope/code', '/tmp/namespace') value from dual]", 1],
        ['different function is not exempt', "[select extractvalue_file(@xml, '/tmp/document.xml') value from dual]", 1],
        ['unknown qualified function is not exempt', "[select custom_pkg.extractvalue(@xml, '/tmp/document.xml') value from dual]", 1],
        ['nested file read inside XPath still checked', "[select extractvalue(@xml, read_file('/tmp/xpath.txt')) value from dual]", 1],
        ['normal SQL path after XML expression', "[select extractvalue(@xml, '/Envelope/code') value, '/reports/logo.pof' logo from dual]", 1],
        ['normal SQL path without XML function', "[select '/reports/logo.pof' logo from dual]", 1],
        ['MOCA path following XML SQL still checked', "[select extractvalue(@xml, '/Envelope/code') value from dual] | publish data where logo='/reports/' || @logo", 1],
        ['reports remains a filesystem path', "publish data where logo='/reports/' || @logo", 1],
        ['XML-looking MOCA expression is not SQL', "publish data where value=extractvalue(@xml, '/tmp/document.xml')", 1],
        ['function name inside a literal cannot exempt another value', "[select 'extractvalue(' text, '/reports/logo.pof' logo from dual]", 1],
        ['function name inside a comment cannot exempt another value', "[select /* extractvalue(@xml, */ '/reports/logo.pof' logo from dual]", 1]
    ]) test(id, () => {
        const issues = only(mcmd(syntax), 'command-path-not-shared');
        assert.equal(issues.length, expected, JSON.stringify(issues));
        for (const issue of issues) { assert.equal(issue.severity, 1); }
    });
    for (const [relative, rule, expected] of [
        ['swift-isc-customisations-au02/les/src/cmdsrc/lcint/parse_lc_au02_sf_webservice_response.mcmd', 'command-path-not-shared', 0],
        ['swift-isc-customisations-au02/les/src/cmdsrc/lcint/parse_lc_gama_sf_webservice_response.mcmd', 'command-path-not-shared', 0],
        ['swift-isc-customisations-au02/les/src/cmdsrc/lcint/list_lc_packing_slip.mcmd', 'command-path-not-shared', 1],
        ['swift-isc-customisations-in02/les/src/cmdsrc/lcint/list_lc_packing_sscc_label_order_note_fields.mcmd', 'list-no-execute-command', 1]
    ]) {
        const file = path.join('D:/workspace', relative);
        test(`read-only acceptance: ${relative}`, { skip: !fs.existsSync(file) }, () => {
            const source = fs.readFileSync(file, 'utf8');
            const result = only(rules.reviewDocument(doc(file, source)), rule);
            assert.equal(result.length, expected);
            result.forEach(issue => assert.equal(issue.severity, rule === 'list-no-execute-command' ? 0 : 1));
        });
    }
});

describe('checklist: single value list naming', () => {
    for (const [id, query, count] of [
        ['one row one column', 'select id from sample_view where rownum < 2', 1],
        ['equality', 'SELECT id FROM sample_view WHERE ROWNUM = 1', 1],
        ['function commas are not fields', 'select nvl(id,0) value from sample_view where state=@state and rownum=1', 1],
        ['quoted alias comma', 'select id as "id,value" from sample_view where rownum=1', 1],
        ['literal comma', "select 'a,b' value from sample_view where rownum=1", 1],
        ['parenthesized AND guard', 'select id from sample_view where (state=@state or state=@other) and (rownum=1)', 1],
        ['OR both branches guarded', 'select id from sample_view where (state=@state and rownum=1) or (state=@other and rownum<2)', 1],
        ['wildcard', 'select * from sample_view where rownum=1', 0],
        ['qualified wildcard', 'select s.* from sample_view s where rownum=1', 0],
        ['two fields', 'select id,name from sample_view where rownum=1', 0],
        ['no explicit limit', 'select id from sample_view', 0],
        ['other limit not requested', 'select id from sample_view where rownum<=1', 0],
        ['unbounded OR', 'select id from sample_view where rownum=1 or state=@state', 0],
        ['nested rownum cannot limit outer query', 'select id from sample_view where exists (select 1 from other_view where rownum=1)', 0],
        ['predicate literal not executable', "select id from sample_view where state='rownum=1'", 0],
        ['predicate comment not executable', 'select id from sample_view where state=@state /* rownum=1 */', 0],
        ['UNION can return two rows', 'select id from sample_view where rownum=1 union select id from other_view where rownum=1', 0],
        ['ROWNUM expression is not a one-row guard', 'select id from sample_view where rownum=1+@step', 0],
        ['CTE outer one-row shape', 'with x as (select id,name from sample_view) select id from x where rownum=1', 1],
        ['scalar subquery remains one output expression', 'select (select id from other_view) value from sample_view where rownum=1', 1]
    ]) test(id, () => {
        const result = only(mcmd(`[${query}] catch(-1403)`, 'list lc probe'), 'list-single-value-use-get');
        assert.equal(result.length, count, JSON.stringify(result));
        result.forEach(issue => assert.equal(issue.severity, 1));
    });
    test('get command is already correctly named', () => assert.equal(only(mcmd('[select id from sample_view where rownum=1]', 'get lc probe'), 'list-single-value-use-get').length, 0));
    test('multiple lookups do not imply the final command result', () => assert.equal(only(mcmd('[select id from sample_view where rownum=1] | [select name from sample_view]', 'list lc probe'), 'list-single-value-use-get').length, 0));
    test('other command calls do not imply the final result', () => assert.equal(only(mcmd('[select id from sample_view where rownum=1] | list lc more rows', 'list lc probe'), 'list-single-value-use-get').length, 0));
});

describe('checklist: read-only devin02 acceptance samples', () => {
    const root = process.env.DEVIN02_ROOT || 'D:/workspace/devin02';
    for (const [relative, rule, count] of [
        ['les/db/ddl/lc/Tables/usr_lc_inb_shp_upload_data.tbl', 'database-added-column-documentation', 0],
        ['les/db/data/load/lc/safetoload/usr_uc_rf_process/lc_usr_uc_rf_process_SWIFTLEX-60987.csv', 'rf-global-menu-fields', 0],
        ['les/db/data/load/lc/bootstraponly/job_definition/lc_job_definition_SWIFTLEX-60987.csv', 'job-logfile-hostname', 1]
    ]) test(relative, { skip: !fs.existsSync(path.join(root, relative)) }, () => {
        const file = path.join(root, relative), text = fs.readFileSync(file, 'utf8');
        assert.equal(only(rules.reviewDocument(doc(file, text)), rule).length, count);
    });
});
