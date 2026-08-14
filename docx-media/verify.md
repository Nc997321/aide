::: center
**浦城县石陂镇智慧农业集成展示项目**

**等保整改材料**** —— ****身份鉴别**
:::

**表**** 1****：整改项信息表**

| 项目 | 内容 |
--- | ---
| 整改项名称 | 安全计算环境 — 身份鉴别 |
| 检测项 | a) 应对登录的用户进行身份标识和鉴别，身份标识具有唯一性，身份鉴别信息具有复杂度要求并定期更换；b) 应具有登录失败处理功能，应配置并启用结束会话、限制非法登录次数和当登录连接超时自动退出等相关措施。 |
| 整改依据 | 《信息安全技术 网络安全等级保护基本要求》（GB/T 22239—2019） |
| 整改日期 | 2026年08月 |
| 编制人 | 张圩旻 |
| 审核人 |  |

::: center
**目　录**
:::

[TOC]

::: center
**图表索引**
:::

**图目录**

| 编号 | 图题 | 页码 |
--- | --- | ---
| 图 1 | 数据库服务器（192.168.110.23） | 8 |
| 图 2 | 后台服务器（192.168.110.22） | 9 |
| 图 3 | 中间件服务器（192.168.110.25） | 10 |
| 图 4 | 应用服务器（192.168.110.21） | 11 |
| 图 5 | 文件服务器（192.168.110.24） | 12 |
| 图 6 | 宿主机（192.168.110.20） | 13 |

**表目录**

| 编号 | 表题 | 页码 |
--- | --- | ---
| 表 1 | 整改项信息表 | 1 |
| 表 2 | 适用资产清单 | 3 |

\newpage

<!--bookmark:_Toc237544365-->

一、整改概述

本次整改针对项目内所有 Linux 服务器、数据库及相关中间件的身份鉴别机制进行加固。整改前，各服务器未配置口令复杂度策略及定期更换策略，未配置登录失败处理及连接超时策略，存在口令被暴力破解及非授权访问风险。整改后，已全部配置口令复杂度（长度≥8位、至少3种字符组合）、口令有效期（90天）、登录失败锁定及会话超时策略。

<!--bookmark:_Toc237544366-->

二、身份鉴别 a) 口令复杂度策略整改

<!--bookmark:_Toc237544367-->

2.1 整改措施

（1）配置 PAM 密码复杂度模块（pwquality）

编辑 /etc/security/pwquality.conf，配置如下：

minlen = 8（最小长度8位）

minclass = 3（至少包含3种字符类型）

dcredit = -1（至少1个数字）

ucredit = -1（至少1个大写字母）

lcredit = -1（至少1个小写字母）

ocredit = -1（至少1个特殊符号）

retry = 3（密码校验失败后提示重试的次数）

enforce_for_root（root用户也强制执行）

（2）配置密码有效期策略

编辑 /etc/login.defs：

PASS_MAX_DAYS 90（最大使用期限90天）

PASS_MIN_DAYS 0（最小修改间隔0天）

PASS_WARN_AGE 7（过期前7天警告）

（3）对现有用户强制生效

使用 chage 命令对 root、admin 及其他运维账户设置有效期：

```
chage -M 90 -m 0 -W 7 [
用户名
]

chage -d $(date +%Y-%m-%d) [
用户名
]  
（标记修改日期）
```

（4）数据库层面专项（Azure SQL Edge）

① 执行 ALTER LOGIN SA WITH CHECK_POLICY = ON，联动宿主机 PAM 策略；

② 因 Azure SQL Edge 容器版技术限制，CHECK_EXPIRATION 启用后会导致 SA 账户锁定、业务中断，已回退为 OFF，采用以下补偿措施：

密码过期检查脚本（/opt/mssql_password_policy.sh）：定期检查 SA 密码使用天数，超过 90 天触发告警；

钉钉机器人告警（/opt/alert_sender.py）：每 90 天人工更换一次 SA 密码。

<!--bookmark:_Toc237544368-->

2.2 适用资产清单

**表**** 2****：适用资产清单**

| IP地址 | 资产名称 | 整改状态 |
--- | --- | ---
| 192.168.110.21 | 应用服务器 | 已完成 |
| 192.168.110.22 | 后台服务器 | 已完成 |
| 192.168.110.23 | 数据库服务器 | 已完成 |
| 192.168.110.24 | 文件服务器 | 已完成 |
| 192.168.110.25 | 中间件服务器 | 已完成 |
| 192.168.110.20 | 宿主机 | 已完成 |

<!--bookmark:_Toc237544369-->

2.3 验证测试

（1）弱密码拒绝测试

使用 root 账户修改 admin 密码，输入"123456"，系统提示：

"无效的密码： 密码包含少于 1 的大写字母"

证明复杂度策略已生效。

（2）规律性密码拒绝测试

输入过于简单、有规律的密码（如 Abc@1234），系统提示：

"无效的密码： 密码未通过字典检查 - 太简单或太有规律"

证明字典检查策略已生效。

（3）有效期验证

执行 chage -l admin，显示：

```
两次改变密码之间相距的最大天数：
90
```

证明有效期策略已生效。

<!--bookmark:_Toc237544370-->

三、身份鉴别 b) 登录失败处理与超时退出策略整改

<!--bookmark:_Toc237544371-->

3.1 整改措施

编辑 /etc/ssh/sshd_config，配置如下：

MaxAuthTries 5（登录失败5次后断开）

ClientAliveInterval 300（每300秒检测一次客户端活动）

ClientAliveCountMax 0（无响应立即断开）

LoginGraceTime 60（登录宽限时间60秒）

生效方式：

```
systemctl restart sshd
```

<!--bookmark:_Toc237544372-->

3.2 策略效果

连续输错5次密码，SSH 连接被强制断开，防止暴力破解；

客户端无响应约300秒（5分钟）后自动断开（ClientAliveInterval=300 表示每300秒探测一次客户端活动，ClientAliveCountMax=0 表示一次无响应即断开），降低非授权访问风险。

<!--bookmark:_Toc237544373-->

四、整改验证记录（逐台服务器）

以下记录每台服务器的具体配置验证结果（IP 截图见附录）。

<!--bookmark:_Toc237544374-->

4.1 数据库服务器（192.168.110.23）

验证时间：2026年08月11日

验证人员：张圩旻

验证命令及结果：

```
$ cat /etc/security/pwquality.conf

minlen = 8

minclass = 3

dcredit = -1

ucredit = -1

lcredit = -1

ocredit = -1

retry = 3

enforce_for_root

$ grep PASS_MAX_DAYS /etc/login.defs

PASS_MAX_DAYS 90

$ sudo chage -l admin

Maximum number of days between password change: 90

Minimum number of days between password change: 0

Number of days of warning before password expires: 7

$ grep -E "MaxAuthTries|ClientAliveInterval|ClientAliveCountMax|LoginGraceTime" /etc/ssh/sshd_config

MaxAuthTries 5

ClientAliveInterval 300

ClientAliveCountMax 0

LoginGraceTime 60
```

SA 密码策略验证（密码过期检查脚本及钉钉告警联动验证）：

```
$ echo "=== $(hostname) ===" && ip addr | grep 192.168.110. && echo "--- 
脚本内容
 ---" && cat /opt/mssql_password_policy.sh && echo "--- 
钉钉告警脚本
 ---" && ls -la /opt/alert_sender.py && echo "--- 
测试执行
 ---" && sudo /opt/mssql_password_policy.sh

=== localhost.localdomain ===

    inet 192.168.110.23/24 brd 192.168.110.255 scope global noprefixroute enp1s0

--- 
脚本内容
 ---

#!/bin/bash

SA_PASS="Casdeltadba2026@"

CONTAINER="azuresqledge"

LOG_FILE="/var/lib/azuresqledge/backup/mssql_password_audit.log"

ALERT_SCRIPT="/opt/alert_sender.py"

# 
确保日志目录存在

mkdir -p $(dirname $LOG_FILE)

# 
检查容器是否运行

if ! sudo podman ps | grep -q "$CONTAINER"; then

    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 
错误：容器
 $CONTAINER 
未运行
" | tee -a $LOG_FILE

    exit 1

fi

# 
检查
 SA 
密码最后修改时间

RESULT=$(sudo podman exec $CONTAINER sqlcmd \

  -S localhost -U SA -P "$SA_PASS" -C \

  -Q "SET NOCOUNT ON; SELECT DATEDIFF(day, modify_date, GETDATE()) FROM sys.sql_logins WHERE name = 'SA'" \

  -h -1 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

# 
如果
 sqlcmd 
失败，尝试完整路径

if [ -z "$RESULT" ] || ! [[ "$RESULT" =~ ^[0-9]+$ ]]; then

    RESULT=$(sudo podman exec $CONTAINER /opt/mssql-tools18/bin/sqlcmd \

      -S localhost -U SA -P "$SA_PASS" -C \

      -Q "SET NOCOUNT ON; SELECT DATEDIFF(day, modify_date, GETDATE()) FROM sys.sql_logins WHERE name = 'SA'" \

      -h -1 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] SA
密码已使用
 ${RESULT} 
天
" | tee -a $LOG_FILE

# 
超过
 90 
天：日志告警
 + 
钉钉告警

if [ "$RESULT" -ge 90 ]; then

    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠
️
 
警告：
SA
密码已超
90
天，需立即更换！
" | tee -a $LOG_FILE

    

    # 
钉钉告警（如果
 alert_sender.py 
存在）

    if [ -f "$ALERT_SCRIPT" ]; then

        TITLE="
【等保告警】数据库
 SA 
密码即将过期
"

        BODY="**
资产：
** 
数据库服务器
-192.168.110.23
（
Azure SQL Edge
）
<br>**
告警内容：
** SA 
密码已使用
 ${RESULT} 
天，超过
 90 
天有效期
<br>**
风险：
** 
密码长期未更换，存在被暴力破解风险
<br>**
建议操作：
** 
立即登录
 192.168.110.23 
更换
 SA 
密码，并更新所有应用配置中的连接串
<br>**
整改依据：
** 
《信息安全技术
 
网络安全等级保护基本要求》身份鉴别项
"

        python3 "$ALERT_SCRIPT" "$TITLE" "$BODY" >> $LOG_FILE 2>&1

        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 
钉钉告警已发送
" | tee -a $LOG_FILE

    fi

fi

--- 
钉钉告警脚本
 ---

-rwxr-xr-x. 1 root root 2733  8
月
 12 13:53 /opt/alert_sender.py

--- 
测试执行
 ---

[2026-08-13 18:23:10] SA
密码已使用
 0 
天
```

验证结论：身份鉴别 a)、b) 项整改完成，策略已生效。

<!--bookmark:_Toc237544375-->

4.2 后台服务器（192.168.110.22）

验证方式同 4.1：口令复杂度、口令有效期、SSH 登录失败处理与会话超时策略逐项核验，均已生效（验证截图见附录图 2）。

<!--bookmark:_Toc237544376-->

4.3 中间件服务器（192.168.110.25）

验证方式同 4.1：口令复杂度、口令有效期、SSH 登录失败处理与会话超时策略逐项核验，均已生效（验证截图见附录图 3）。

<!--bookmark:_Toc237544377-->

4.4 应用服务器（192.168.110.21）

验证方式同 4.1：口令复杂度、口令有效期、SSH 登录失败处理与会话超时策略逐项核验，均已生效（验证截图见附录图 4）。

<!--bookmark:_Toc237544378-->

4.5 文件服务器（192.168.110.24）

验证方式同 4.1：口令复杂度、口令有效期、SSH 登录失败处理与会话超时策略逐项核验，均已生效（验证截图见附录图 5）。

<!--bookmark:_Toc237544379-->

4.6 宿主机（192.168.110.20）

验证方式同 4.1：口令复杂度、口令有效期、SSH 登录失败处理与会话超时策略逐项核验，均已生效（验证截图见附录图 6）。

<!--bookmark:_Toc237544380-->

五、整改结论

经整改，项目内所有 Linux 服务器均已配置口令复杂度策略（长度≥8位、至少3种字符组合、有效期90天）及登录失败处理策略（5次失败断开、无响应约300秒自动断开）。经逐台验证，策略均已生效，符合《信息安全技术 网络安全等级保护基本要求》身份鉴别项要求。

\newpage

<!--bookmark:_Toc237544381-->

附录：现场验证截图

各服务器整改验证截图（截图含主机名与 IP 地址验证信息）如下：

![图1-数据库服务器](media/1.png){width=480}

图 1：数据库服务器（192.168.110.23）

![图2-后台服务器](media/0.png){width=480}

图 2：后台服务器（192.168.110.22）

![图3-中间件服务器](media/5.png){width=480}

图 3：中间件服务器（192.168.110.25）

![图4-应用服务器](media/4.png){width=480}

图 4：应用服务器（192.168.110.21）

![图5-文件服务器](media/3.png){width=480}

图 5：文件服务器（192.168.110.24）

![图6-宿主机](media/2.png){width=480}

图 6：宿主机（192.168.110.20）
