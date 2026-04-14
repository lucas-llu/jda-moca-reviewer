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
    - .mcmd文件的命令名称需要是唯一的，不能重复
    - .mcmd文件中<name>的内容需要是唯一的不能重复
    - .mcmd文件中<name>需要与文件名对应，name中的空格在文件名中使用'_'替换
    - .mcmd文件中需要检查<name>中是否存在'lc'，一般'lc'出现在第一个空格之后，比如“list lc user id”，如果这个字符串中不存在'lc'，则高亮这个文件名提示用户注意
    - .mcmd文件中需要检查select 语句的数量，如果一个文件中包含一个以上的select，那么这个command是一个complex sql命令
    - .mcmd文件中需要检查join 或者 union/ union all 的数量，如果单个文件中出现2个以上的join 或者 union/ union all ，那么这个command是一个complex sql命令
    - .mcmd文件中需要检查子查询的数量，超过2个以上的子查询，那么这个command是一个complex sql命令
    - .mcmd文件中需要检查table的数量，超过2个以上的table，那么这个command是一个complex sql命令
    - complex sql只能出现在list/get开头的.mcmd文件中
    - .mcmd文件中避免使用insert/update/delete语句，如果使用将这个文件和这个语句块高亮出来，提示用户注意
    - .mcmd文件中禁止使用in，只允许使用exists
    - .mcmd文件中在select子句中禁止使用sub-select
    - 在sql中有除法时，需要使用decode函数处理除0的情况，没有decode就高亮这段sql
    - 在list/get中不能出现update/delete/insert语句
