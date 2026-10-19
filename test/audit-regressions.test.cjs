'use strict';
const {describe,test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const rules=require('../out/extension.js').__test;
const cases=require('./fixtures/audit-cases.json');
const write=(root,name,text)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};

describe('workspace audit counterexamples',()=>{
    for(const sample of cases){
        test(sample.id,()=>{
            const root=fs.mkdtempSync(path.join(os.tmpdir(),'moca-audit-test-'));
            const file=write(root,sample.file,sample.source);
            if(sample.id.startsWith('D05'))write(root,'les/db/data/load/lc/safetoload/usr_lc_orca_tables/lc_registration.csv','table_name\nusr_lc_registered\n');
            if(sample.id.startsWith('D06'))write(root,'les/db/ddl/lc/indexunload/drop_index.sql','/* DROP INDEX usr_lc_sample_idx */');
            if(sample.id.startsWith('L04'))write(root,'les/db/data/unload/lc/safetoload/sample/lc_sample_SWIFTLEX-123.csv','id\n1\n');
            assert.ok(rules.getReviewKind(file),'Fixture must not be in an excluded directory');
            const issues=rules.reviewDocument({fileName:file,getText:()=>sample.source,workspaceRoot:root});
            const matches=issues.filter(issue=>issue.rule===sample.rule);
            assert.equal(matches.length>0,sample.expected,JSON.stringify(issues));
            for(const issue of matches){assert.ok(issue.line>=1&&issue.line<=sample.source.split('\n').length);assert.ok(issue.column>=1);}
        });
    }
});

function gitFixture(){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'moca-audit-git-'));
    const git=(...args)=>execFileSync('git',['-c','user.name=Audit','-c','user.email=audit@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:'pipe',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
    git('init','--initial-branch=develop');
    write(root,'les/src/cmdsrc/lcint/list_lc_base.mcmd','<command/>');git('add','.');git('commit','-m','seed');
    return {root,git};
}
test('G01: merge-only Ticket uses first-parent changes, excluding unrelated parent files',async()=>{
    const {root,git}=gitFixture();
    git('switch','-c','merge-probe');write(root,'les/src/cmdsrc/lcint/list_lc_merged.mcmd','<command/>');git('add','.');git('commit','-m','feature body without Ticket');
    git('switch','develop');write(root,'les/src/cmdsrc/lcint/list_lc_unrelated.mcmd','<command/>');git('add','.');git('commit','-m','unrelated work');
    git('merge','--no-ff','merge-probe','-m','SWIFTLEX-998877 merge');
    assert.deepEqual(await rules.getGitChangedFiles('SWIFTLEX-998877',root),['les/src/cmdsrc/lcint/list_lc_merged.mcmd']);
});
test('G02: Git paths retain Unicode, spaces and literal rename arrows',async()=>{
    const {root,git}=gitFixture();
    const names=['les/db/data/load/lc/safetoload/sample/lc_客户 data.csv','les/db/data/load/lc/safetoload/sample/lc_space name.csv'];
    assert.deepEqual(rules.parseGitStatusPaths('?? literal -> name.csv\0'),['literal -> name.csv']);
    for(const name of names)write(root,name,'id\n1\n');
    assert.deepEqual((await rules.getGitChangedFiles('NO-MATCH',root)).sort(),names.sort());
    git('add','.');git('commit','-m','add fixtures');
    const renamed='les/src/cmdsrc/lcint/list_lc_new.mcmd';git('mv','les/src/cmdsrc/lcint/list_lc_base.mcmd',renamed);
    assert.deepEqual(await rules.getGitChangedFiles('NO-MATCH',root),[renamed]);
});

describe('audit repair boundary controls',()=>{
    const source=syntax=>`<command><name>list lc probe</name><description>probe</description><type>Local Syntax</type><local-syntax><![CDATA[${syntax}]]></local-syntax></command>`;
    const review=syntax=>rules.reviewDocument({fileName:path.join(os.tmpdir(),'list_lc_probe.mcmd'),getText:()=>source(syntax)});
    for(const [sql,unsafe]of [
        ['a/(nullif(b,0)*c)',true],
        ['a/decode(b,0,null,1,0,b)',true],
        ['a/decode(b,0,null,1,1,b)',false],
        ['a/decode(b,0,1,b)',false],
        ['a/decode(nvl(b,0),0,1,b)',false],
        ['a/decode(b,0,other_quantity,b)',false],
        ['a/(((nullif(b,0))))',false],
        ['case when b=0 or x=0 then 0 else a/b end',false],
        ['case when b=0 and x=0 then 0 else a/b end',true],
        ['case when b<>0 and x=1 then a/b else 0 end',false],
        ['case when b<>0 or x=1 then a/b else 0 end',true],
        ['case when b=0 then 0 else 1 end + a/b',true]
    ])test(`zero guard: ${sql}`,()=>assert.equal(review(`[select ${sql} value from sample_view]`).some(x=>x.rule==='division-zero-guard'),unsafe));

    test('only real parameter names and marker comments affect their rules',()=>{
        assert.ok(!review("get session variable list where name='items'").some(x=>x.rule==='session-variable-uncaptured'));
        assert.ok(!review('send email where body="mail_from=\'sample@example.invalid\'"').some(x=>x.rule==='send-email-hardcoded-config'));
        assert.ok(!review("[select '/*#nobind*/' text from sample_view] /* prtdsc.colval */").some(x=>['prtdsc-nobind-bind','nobind-bind-unbalanced'].includes(x.rule)));
        assert.ok(!review('/* No existing MOCA list command, use select statement instead. */\n/* separate explanation */\n[select id from sample_view]').some(x=>x.rule==='select-missing-comment'));
    });
    test('policy supports inverted conditions and pure policy setup, but no unguarded tail',()=>{
        const original='^process inventory move';
        for(const [body,invalid]of [
            [`list policies catch(-1403) | if (@?!=0) {${original}} else {publish data where x=1}`,false],
            [`list policies catch(-1403) | publish data where enabled=decode(@?,0,1,0) | if (@enabled!=1) {${original}} else {publish data where x=1}`,false],
            [`list policies catch(-1403) | if (@?=0) {publish data where x=1} | ${original}`,false],
            [`list policies catch(-1403) | if (@?=0) {publish data where x=1} else {${original}} | publish data where outside=1`,true],
            [`list policies catch(-1403) | if (@?=0) {publish data where x=1} else {${original} | [update sample set x=1]}`,true]
        ]){
            const text=source(body).replace('<name>list lc probe</name>','<name>process inventory move</name>');
            const issues=rules.reviewDocument({fileName:path.join(os.tmpdir(),'process_inventory_move.mcmd'),getText:()=>text});
            assert.equal(issues.some(x=>x.rule==='by-command-policy'),invalid,body);
        }
    });
    test('poldat always warns, while its required reason independently controls Error',()=>{
        for(const join of ['', ' join sample_view v on v.id=p.id']){
            for(const reason of ['', ' Use poldat instead of poldat_view for performance.']){
                const issues=review(`/* No existing MOCA list command, use select statement instead.${reason} */ [select p.id from poldat p${join}]`);
                assert.ok(issues.some(x=>x.rule==='select-from-non-view'&&x.severity===1));
                assert.equal(issues.some(x=>x.rule==='select-from-non-view-missing-comment'),!reason);
            }
        }
    });
    test('index unload must be an executable statement and is reread after edits',()=>{
        const root=fs.mkdtempSync(path.join(os.tmpdir(),'moca-index-test-'));
        const file=write(root,'les/db/ddl/lc/Indexes/usr_lc_probe_idx.idx','[CREATE_INDEX_BEGIN(by_table,usr_lc_probe_idx) CREATE_INDEX_END]');
        const unload='les/db/ddl/lc/indexunload/drop.sql';
        for(const [code,missing]of [["select 'DROP INDEX usr_lc_probe_idx'",true],['DROP INDEX usr_lc_probe_idx_old',true],['DROP INDEX "usr_lc_probe_idx"',false]]){
            write(root,unload,code);
            const issues=rules.reviewDocument({fileName:file,getText:()=>fs.readFileSync(file,'utf8'),workspaceRoot:root});
            assert.equal(issues.some(x=>x.rule==='index-unload-missing'),missing,code);
        }
    });
    test('DDL string values cannot impersonate primary-key definitions',()=>{
        const fileName=path.join(os.tmpdir(),'les/db/ddl/lc/Tables/usr_lc_probe.tbl');
        const text="CREATE TABLE usr_lc_probe (id NUMBER, note VARCHAR(40) DEFAULT 'PRIMARY KEY')";
        assert.ok(rules.reviewDocument({fileName,getText:()=>text}).some(x=>x.rule==='database-table-missing-primary-key'));
    });
    test('sequence can use an enclosing group catch, but not comments or sibling catches',()=>{
        const fileName=path.join(os.tmpdir(),'les/db/ddl/lc/Sequences/usr_lc_seq.seq');
        for(const [text,missing]of [['{ [CREATE SEQUENCE usr_lc_seq START WITH 1] } catch(-955, -1)',false],['#define SEQ usr_lc_seq\n[CREATE_SEQUENCE(SEQ,1,1,100)] catch(-955)',false],['[CREATE SEQUENCE usr_lc_seq START WITH 1] | publish data catch(-955)',true]]){
            assert.equal(rules.reviewDocument({fileName,getText:()=>text}).some(x=>x.rule==='database-sequence-not-idempotent'),missing);
        }
    });
    test('postinstall distinguishes echo/cat text from actual moca invocations',()=>{
        const root=fs.mkdtempSync(path.join(os.tmpdir(),'moca-install-test-'));
        write(root,'les/db/data/unload/lc/safetoload/sample/lc_sample_SWIFTLEX-1.csv','id\n1\n');
        const fileName=path.join(root,'rpmbuild/app/postinstall/allnodes/isccustom.sh');
        for(const [text,missing]of [["echo 'mload_all unload'",true],['cat <<EOF\nmload_all unload\nEOF',true],["moca -e 'mload_all unload'",false],['moca <<EOF\nmload_all unload\nEOF',false]]){
            assert.equal(rules.reviewDocument({fileName,getText:()=>text,workspaceRoot:root}).some(x=>x.rule==='postinstall-mload-all-missing'),missing,text);
        }
    });
    test('rpt_id cannot be borrowed from another parameter string',()=>{
        const fileName=path.join(os.tmpdir(),'les/reports/Report.jrxml');
        const text='<jasperReport><parameter name="rpt_id"/><parameter name="other" value="rpt_id=Wrong"/></jasperReport>';
        assert.ok(!rules.reviewDocument({fileName,getText:()=>text}).some(x=>x.rule==='rpt-id-mismatch'));
    });
});
