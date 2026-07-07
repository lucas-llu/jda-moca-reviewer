需求文档
1. 审查.mcmd后缀的文件，检查文件内容是否符合要求
   - .mcmd文件是moca command文件，需要满足以下格式
   - .mcmd文件的结构需要有以下内容
        <!-- 1. 元数据部分 -->
        <name>命令名称</name>
        <description>命令描述</description>
        <type>命令类型</type>
        
        <!-- 2. 核心逻辑部分 -->
        <local-syntax>
            <![CDATA[
            /* SQL 或 MOCA 代码 */
            ]]>
        </local-syntax>
        
        <!-- 3. 文档说明部分（可选） -->
        <documentation>
            <remarks>
            <![CDATA[
                详细说明...
            ]]>
            </remarks>
        </documentation>
        </command>
    - [Error] .mcmd文件缺少<name>标签
    - [Error] .mcmd文件缺少<description>标签
    - [Error] .mcmd文件缺少<type>标签
    - [Error] .mcmd文件缺少<local-syntax>标签或CDATA块（type为"java method"时除外）
    - [Error] <name>标签中不能包含大写字母
    - [Error] <name>标签中不能包含特殊字符（只能使用小写字母、数字和空格）
    - [Error] <name>标签中不能有连续多个空格
    - [Error] 文件名不能包含大写字母
    - [Error] 文件名不能包含空格，应使用下划线'_'替代
    - [Warning] .mcmd文件中<name>需要与文件名对应，name中的空格在文件名中使用'_'替换
    - [Warning] .mcmd文件中需要检查<name>中是否存在'lc'，一般'lc'出现在第一个空格之后，比如"list lc user id"，如果这个字符串中不存在'lc'，则标记这个文件提示用户注意
    - [Error] .mcmd文件中如果包含1个以上的SELECT语句，则为complex SQL，只能出现在list/get开头的命令中
    - [Error] .mcmd文件中如果包含2个以上的JOIN或UNION/UNION ALL，则为complex SQL，只能出现在list/get开头的命令中
    - [Error] .mcmd文件中如果包含2个以上的子查询，则为complex SQL，只能出现在list/get开头的命令中
    - [Error] .mcmd文件中如果包含2个以上不同的表，则为complex SQL，只能出现在list/get开头的命令中
    - [Warning] .mcmd文件中避免使用INSERT/UPDATE/DELETE语句，如果使用将标记出来提示用户注意
    - [Error] .mcmd文件中禁止使用IN子查询，只允许使用EXISTS
    - [Error] .mcmd文件中在SELECT子句中禁止使用子查询(sub-select)
    - [Warning] 在SQL中有除法时，需要使用DECODE函数处理除0的情况，没有DECODE则标记这段SQL
    - [Error] 在list/get命令中不能出现UPDATE/DELETE/INSERT语句

2. Jira Ticket 代码审查
   - 用户在git commit时会在comment中加上对应的Jira ticket号
     - 例如：git commit -m "SWIFTLEX-51198 dev for labels"
   - 插件需要新增"按Jira Ticket审查"命令
   - 用户输入Jira ticket号（如 SWIFTLEX-51198）
   - 插件通过git log搜索当前分支中包含该ticket号的commit记录
   - 提取这些commit中变更过的.mcmd文件列表
   - 同一文件在多个commit中出现时仅审查一次（去重）
   - 仅对这些文件执行上述全部代码审查规则
   - 审查结果展示在Problems面板中
