'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../out/extension.js').__test;

function documentOf(fileName, text) {
    return { fileName, getText: () => text };
}

function ids(issues) {
    return issues.map(issue => issue.rule);
}

function fileFor(name) {
    return `D:\\workspace\\fixtures\\${name.replace(/ /g, '_')}.mcmd`;
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

function reviewMcmd(name, syntax) {
    return rules.performMcmdReview(documentOf(fileFor(name), mcmd(name, syntax)));
}

describe('U-03 Groovy detection', () => {
    test('rejects Groovy embedded in Local Syntax', () => {
        const result = reviewMcmd('process lc sample', 'groovy.lang.Closure');
        assert.ok(ids(result).includes('no-groovy'));
    });
});

describe('U-06 copy markers', () => {
    test('rejects a Start marker without an End marker', () => {
        const syntax = '/* Start copy from Core list usr sample */\npublish data where value = 1';
        assert.ok(ids(reviewMcmd('process lc sample', syntax)).includes('copy-marker-missing-end'));
    });

    test('rejects an End marker without a Start marker', () => {
        const syntax = '/* End copy from Core list usr sample */\npublish data where value = 1';
        assert.ok(ids(reviewMcmd('process lc sample', syntax)).includes('copy-marker-missing-start'));
    });

    test('accepts a paired Start/End pair', () => {
        const syntax = [
            '/* Start copy from Core list usr sample */',
            'publish data where value = 1',
            '/* End copy from Core list usr sample */'
        ].join('\n');
        const result = ids(reviewMcmd('process lc sample', syntax));
        assert.ok(!result.includes('copy-marker-missing-start'));
        assert.ok(!result.includes('copy-marker-missing-end'));
    });
});

describe('U-07 Plugin Local Customisation references', () => {
    test('rejects usr_lc_ references in pd commands', () => {
        const result = reviewMcmd('list pd sample', '[select * from usr_lc_sample_view]');
        assert.ok(ids(result).includes('plugin-references-local-customisation'));
    });

    test('accepts lc commands referencing usr_lc_', () => {
        const result = reviewMcmd('list lc sample', '[select * from usr_lc_sample_view]');
        assert.ok(!ids(result).includes('plugin-references-local-customisation'));
    });

    test('ignores Local Customisation references that appear only in comments', () => {
        const syntax = '/* historical usr_lc_table reference */\npublish data where value = 1';
        assert.ok(!ids(reviewMcmd('process pd sample', syntax)).includes('plugin-references-local-customisation'));
    });
});

describe('U-11 sysdate alias', () => {
    test('rejects select sysdate from dual without an alias', () => {
        const result = reviewMcmd('list lc current time', '[select sysdate from dual]');
        assert.ok(ids(result).includes('sysdate-missing-alias'));
    });

    test('accepts select sysdate as "sysdate" from dual', () => {
        const result = reviewMcmd('list lc current time', '[select sysdate as "sysdate" from dual]');
        assert.ok(!ids(result).includes('sysdate-missing-alias'));
    });
});

describe('U-12 validate key existence', () => {
    test('warns on select \'x\' from a single view', () => {
        const result = reviewMcmd('validate lc sample', "[select 'x' from sample_view]");
        assert.ok(ids(result).includes('prefer-validate-key-exists'));
    });
});

describe('U-13 DISTINCT with ROWNUM', () => {
    test('rejects DISTINCT plus ROWNUM in one SQL block', () => {
        const result = reviewMcmd('list lc sample', '[select distinct col from sample_view where rownum = 1]');
        assert.ok(ids(result).includes('distinct-rownum-conflict'));
    });
});

describe('U-14/U-15 :raw handling', () => {
    test('warns on every :raw and adds raw-in-select for SELECT lists', () => {
        const result = reviewMcmd('list lc sample', '[select @field:raw col from sample_view]');
        assert.ok(ids(result).includes('raw-usage'));
        assert.ok(ids(result).includes('raw-in-select'));
    });

    test('warns on :raw outside the SELECT list without raw-in-select', () => {
        const result = reviewMcmd('list lc sample', '[select col from sample_view where col = @value:raw]');
        assert.ok(ids(result).includes('raw-usage'));
        assert.ok(!ids(result).includes('raw-in-select'));
    });
});

describe('U-16 nobind/bind pairing', () => {
    test('accepts concatenation wrapped in nobind/bind', () => {
        const result = reviewMcmd('list lc sample', "[select col from sample_view where /*#nobind*/ col like '%' || @prefix || '%' /*#bind*/]");
        assert.ok(!ids(result).includes('nobind-bind-unbalanced'));
        assert.ok(!ids(result).includes('nobind-bind-required'));
    });

    test('rejects an unclosed nobind marker', () => {
        const result = reviewMcmd('list lc sample', '[select col from sample_view where /*#nobind*/ col = @value]');
        assert.ok(ids(result).includes('nobind-bind-unbalanced'));
    });

    test('rejects bind concatenation without markers', () => {
        const result = reviewMcmd('list lc sample', "[select col from sample_view where col like '%' || @value || '%']");
        assert.ok(ids(result).includes('nobind-bind-required'));
    });
});

describe('U-17 prtdsc.colval', () => {
    test('accepts prtdsc.colval wrapped in nobind/bind', () => {
        const sql = '[select inv.prtnum from prtdsc /*#nobind*/ join sample_view v on v.id = inv.id where prtdsc.colval = inv.prtnum || \'|\' || inv.wh_id /*#bind*/]';
        assert.ok(!ids(reviewMcmd('list lc sample', sql)).includes('prtdsc-nobind-bind'));
    });

    test('rejects prtdsc.colval without nobind/bind', () => {
        const sql = "[select prtdsc.colval from prtdsc where prtdsc.colval = x || '|' || y]";
        assert.ok(ids(reviewMcmd('list lc sample', sql)).includes('prtdsc-nobind-bind'));
    });
});

describe('U-18 timestamp expressions', () => {
    test('rejects complex cast/from_tz without nobind/bind', () => {
        const sql = '[select cast(from_tz(cast(to_date(txt) as timestamp), sessiontimezone) at time zone zone as date) d from sample_view]';
        assert.ok(ids(reviewMcmd('list lc sample', sql)).includes('timestamp-nobind-bind'));
    });
});

describe('U-19 get session variable', () => {
    test('accepts catch or nvl defaulting', () => {
        const syntax = "get session variable where name = 'x' catch(-1403)\n|\npublish data where value = nvl(@value, 0)";
        assert.ok(!ids(reviewMcmd('process lc sample', syntax)).includes('session-variable-uncaptured'));
    });

    test('warns when @value is used without catch or default', () => {
        const syntax = "get session variable where name = 'x'\n|\npublish data where value = @value";
        assert.ok(ids(reviewMcmd('process lc sample', syntax)).includes('session-variable-uncaptured'));
    });
});

describe('U-20 execute server command quotes', () => {
    test('accepts balanced single quotes', () => {
        const syntax = "execute server command where cmd = 'publish data where value = ' || @res_str";
        assert.ok(!ids(reviewMcmd('process lc sample', syntax)).includes('execute-server-command-quotes'));
    });

    test('warns on an unbalanced single-quoted parameter', () => {
        const syntax = "execute server command where cmd = 'it's'";
        assert.ok(ids(reviewMcmd('process lc sample', syntax)).includes('execute-server-command-quotes'));
    });

    test('checks multiline execute server command arguments', () => {
        const syntax = "execute server command\n where cmd = 'it's'\n   and inline = 0";
        assert.ok(ids(reviewMcmd('process lc sample', syntax)).includes('execute-server-command-quotes'));
    });
});

describe('U-21 send email defaults', () => {
    test('rejects hardcoded default mail_from', () => {
        const syntax = "send email where send_to = @mail_to and mail_from = nvl(@mail_from, 'swiftlog.donotreply@Kuehne-Nagel.com')";
        assert.ok(ids(reviewMcmd('process lc sample', syntax)).includes('send-email-hardcoded-config'));
    });

    test('accepts send email without hardcoded defaults', () => {
        const syntax = 'send email where send_to = @mail_to and subject = @subject';
        assert.ok(!ids(reviewMcmd('process lc sample', syntax)).includes('send-email-hardcoded-config'));
    });

    test('rejects multiline hardcoded mail defaults', () => {
        const syntax = [
            'send email',
            ' where send_to = @mail_to',
            "   and mail_from = nvl(@mail_from, 'swiftlog.donotreply@Kuehne-Nagel.com')"
        ].join('\n');
        assert.ok(ids(reviewMcmd('process lc sample', syntax)).includes('send-email-hardcoded-config'));
    });
});
