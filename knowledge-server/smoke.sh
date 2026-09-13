#!/usr/bin/env bash
# knowledge-server 端到端冒烟脚本。
#
# 一条命令验证后端主链路：bootstrap → invite → join → createSpace →
# createDocument → lock/heartbeat/release → update（含合并窗口与换作者新版本）→
# revert → search → logout → 邀请令牌复用拒绝。
#
# 前置（在 knowledge-server/ 目录下）：
#   docker compose down -v 2>/dev/null; docker compose up -d --build
#   等服务就绪后：./smoke.sh            # 默认 http://127.0.0.1:8788
#   或指定地址：  ./smoke.sh http://192.168.1.10:8788
# 跑完清理：docker compose down -v
#
# 依赖 curl 与 python（解析 JSON）。脚本要求**干净库**——已初始化的实例
# 会直接退出，因为 bootstrap 只在空库时可用。
#
# 不覆盖（需要真实时间或并发，不适合冒烟）：
#   锁 TTL 过期被他人取走（默认 300s）、心跳迟到的旧持有人不复活、文档级 ACL。
#   摄取只覆盖「含图 docx 的资源通道」这一条链路（fixture 见 tests/fixtures/）；
#   pdf 与其它格式、批量导入不在范围内。
set -euo pipefail

BASE="${1:-http://127.0.0.1:8788}"

PY="$(command -v python || command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "错误：需要 python 解析 JSON（找不到 python / python3）" >&2
  exit 1
fi
# Windows 下 python 默认 stdout 编码可能是 GBK，中文昵称会炸
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1

# ── 工具函数 ─────────────────────────────────────────────────────────

# api METHOD PATH [JSON_BODY] [TOKEN]
# 响应体打到 stdout；HTTP 状态码写进 $CODE_FILE。
# ⚠️ 命令替换开子 shell，函数内对全局变量的赋值传不回外层——状态码只能走文件。
#    调用点固定两步：body="$(api ...)" 之后紧跟 STATUS="$(cat "$CODE_FILE")"。
#    不用 curl -f：错误响应的 body 也要留着看。
CODE_FILE="$(mktemp)"
api() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local args=(-sS --max-time 15 -X "$method" -H "Accept: application/json" -w $'\n%{http_code}')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  local out
  out="$(curl "${args[@]}" "$BASE$path")" || { echo "错误：请求失败（$method $path）" >&2; exit 1; }
  printf '%s' "${out##*$'\n'}" > "$CODE_FILE"
  printf '%s' "${out%$'\n'*}"
}

# field JSON DOT_PATH —— 取 d.a.b / d.hits.0.documentId 形式的字段
field() {
  "$PY" - "$1" "$2" <<'PYEOF'
import sys, json
d = json.loads(sys.argv[1])
for k in sys.argv[2].split("."):
    if isinstance(d, list):
        d = d[int(k)] if k.isdigit() and int(k) < len(d) else None
    elif isinstance(d, dict):
        d = d.get(k)
    else:
        d = None
    if d is None:
        break
if isinstance(d, bool):
    d = str(d).lower()
print("" if d is None else d)
PYEOF
}

# expect 实际 期望 说明
expect() {
  if [ "$1" != "$2" ]; then
    echo "  ✗ $3（期望 '$2'，实际 '$1'）" >&2
    exit 1
  fi
  echo "  ✓ $3"
}

say() { printf '\n== %s ==\n' "$1"; }

# ── 冒烟开始 ─────────────────────────────────────────────────────────

say "健康检查"
body="$(api GET /api/health)"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "GET /api/health → 200"
expect "$(field "$body" status)" "ok" "服务状态 ok"
expect "$(field "$body" tokenizer)" "jieba-rs" "分词器装配正确"

say "实例状态（要求干净库）"
body="$(api GET /api/auth/status)"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "GET /api/auth/status → 200"
if [ "$(field "$body" initialized)" != "false" ]; then
  echo "实例已初始化过，冒烟需要干净库。先执行：" >&2
  echo "  docker compose down -v && docker compose up -d" >&2
  exit 1
fi
echo "  ✓ 未初始化，可以 bootstrap"

say "bootstrap 首个管理员"
body="$(api POST /api/auth/bootstrap '{"username":"smoke-admin","displayName":"冒烟管理员","password":"smoke-pass-123"}')"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "bootstrap → 200"
ADMIN="$(field "$body" token)"
[ -n "$ADMIN" ] || { echo "  ✗ 未拿到管理员 token" >&2; exit 1; }
expect "$(field "$body" user.isAdmin)" "true" "bootstrap 出的是管理员"

say "邀请成员 B（不带空间）"
body="$(api POST /api/users/invite '{"username":"smoke-b","displayName":"成员B"}' "$ADMIN")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "invite → 200"
INVITE_B="$(field "$body" token)"
[ -n "$INVITE_B" ] || { echo "  ✗ 未拿到邀请令牌" >&2; exit 1; }

say "成员 B 领取邀请"
body="$(api POST /api/auth/join "{\"token\":\"$INVITE_B\"}")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "join → 200"
TOKEN_B="$(field "$body" token)"
expect "$(field "$body" user.username)" "smoke-b" "join 出的用户是 smoke-b"

say "B 创建空间"
body="$(api POST /api/spaces '{"key":"smoke-space","name":"冒烟空间"}' "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "createSpace → 200"
SPACE_ID="$(field "$body" id)"
expect "$(field "$body" role)" "owner" "创建者角色是 owner"
[ -n "$SPACE_ID" ] || { echo "  ✗ 未拿到空间 id" >&2; exit 1; }

say "B 建文档"
body="$(api POST "/api/documents" "{\"spaceId\":\"$SPACE_ID\",\"title\":\"冒烟测试文档\",\"content\":\"# 冒烟\\n\\n端到端验证链路。关键词：凤凰。\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "createDocument → 201"
DOC_ID="$(field "$body" documentId)"
expect "$(field "$body" versionNo)" "1" "初始版本 v1"

say "B 取编辑锁并心跳续租"
body="$(api POST "/api/documents/$DOC_ID/lock" "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "acquire lock → 200"
expect "$(field "$body" held)" "true" "B 拿到锁"
body="$(api POST "/api/documents/$DOC_ID/lock/heartbeat" "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$(field "$body" renewed)" "true" "心跳续租成功"

say "B 保存（合并窗口内 → 改写 v1 而非新开 v2）"
body="$(api PUT "/api/documents/$DOC_ID" '{"title":"冒烟测试文档","content":"# 冒烟\n\n第二版内容。关键词：凤凰。","changeNote":"smoke 更新"}' "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "updateDocument → 200"
expect "$(field "$body" versionNo)" "1" "同作者 5 分钟内合并进 v1"
expect "$(field "$body" merged)" "true" "merged=true"

say "管理员邀成员 E 为空间 editor"
body="$(api POST "/api/users/invite" "{\"username\":\"smoke-e\",\"displayName\":\"成员E\",\"spaceId\":\"$SPACE_ID\",\"spaceRole\":\"editor\"}" "$ADMIN")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "invite（带空间）→ 200"
INVITE_E="$(field "$body" token)"
body="$(api POST /api/auth/join "{\"token\":\"$INVITE_E\"}")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "E join → 200"
TOKEN_E="$(field "$body" token)"

say "E 取锁（B 持有中 → 冲突）"
body="$(api POST "/api/documents/$DOC_ID/lock" "" "$TOKEN_E")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "acquire lock → 200（冲突不是错误，是业务结果）"
expect "$(field "$body" held)" "false" "E 没拿到锁"
expect "$(field "$body" holder.displayName)" "成员B" "持锁人昵称正确"

say "B 释放锁，E 再取（应成功）"
body="$(api DELETE "/api/documents/$DOC_ID/lock" "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$(field "$body" released)" "true" "B 释放成功"
body="$(api POST "/api/documents/$DOC_ID/lock" "" "$TOKEN_E")"
STATUS="$(cat "$CODE_FILE")"
expect "$(field "$body" held)" "true" "E 拿到锁"

say "E 保存（换作者 → 新开版本 v2）"
body="$(api PUT "/api/documents/$DOC_ID" '{"title":"冒烟测试文档","content":"# 冒烟\n\nE 的修改。关键词：凤凰。","changeNote":"E 的更新"}' "$TOKEN_E")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "updateDocument → 200"
expect "$(field "$body" versionNo)" "2" "换作者不合并，开 v2"
expect "$(field "$body" merged)" "false" "merged=false"

say "E 回滚到 v1（强制新版本 v3）"
body="$(api POST "/api/documents/$DOC_ID/revert" '{"versionNo":1}' "$TOKEN_E")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "revert → 200"
expect "$(field "$body" versionNo)" "3" "回滚 = 基于旧版新建 v3"
body="$(api GET "/api/documents/$DOC_ID/revisions" "" "$TOKEN_E")"
STATUS="$(cat "$CODE_FILE")"
expect "$(field "$body" 0.versionNo)" "3" "版本历史最新是 v3"

say "B 检索（jieba 中文分词）"
body="$(curl -sS --max-time 15 -G "$BASE/api/search" \
  --data-urlencode "q=凤凰" \
  -H "Accept: application/json" -H "Authorization: Bearer $TOKEN_B" \
  -w $'\n%{http_code}')"
STATUS="${body##*$'\n'}"
body="${body%$'\n'*}"
expect "$STATUS" "200" "search → 200"
expect "$(field "$body" hits.0.documentId)" "$DOC_ID" "命中文档正确"

say "资源通道：docx 内嵌图片"

FIXTURE="tests/fixtures/with_image.docx"
ASSET_BIN="$(mktemp)"
if [ -f "$FIXTURE" ]; then
  # 摄取走 multipart，不能用 api()（那个固定发 JSON）
  # ⚠️ 查询参数是 camelCase 的 spaceId：服务端 UploadQuery 带
  #    #[serde(rename_all = "camelCase")]，写成 space_id 会 400
  resp="$(curl -sS --max-time 60 -X POST "$BASE/api/ingest?spaceId=$SPACE_ID" \
    -H "Accept: application/json" -H "Authorization: Bearer $TOKEN_B" \
    -F "file=@$FIXTURE" -w $'\n%{http_code}')"
  STATUS="${resp##*$'\n'}"
  resp="${resp%$'\n'*}"
  expect "$STATUS" "201" "上传含图 docx → 201"

  IMG_DOC_ID="$(field "$resp" documentId)"
  [ -n "$IMG_DOC_ID" ] || { echo "  ✗ 未拿到文档 id" >&2; exit 1; }
  expect "$(field "$resp" backend)" "docx-to-md" "首选 docx 后端生效（没回落到 lite）"
  # 空数组序列化成 `[]`（不是空串）—— field 帮手如实打印 JSON 字面量
  expect "$(field "$resp" warnings)" "[]" "无降级警告 —— 图片没被丢"

  body="$(api GET "/api/documents/$IMG_DOC_ID" "" "$TOKEN_B")"
  STATUS="$(cat "$CODE_FILE")"
  expect "$STATUS" "200" "读回含图文档 → 200"
  CONTENT="$(field "$body" content)"

  case "$CONTENT" in
    *"asset://"*) echo "  ✓ 正文里有 asset:// 引用" ;;
    *) echo "  ✗ 正文里没有 asset:// 引用" >&2; exit 1 ;;
  esac
  case "$CONTENT" in
    *base64*) echo "  ✗ 正文里仍有 base64（倒排索引会被污染）" >&2; exit 1 ;;
    *) echo "  ✓ 正文里没有 base64" ;;
  esac
  case "$CONTENT" in
    *"{{asset:"*) echo "  ✗ 正文里残留解析期占位符" >&2; exit 1 ;;
    *) echo "  ✓ 正文里没有残留占位符" ;;
  esac

  ASSET_ID="$(printf '%s' "$CONTENT" | "$PY" -c 'import sys,re
m = re.search(r"asset://([0-9a-fA-F-]{36})", sys.stdin.read())
print(m.group(1) if m else "")')"
  [ -n "$ASSET_ID" ] || { echo "  ✗ 正文里没有可解析的 asset:// id" >&2; exit 1; }

  hdr="$(curl -sS --max-time 15 -D - -o "$ASSET_BIN" \
    "$BASE/api/assets/$ASSET_ID" -H "Authorization: Bearer $TOKEN_B")"
  if printf '%s' "$hdr" | grep -qi '^content-type: image/'; then
    echo "  ✓ 资源 Content-Type 是 image/*"
  else
    echo "  ✗ 资源 Content-Type 不是 image/*：" >&2
    printf '%s\n' "$hdr" | head -5 >&2
    exit 1
  fi
  if [ -s "$ASSET_BIN" ]; then
    echo "  ✓ 资源字节非空（$(wc -c < "$ASSET_BIN" | tr -d ' ') 字节）"
  else
    echo "  ✗ 资源字节为空" >&2
    exit 1
  fi

  code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$BASE/api/assets/$ASSET_ID")"
  expect "$code" "401" "未鉴权取图 → 401（不是 404/500）"
else
  echo "  (跳过：$FIXTURE 不存在)"
fi
rm -f "$ASSET_BIN"

say "解析失败不留孤儿文件"
count_storage() {
  docker compose exec -T knowledge sh -c 'ls -1 /app/storage 2>/dev/null | wc -l' 2>/dev/null | tr -d '\r '
}
if BEFORE="$(count_storage)" && [ -n "$BEFORE" ]; then
  printf 'not a supported format' > /tmp/kb-bad-fixture.xyz
  curl -sS --max-time 15 -o /dev/null -X POST "$BASE/api/ingest?spaceId=$SPACE_ID" \
    -H "Authorization: Bearer $TOKEN_B" -F "file=@/tmp/kb-bad-fixture.xyz" || true
  AFTER="$(count_storage)"
  expect "$AFTER" "$BEFORE" "不支持的格式被拒后，存储目录文件数不变"
else
  echo "  (跳过：拿不到容器内的 /app/storage —— 远程 BASE 时正常)"
fi

say "登出"
body="$(api POST /api/auth/logout "" "$TOKEN_E")"
STATUS="$(cat "$CODE_FILE")"
expect "$(field "$body" ok)" "true" "E logout"
body="$(api POST /api/auth/logout "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$(field "$body" ok)" "true" "B logout"

say "邀请令牌一次性（复用 B 的令牌应 401）"
body="$(api POST /api/auth/join "{\"token\":\"$INVITE_B\"}")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "401" "已用令牌被拒绝"

printf '\n全部通过 ✔  （%s）\n' "$BASE"
