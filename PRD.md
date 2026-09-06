# Code Reviewer 需求文档

## 1. 目标与范围

本插件用于在 VS Code 中审查 JDA/Blue Yonder MOCA 本地客制化代码，并将审查结果展示在 Problems 面板中。

本期审查范围：

- Command：`.mcmd` 命令文件以及与命令相关的 `.mtrg` trigger 文件。
- Database 对象：table creation script、index 及对应 unload DDL 等相关文件。
- CSV：`.csv`、对应的 `.ctl` 以及 Config Action 数据文件。
- Report/Label：`.jrxml` 报表及 `.pof` Label 文件。
- Git 分支名和按 Jira Ticket 筛选变更文件的审查流程。

### 1.1 文件和目录范围

- Table creation script：`les/db/ddl/lc/Tables`，以及插件仓库的 `les/db/ddl/pd/**/Tables`。
- Index：`les/db/ddl/lc/Indexes`，以及插件仓库的 `les/db/ddl/pd/**/Indexes`。
- Sequence：`les/db/ddl/*/Sequences`。
- Unload DDL/Data：以原 load 文件的相对路径为基准，将路径段 `les/db/data/load` 替换为 `les/db/data/unload`，其余目录保持一致。例如：
  - Load：`les/db/data/load/integrator/lc/loadmain`
  - Unload：`les/db/data/unload/integrator/lc/loadmain`
- Config Action：`les/db/data/load/lc/safetoload/lc-config_actions`。
- Label：`les/labels/z140xiII`，文件扩展名为 `.pof`。
- Archive/Purge job 不纳入本阶段新增文件扫描范围；已有检查逻辑保持不变。
- 扫描时排除明显不属于交付源码的目录，例如 `.git`、`node_modules`、`out` 和 `dist`，避免检查依赖、编译产物或重复副本。

### 1.2 本阶段检查边界

- 插件只实现能够根据当前文件内容、文件路径或工作区内明确依赖关系确定结果的规则。
- 依赖人工判断或外部证据的项目不由插件检测，包括 QA/技术授权、SQL 性能结论、`DBMS_XPLAN` 结果、代表性数据测试、DBA/IT Operations 批准等。
- 规则要求存在说明注释时，插件只检查注释格式是否存在，不评价注释内容质量。注释必须与对应 SQL block 紧邻，中间不得出现其他可执行语句；空泛或复制得到的注释（例如 `/* required */`）也视为满足格式要求。
- 所有 `[select ...]` 都必须有紧邻注释，注释应包含 `/* No existing MOCA list command, use select statement instead. */`，说明为什么不用 MOCA list command。该注释不能替代非 View 说明：同一个 SELECT 没有使用任何 `_view`、而是直接访问物理表时，紧邻注释还必须明确提到 `view`/`_view` 并说明不使用 View 的原因；两项说明可以写在同一个注释块中。同一 SELECT 已使用 `_view` 表时，其他非 View 表不再报 Warning/Error。缺少所需说明时报告 Warning 并额外报告 `[Error]`。

问题级别：

- `[Error]`：违反强制规范，本次审查不通过。
- `[Warning]`：警示或人工关注项，不阻止审查通过，也不因存在注释或授权而自动消除。

规则来源：

- 项目现有需求及 README。
- `PR creation check list V2026.1.docx`。
- `SwiftLOG Solutions - QA Validation Notes` Wiki 页面；来自该页面的新增规则保留 `AC-*` 或 `OT-*` 编号，便于追溯。

同一含义的规则只保留一条；新来源为现有规则增加条件时，应合并到原规则中。

## 2. Command 相关

### 2.1 `.mcmd` 文件结构

`.mcmd` 是 MOCA command 文件，标准结构如下：

```xml
<command>
    <name>命令名称</name>
    <description>命令描述</description>
    <type>命令类型</type>

    <local-syntax>
        <![CDATA[
        /* SQL 或 MOCA 代码 */
        ]]>
    </local-syntax>

    <documentation>
        <remarks>
        <![CDATA[
            详细说明...
        ]]>
        </remarks>
    </documentation>
</command>
```

- [Error] 缺少 `<name>` 标签。
- [Error] 缺少 `<description>` 标签。
- [Error] 缺少 `<type>` 标签。
- [Error] 缺少 `<local-syntax>` 标签或 CDATA 块；`<type>` 为 `java method` 时除外。

### 2.2 Command 命名

- [Error] `<name>` 不能为空，不允许首尾空格、Tab 或换行；单词之间只能使用一个 ASCII 空格。
- [Error] `<name>` 只能包含小写英文字母、数字和单个 ASCII 空格，不能包含大写字母或其他特殊字符。
- [Error] `.mcmd` 文件 basename 不能为空，只能包含小写英文字母、数字和下划线 `_`，不允许任何空白字符；`.mtrg` 的完整命名规则本阶段不新增，仅执行首尾空白、Tab、换行和大写字母检查。
- [Warning] `<name>` 必须与文件 basename 对应；将 `<name>` 中的单个空格替换为下划线 `_` 后，应与去掉扩展名的文件名完全一致。
- Command 层级按名称分词后的第二个单词判定，第一个单词不限制：
  - 第二个单词是 `lc`：Local Customisation/lcint。
  - 第二个单词是 `usr`：Core 层级。
  - 第二个单词是 `pd`：Plugin 层级。
  - 第二个单词不是 `lc`、`usr`、`pd`：BY 标准 command。
- [Error] `lc`、`usr` 或 `pd` 作为独立层级标识出现时，必须位于第二个单词；出现在其他位置不合法。

### 2.3 Command 和 Trigger 约束

- [Error] 不允许在 MOCA Local Syntax 中嵌入 Groovy；原有 Groovy 逻辑应迁移为 Java class，并通过 `java method` 类型的 MOCA command 调用。（AC-19）
- Override 调用定义为在 command 前使用 `^` 调用原层级 command，例如 `^list usr ...`。Override 目标层级按 `^` 后 command name 的第二个单词分类：
  - `lc`：Local Customisation command，允许自由 override，不产生诊断。
  - `usr`：Core command；检测到 override 时报告 `[Warning]`。
  - `pd`：Plugin command；检测到 override 时报告 `[Warning]`。
  - 无 `lc`/`usr`/`pd` 第二单词：BY 标准 command，允许 override 或增加 trigger，但被调用/覆盖的客制化入口 command 必须有 policy 开关。
- [Error] BY 标准 command 的客制化入口中，去除注释和空白后的第一段可执行逻辑必须是 policy 检查；policy 必须包围全部客制化逻辑，并在关闭路径调用 `^<原 BY command>`。缺少前置 policy 或无法通过一个 policy 关闭全部客制化逻辑时不合法。
- [Error] `.mtrg` 的 `<local-syntax>` 去除注释和字符串字面量后，只能包含一个 MOCA command 调用；该调用可以附带 `catch(...)`。（AC-5）
- [Error] Trigger 中不允许出现额外的 `publish data`、`if/else` 或其他业务逻辑，也不允许通过管道 `|` 或分号 `;` 连接多个语句；单个 command 末尾的终止分号不视为多语句。
- Local Customisation/lcint 层级允许新增 trigger。对 BY command 新增 trigger 时，policy 开关应实现在 trigger 唯一调用的客制化入口 command 中。
- [Warning] 复制 BY、Core 或 Plugin 代码时，复制区域必须使用以下注释明确标出来源命令和起止位置：
  - `/* Start copy from BY/Core/Plugin <command> */`
  - `/* End copy from BY/Core/Plugin <command> */`（AC-12）
- [Error] 如果对复制代码中的某个 SQL 做了任何修改，则整个 SQL 都必须符合当前规范，不能只检查修改的行。
- [Error] Plugin 中不得直接引用 Local Customisation 层级的 artifact、表名或其版本，因为安装 Plugin 时这些对象可能尚不存在，实际名称也可能不同。Plugin 必须在自身配置表中提供默认 artifact 名称；Local Customisation 如需覆盖，应通过本层级的 `.ctl`/`.csv` 和 `mload_all` 写入配置。（AC-30）
  - 配置记录至少应能区分 artifact type/id、artifact name 和优先层级；调用方按优先层级选择生效记录。
  - Wiki 示例中 Plugin 默认记录使用较低层级，Local Customisation CSV 使用较高层级覆盖；具体数值属于项目配置，不应硬编码为通用规则。

### 2.4 SQL 复杂度和职责

Complex SQL 按整个 `.mcmd` 统计，而不是分别按单个 `[...]` block 统计。统计前必须移除 XML/MOCA/SQL 注释和字符串字面量中的关键字，避免误计数。

整个 `.mcmd` 满足任一条件时视为 complex SQL：

- 多个彼此独立、每个都不复杂的 `SELECT` 不因数量单独触发 complex SQL；复杂判定以 JOIN/UNION 事件、子查询数量和表引用次数为准。主查询加一个子查询仍会通过子查询/表引用维度的计数参与判断。
- `JOIN` 与 `UNION` 事件合计达到 2 次及以上；例如 1 个 `JOIN` 加 1 个 `UNION` 即为 complex SQL。`UNION ALL` 整体只算 1 个 `UNION` 事件。
- 出现 2 个及以上子查询。
- 表引用次数超过 2 次。每一个 `FROM`/`JOIN` relation source 计 1 次，包括逗号分隔的表、base table、CTE name、derived table 和 `dual`；CTE/子查询内部 `FROM`/`JOIN` 的表也分别计数。同一物理表使用两个 alias 视为 2 次表引用，而不是去重为 1 个表。

对应规则：

- [Error] Complex SQL 只能放在 `<name>` 第一个单词为 `list` 或 `get` 的独立 command 中。
- 所有 `[select ...]` 都必须有紧邻注释，注释应为 `/* No existing MOCA list command, use select statement instead. */`，说明为什么不用 MOCA list command；插件不检查是否应复用为简单 command。

### 2.5 SQL 使用规范

- 以下 SQL 规则只分析 MOCA `[...]` 内的实际 SQL；注释和字符串字面量中的关键字、运算符不参与判断。
- [Warning] 使用 `INSERT`、`UPDATE` 或 `DELETE` 时始终报告 Warning。DML 目标是物理表，不执行 `_view` 检查。SQL 必须有紧邻注释并明确提到对应的现有 command，说明为什么不能使用它：INSERT 对应 `create record`，UPDATE 对应 `change record`，DELETE 对应 `remove record`；例如 mass update、更新主键或先查询 key 会造成性能问题。只有普通注释、但没有提到对应 command 时仍视为缺少说明，并额外报告 `[Error]`。
- [Error] `list`/`get` command 不允许包含任何新增、修改或删除数据库数据的逻辑，包括 `INSERT`、`UPDATE`、`DELETE`。（AC-14）
- [Error] 禁止 `IN (SELECT ...)` 形式的子查询，必须改用 `EXISTS`。
- 小型静态值列表允许使用 `IN`，例如 `IN ('A', 'B')`，不产生诊断。
- [Error] SELECT 子句中禁止使用 sub-select。
- [Warning] `FROM` 和 `JOIN` 中引用的对象都要执行 View 检查。同一个 SELECT 中只要引用了 `_view` 表，其他非 View 表不再报 Warning/Error；若没有使用 `_view` 表，则紧邻注释除标准 SELECT 说明外，还必须明确提到 `view`/`_view` 并说明直接访问物理表的原因。只有标准 SELECT 注释、但没有 View 原因时，仍报告 Warning 并额外报告 `[Error]`。
- `poldat` 是上述非 View 规则的明确特例：应使用 `poldat` 而不是 `poldat_view` 以避免 database lock，但仍报告 Warning，且紧邻注释必须说明不使用 `poldat_view` 的性能或 database lock 原因；缺少该说明时额外报告 `[Error]`。
- [Warning] 使用 `select ... from dual` 时始终报告 Warning；应优先考虑 `publish data`，并要求紧邻注释，缺少注释时额外报告 `[Error]`。
- [Error] 获取当前时间时应优先使用 MOCA，例如 `publish data where todays_date = sysdate`。如果确需执行 `select sysdate from dual`，字段必须显式增加别名：`select sysdate as "sysdate" from dual`，避免 BY 2022 返回不可预测的字段名。（AC-21）
- [Warning] 单表记录存在性检查应优先使用 `validate key exists` 或 `validate key not exist`，不要使用 `select 'x' from <table/view>`。`validate key exists` 可使用任意列组合，存在时返回状态 0，不存在时返回 2003；涉及多表、`EXISTS` 或其他子查询的检查不适用此替换。无法使用时必须注释原因。（AC-24）
- `FETCH FIRST` 允许使用，插件不检查其执行计划或 `DBMS_XPLAN` 证据。
- [Error] 同一个 SQL block 中 `DISTINCT` 和任何形式的 `ROWNUM` 不能同时出现，包括 `ROWNUM = 1`、`ROWNUM < 2` 和 `ROWNUM <= 1`。
- [Warning] 只要使用 `:raw` 就报告 Warning，提示开发者人工确认输入已经进行 SQL injection 防护；插件不判断 validation 是否充分，也不实现其他 `:raw` 性能规则。
- [Warning] `:raw` 出现在 SELECT 子句中时，再额外报告一个 Warning，提示它可能在运行时展开为非法的 sub-select。源码中直接出现的 SELECT 子句 sub-select 仍按 `no-sub-select-in-select` 报 Error。
- [Error] 拼接数据库字段或表达式时必须正确使用 `/*#nobind*/` 和 `/*#bind*/`。
- [Error] 查询 `prtdsc.colval` 的拼接主键条件时，必须用 `/*#nobind*/` 和 `/*#bind*/` 包围 `colnam`、`colval` 连接条件，使 `|` 等字面量对 Oracle optimizer 可见并允许选择主键访问路径。（AC-16）
- [Error] 对 timestamp 进行复杂 cast、时区转换或格式化时，必须用 `/*#nobind*/ ... /*#bind*/` 包围完整表达式，例如 `TO_CHAR(FROM_TZ(CAST(...)) AT TIME ZONE ...)`，避免 MOCA binder 改写嵌套括号、时区操作符和字符串字面量后，在首次解析时产生 `ORA-00907`。`/*#bind*/` 之后的普通 `@variable` 仍应正常绑定。（AC-32）
- [Error] 每一个除法运算都必须显式处理分母为 0 的情况；分母为非零数值常量（例如 `numerator / 1000`、`/ -1`、`/ 0.5`）时视为必然不会为 0，自动豁免，字面量 `0` 仍报 Error，其余分母不设置常量或其他自动豁免。插件只判断当前除法的分母是否受到明确的除零保护；保护返回 0、NULL 或其他业务值均可。合法形式包括 `NULLIF`、能够短路除法的 `CASE`，以及直接保护分母的 `DECODE`，例如 `numerator / DECODE(denominator, 0, NULL, denominator)`。`DECODE(denominator, 0, 0, numerator / denominator)` 不合法，因为除法仍可能被提前计算。（AC-6）
- [Warning] 使用 `Get Session Variable` 时必须捕获错误并显式决定如何设置 `@value`（例如置空）；不能假设出错后 `@value` 会被清空，因为它可能保留调用前的旧值。还必须考虑 `commit` 可能清除部分 session variable，不能无条件依赖 commit 前的值。（AC-28）
- [Warning] 使用 `execute server command` 时必须正确处理参数值中的单引号。
- [Error] `send email` 中不得硬编码默认配置；默认值应存放在 policy 中，默认发件地址为 `swiftlog.donotreply@Kuehne-Nagel.com`。（AC-11）

## 3. Database 对象相关

- [Error] 文件名必须与数据库对象名一致。
- [Error] 表名不得超过 30 个字符，以满足 archive 相关限制。
- 以下前缀规则适用于 table、view、sequence、index 和 database trigger，不适用于 column name：
  - [Error] Local Customisation 对象必须以 `usr_lc_` 开头。
  - [Error] Plugin 对象必须以 `usr_pd_` 开头。
- [Error] 新建表必须定义主键。
- [Error] 禁止在 BY、Core 或 Plugin 的表上新增字段。
- [Error] 在 BY、Core 或 Plugin 的表上新增 index 时，必须提供对应的 index unload DDL 文件。（AC-7）
- [Error] 对表字段进行新增、修改或删除时，必须同步修改原始 table creation script。
- [Error] 表结构及数据布局变更必须是幂等的；如果增加 alter script，还必须同步更新 create script，并正确处理“变更已存在”和“主键发生变化”等场景。（AC-13）
- [Error] 每个 Local Customisation 新建表都必须在 `usr_lc_orca_tables` 中登记，并通过 Local Customisation 的 CSV 文件交付该记录。（AC-22）
- 数据库对象 tablespace 是否获得 IT Operations/DBA 批准属于人工审查，本阶段插件不检测。（AC-31）

## 4. CSV 和 CTL 文件相关

- [Error] `cust_lvl`：LC 仓库必须为 100 或更高；PD 插件仓库不检查该下限。
- [Error] CSV 文件中不允许包含 SQL。
- [Error] `les_mls_cat` 文件中：
  - LC 仓库：error 类型记录的编号必须在 `err4000000` 至 `err4999999` 范围内；非 error 类型记录必须以 `lc` 开头。
  - PD 插件仓库：error 类型记录的编号必须位于该插件登记的 error 区间内（未登记时按 `3000000-3999999` 校验），非 error 类型记录必须以 `pd_` 开头；error 行的 `grp_nam` 必须与插件登记的 group 一致。
- 当前已登记的插件 error 区间（节选）：
  - `swift-pd-customisations-amazon-messaging`：`err3400000` 至 `err3400100`，group `pd_amzmsg_errmsg`。
  - `swift-pd-customisations-dangerous-goods`：`err3900501` 至 `err3900999`，group `pd_dg_errmsg`。
  - `swift-pd-customisations-data_take_on`：`err3700000` 至 `err3799999`，group `pd_dto_errmsg`。
  - `swift-pd-customisations-edi-api-factory`：`err3800000` 至 `err3899999`，group `pd_fac_errmsg`。
  - `swift-pd-customisations-otm`：`err3600000` 至 `err3699999`，group `uc_otm_errmsg`。
  - `swift-pd-customisations-kni-fw`：`err3900000` 至 `err3900500`，group `pd_kni-errmsg`。
  - `swift-pd-customisations-warehouseautomation`：`err3981000` 至 `err3981499`，group `pd_whauto`。
- [Warning] `.ctl` 未使用 `include`、而是直接包含 SQL 或其他 script 时始终报告 Warning。除 AC-23 unload `.ctl` 外，直接写脚本必须有紧邻注释；缺少注释时额外报告 `[Error]`。AC-23 的参数化 DELETE 属于合法例外，但仍保留 Warning。
- 用于 Load File Operations 的 `.ctl` 是否已获得 QA 批准属于人工审查，本阶段插件不检测。
- [Error] Config Action `.ctl` 的版本必须不低于 `2.7.3`。（AC-33）
- [Error] `.csv` 必须有对应的 `.ctl`；同类 artifact 的其他必需依赖也必须随代码一并提交。（OT-7）
- `.ctl` 与 `.csv` 的对应关系：一个 `.ctl` 控制同一目录下同名子目录中的 `.csv`，例如 `<dir>/<table>.ctl` 对应 `<dir>/<table>/*.csv`；同一 table 同时位于 bootstraponly 和 safetoload 时，分别提供两个 `.ctl`。
- Unload `.ctl` 允许包含 DELETE，也可以包含其他 SQL 类型；存在其他 SQL 不额外报错。
- unload CSV 命名正则：`^(?:lc|pd)_<table>[_-]SWIFTLEX-\d+\.csv$`。
- [Error] Config Action 数据必须通过 `.ctl`/`.csv` 组合交付，不应再通过独立 MSQL 交付。（AC-8）
- [Error] 删除数据库配置内容必须通过 unload `.ctl`/`.csv` 组合完成，不再通过 post-install script 直接执行 MSQL 删除。（AC-23）
- [Error] 每个需要删除数据的 table 必须提供一个对应的 unload `.ctl`，并放在以下一个或两个目录中：
  - `les/db/data/unload/lc/bootstraponly`
  - `les/db/data/unload/lc/safetoload`
  - 插件仓库对应 `les/db/data/unload/pd/**/bootstraponly` 与 `les/db/data/unload/pd/**/safetoload`
- [Error] 新增 unload `.ctl` 时，必须同时存在以 table name 为前缀的对应目录和至少一个符合 KNGL 命名规范的 `.csv`；unload CSV 文件名必须带 `SWIFTLEX-<ticket>` 后缀，并支持 `lc_`/`pd_` 前缀。缺失目录或 CSV 可能导致不稳定构建。一个 CSV 可以包含同一 table 的多条待删除记录。（AC-23、OT-7）
- [Error] Unload `.ctl` 中的 DELETE 必须由 CSV 字段参数化，并捕获“记录不存在”的 `-1403`；PD 插件仓库同时接受 `catch(@?)`（捕获全部错误），例如：

```moca
[delete <table>
  where <key_column> = '@key_column@'] catch(-1403)
```

PD 插件仓库等效写法：

```moca
[delete <table>
  where <key_column> = '@key_column@'] catch(@?)
```

- [Error] post-install script（`isccustom.sh` 或 first-node 变体）必须对已使用的 unload 目录执行 `mload_all`；每个目录只需配置一次通用调用，不应为每个 CSV 重复增加脚本。插件仓库若使用相同 unload 目录结构，同样适用。（AC-23）
- [Error] 为 Local Customisation 新建表增加的 `usr_lc_orca_tables` 记录必须位于 Local Customisation CSV 中，不能放在表尚不存在的上游层级。（AC-22）

## 5. Report/Label 相关

### 5.1 文件命名

- Label 扫描 `les/labels/z140xiII` 与 `les/reports/z140xiII` 下扩展名为 `.pof` 的文件。
- [Error] `rpt_id` 就是 label/report 的文件名；比较时忽略扩展名，但大小写不能忽略。
- [Error] Report 文件名不得超过 30 个字符（按字符计算），包括主 report 和 sub-report。
- [Error] Label 文件名不得超过 20 个字符（按字符计算）。
- sub-report 与普通 report 使用同一套检查，不额外区分。

### 5.2 JRXML 连接配置

- `.jrxml` 文件通常位于 `les/reports` 路径下。
- [Error] `<parameter name="MOCA_REPORT_CONNECTION">` 必须是以 `/>` 结尾的自闭合标签；非自闭合时内部只能包含 `<property name="MOCA" value="true"/>`，不能包含 `<defaultValueExpression>`、`localhost:xxxx`、IP、`jdbc:` 等本地或硬编码连接信息。
- 只检查文件中已经存在的 `MOCA_REPORT_CONNECTION` 标签，不要求文件必须包含该标签。
- 属性顺序、单引号、XML namespace 不检查。

合法示例：

```xml
<parameter name="MOCA_REPORT_CONNECTION" class="com.redprairie.moca.jrds.JRMocaConnection" isForPrompting="false"/>
```

非法示例：

```xml
<parameter name="MOCA_REPORT_CONNECTION" class="com.redprairie.moca.jrds.JRMocaConnection" isForPrompting="false">
    <property name="MOCA" value="true"/>
    <defaultValueExpression>localhost:8080</defaultValueExpression>
</parameter>
```

合法示例（非自闭合）：

```xml
<parameter name="MOCA_REPORT_CONNECTION" class="com.redprairie.moca.jrds.JRMocaConnection" isForPrompting="false">
    <property name="MOCA" value="true"/>
</parameter>
```

### 5.3 Report 依赖数据

- 新增 JRXML report 是否需要 `les_mnu_opt` 和 `les_opt_auth_ctl` 数据依赖业务判断，属于人工审查，本阶段插件不检测。（AC-15）
- sub-report 同样按 report 对待，不存在单独的 sub-report 豁免。

## 6. Git 分支名检查

- 在检查任何文件之前，先检查当前 Git branch 名称。
- [Error] 分支名必须以 `feature/SWIFTLEX-` 开头，例如 `feature/SWIFTLEX-12345_fix`。
- Ticket 之后只允许英文字母、数字和下划线 `_`；不允许出现 `-`、`/`、`.`、空格和其他符号。
- 如果分支名不合法，直接报错并终止本次检查。

## 7. Jira Ticket 代码审查

- 用户 Git commit message 中会包含对应的 Jira Ticket，例如：`git commit -m "SWIFTLEX-51198 dev for labels"`。
- 插件提供“按 Jira Ticket 审查”命令，用户输入 Ticket 号，例如 `SWIFTLEX-51198`。
- 插件通过 Git log 搜索当前分支中包含该 Ticket 号的 commit。
- Ticket 匹配采用模糊/子串匹配，`SWIFTLEX-12` 匹配到 `SWIFTLEX-123` 是允许的。
- 历史范围包含该分支上与 Ticket 相关的全部提交，包括 merge commit。
- rename/delete 之后只检查仍然存在的新文件，不再审查已删除的旧路径。
- 二进制文件不检查。
- 筛选结果包含 staged、unstaged 和 untracked 变更。
- 提取这些 commit 中变更过的受支持文件；同一文件在多个 commit 中出现时只审查一次。
- 对筛选出的文件执行其所属模块的全部代码审查规则，包括跨文件依赖检查。
- 审查结果展示在 VS Code Problems 面板中。

## 8. 人工审查项（插件不检测）

以下规则保留为开发者检查标准，但本阶段插件不生成 Diagnostic：

- SQL 性能判断，包括执行计划、索引和数据分布是否合理，以及是否应使用 `EXISTS`、显式 JOIN、CTE/derived table 等方式改写。（AC-6）
- `FETCH FIRST`、`ROWNUM` 的执行计划比较和 `DBMS_XPLAN` 证据。
- `prtdsc` 是否已经使用大型代表性数据完成性能测试。（AC-16）
- Command 是否会被 Web UI 或 IFD 调用；因此 Web UI 分页限制和 IFD 中 `<transaction>new</transaction>` 规则暂不自动检查。（AC-16、AC-29）
- QA、技术架构师、DBA 或 IT Operations 的授权/批准是否真实有效。
- Load File Operations `.ctl` 的 QA 批准、非默认 tablespace 的 DBA/IT Operations 批准，以及新增 JRXML report 的菜单/权限数据是否确有业务需要。（AC-15、AC-31）
- 是否应将重复 SQL 抽取为小型可复用 command，以及代码整体可读性和业务合理性。（AC-10）

## 9. 延期事项

- TODO：Archive/Purge job 的扩展名、目录和新增检查规则；已有实现保持不变。
- TODO：历史/备份文件的识别和排除模式。
- TODO：Git 分支的 detached HEAD、非 Git 及多根工作区行为；分支格式已明确为 `feature/SWIFTLEX-*`，Ticket 后只允许下划线。
- TODO：Jira 的多根工作区行为；模糊匹配、merge、rename/delete、未提交变更已实现。
