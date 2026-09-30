#!/usr/bin/env bash
# knowledge-server 端到端冒烟脚本。
#
# 一条命令验证后端主链路：bootstrap → invite → join → createSpace →
# createDocument → lock/heartbeat/release → update（含合并窗口与换作者新版本）→
# revert → search → 摄取（含图 docx 的资源通道 / **html 产物** / 取件地址）→
# 网页条目的检索与编辑后重算 → 软删（级联子树 / 检索过滤 / 删后重建同名）→
# 会话有效期（滑动续期 / 绝对上限 / 过期）→ logout → 邀请令牌复用拒绝。
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
#   pdf 与其它格式、批量导入不在范围内。
#   ⚠️ 会话有效期那三条断言要直接改库里的时间（`psql_kb`），**只在
#      `-p kbsmoke` 那套隔离栈下会真正执行**；换别的实例跑会打印 ⚠️ 跳过。
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
# ⚠️ 正文走 stdin（--data-binary @-），不走 -d 的参数：Windows 的 git-bash 把**原生程序**
#    （mingw curl）的 argv 按 ANSI 代码页转码，非 ASCII 正文会变成 GBK 字节，服务端按
#    UTF-8 解析直接 400 invalid unicode——中文昵称首当其冲。stdin 是字节通道，不经转码。
CODE_FILE="$(mktemp)"
api() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local args=(-sS --max-time 15 -X "$method" -H "Accept: application/json" -w $'\n%{http_code}')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" --data-binary @-)
  fi
  local out
  # 无正文时 printf 只吐空串；curl 没有取数据的参数，不会去读它
  out="$(printf '%s' "$body" | curl "${args[@]}" "$BASE$path")" || {
    echo "错误：请求失败（$method $path）" >&2
    exit 1
  }
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

# search_kb QUERY TOKEN —— 检索一条；返回 body，状态码走 $CODE_FILE（与 api() 同约定）。
# 查询串走 stdin：中文出现在 argv 上会被 git-bash 按 ANSI 代码页转码（见文件头说明）。
search_kb() {
  local out
  out="$(printf '%s' "$1" | curl -sS --max-time 15 -G "$BASE/api/search" \
    --data-urlencode 'q@-' \
    -H "Accept: application/json" -H "Authorization: Bearer $2" \
    -w $'\n%{http_code}')"
  printf '%s' "${out##*$'\n'}" > "$CODE_FILE"
  printf '%s' "${out%$'\n'*}"
}

# psql_kb SQL —— 直接查冒烟栈的库（会话有效期要改时间，没有别的办法）。
# 只有「本机 + 冒烟 overlay + -p kbsmoke」这套栈下可用；拿不到返回空串，
# 调用点据此**明说跳过**（不静默）。
psql_kb() {
  docker compose -f docker-compose.yml -f docker-compose.dev.yml \
    -f docker-compose.smoke.yml -p kbsmoke exec -T db \
    psql -U aide -d aide_kb -tAc "$1" 2>/dev/null | tr -d '\r' | sed '/^[[:space:]]*$/d' | head -1
}

# sha256('<token>') 的 SQL 表达式——与 api/extract.rs::hash_token 同一算法，
# 用它把断言精确打到刚建出来的那一条会话上，而不是「最新的那条」。
session_hash_sql() {
  printf "encode(sha256(convert_to('%s','UTF8')),'hex')" "$1"
}

# ── 冒烟开始 ─────────────────────────────────────────────────────────

say "健康检查"
body="$(api GET /api/health)"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "GET /api/health → 200"
expect "$(field "$body" status)" "ok" "服务状态 ok"
expect "$(field "$body" tokenizer)" "jieba-rs" "分词器装配正确"
# 客户端靠它判断「服务端够不够新」并提示升级；本地 --build 出来的是 dev
expect "$(field "$body" version)" "dev" "服务端自报版本（本地构建 = dev，客户端不据此催升级）"

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
# 查询值同样走 stdin（q@-）：与 api() 的正文同理，中文不能出现在 argv 上
body="$(printf '%s' '凤凰' | curl -sS --max-time 15 -G "$BASE/api/search" \
  --data-urlencode 'q@-' \
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

say "资料库：网页产物（html）"
# 一个自包含的 html：正文里一个独特词（青鸾）、待替换词（朱雀）、
# <script> 里另一个独特词（smokeOnlyScriptWord，Review Focus #2 用）。
HTML_DIR="$(mktemp -d)"
HTML_FIXTURE="$HTML_DIR/smoke.html"
printf '%s' '<!doctype html>
<html><head><title>季度复盘</title>
<style>.kpi{color:#c00}</style>
<script>var smokeOnlyScriptWord=1;</script>
</head>
<body><h1>季度复盘</h1><p>关键词：青鸾。待替换词：朱雀。</p></body></html>' > "$HTML_FIXTURE"

resp="$(curl -sS --max-time 60 -X POST "$BASE/api/ingest?spaceId=$SPACE_ID" \
  -H "Accept: application/json" -H "Authorization: Bearer $TOKEN_B" \
  -F "file=@$HTML_FIXTURE" -w $'\n%{http_code}')"
STATUS="${resp##*$'\n'}"
resp="${resp%$'\n'*}"
expect "$STATUS" "201" "上传 html → 201"
HTML_DOC_ID="$(field "$resp" documentId)"
[ -n "$HTML_DOC_ID" ] || { echo "  ✗ 未拿到网页条目 id" >&2; exit 1; }
expect "$(field "$resp" backend)" "html" "走的是 html 后端"

body="$(api GET "/api/documents/$HTML_DOC_ID" "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "读回网页条目 → 200"
expect "$(field "$body" mime)" "text/html" "mime 是 text/html（由服务端按扩展名定）"
"$PY" - "$body" "$HTML_FIXTURE" <<'PYEOF'
import sys, json
doc = json.loads(sys.argv[1])
raw = open(sys.argv[2], encoding="utf-8").read()
if doc["content"] != raw:
    print("  ✗ 库里存的不是原件 —— agent 读到的是被改造过的文本", file=sys.stderr)
    sys.exit(1)
print("  ✓ 正文逐字等于上传的原件（agent 读得到能改的源码）")
PYEOF

body="$(api GET /api/ingest/formats)"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "GET /api/ingest/formats → 200"
"$PY" - "$body" <<'PYEOF'
import sys, json
exts = json.loads(sys.argv[1])["extensions"]
if "html" not in exts or "htm" not in exts:
    print(f"  ✗ 没收录 html/htm：{exts}", file=sys.stderr); sys.exit(1)
if "csv" in exts or "json" in exts:
    print(f"  ✗ 混进了非产品格式（spec §5.1）：{exts}", file=sys.stderr); sys.exit(1)
print("  ✓ 收录 html/htm，且没有 csv/json")
PYEOF

say "取件地址：本机可达、免 Bearer 的预览通路"
body="$(api POST "/api/documents/$HTML_DOC_ID/preview-token" "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "签预览票 → 200"
PREVIEW_TOKEN="$(field "$body" token)"
[ -n "$PREVIEW_TOKEN" ] || { echo "  ✗ 未拿到预览 token" >&2; exit 1; }

PREVIEW_BIN="$(mktemp)"
hdr="$(curl -sS --max-time 15 -D - -o "$PREVIEW_BIN" "$BASE/p/$PREVIEW_TOKEN")"
expect "$(printf '%s' "$hdr" | head -1 | tr -d '\r' | awk '{print $2}')" "200" \
  "不带 Authorization 取件 → 200（浏览器直接导航，发不出鉴权头）"
if printf '%s' "$hdr" | grep -qi '^content-type: text/html'; then
  echo "  ✓ 取件的 Content-Type 是 text/html"
else
  echo "  ✗ 取件的 Content-Type 不是 text/html：" >&2
  printf '%s\n' "$hdr" | head -5 >&2
  exit 1
fi
if cmp -s "$PREVIEW_BIN" "$HTML_FIXTURE"; then
  echo "  ✓ 取到的字节与上传的原件逐字相同"
else
  echo "  ✗ 取到的字节与原件不同" >&2
  exit 1
fi
rm -f "$PREVIEW_BIN"

body="$(api GET "/p/definitely-not-a-token" "")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "404" "无效取件 token → 404"
case "$body" in
  *失效*) echo "  ✓ 404 文案写清了下一步" ;;
  *) echo "  ✗ 404 文案没写清（实际：$body）" >&2; exit 1 ;;
esac

say "网页条目的检索：剥标记、排除脚本"
body="$(search_kb '青鸾' "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "搜正文词 → 200"
expect "$(field "$body" hits.0.documentId)" "$HTML_DOC_ID" "正文词命中网页条目"
expect "$(field "$body" hits.1.documentId)" "" "只命中这一条"
"$PY" - "$body" <<'PYEOF'
import sys, json
snip = json.loads(sys.argv[1])["hits"][0]["snippet"]
if "<" in snip or ">" in snip:
    print(f"  ✗ 高亮片段里带着标签：{snip}", file=sys.stderr); sys.exit(1)
print(f"  ✓ 高亮片段里没有标签：{snip[:40]}")
PYEOF
body="$(search_kb 'smokeOnlyScriptWord' "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "搜 <script> 里的词 → 200"
expect "$(field "$body" hits)" "[]" "脚本内容零命中（Review Focus #2）"

say "网页条目编辑后可搜文本跟着重算"
EDIT_BODY="$("$PY" - "$HTML_FIXTURE" <<'PYEOF'
import sys, json
raw = open(sys.argv[1], encoding="utf-8").read()
print(json.dumps({"title": "季度复盘", "content": raw.replace("朱雀", "玄武"), "changeNote": "换一个词"}))
PYEOF
)"
body="$(api PUT "/api/documents/$HTML_DOC_ID" "$EDIT_BODY" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "编辑网页条目 → 200"
expect "$(field "$body" merged)" "true" "同一作者在合并窗口内 → 改写当前版本（正是最容易漏算的那条路）"

body="$(search_kb '玄武' "$TOKEN_B")"
expect "$(field "$body" hits.0.documentId)" "$HTML_DOC_ID" "改后的词能搜到"
body="$(search_kb '朱雀' "$TOKEN_B")"
expect "$(field "$body" hits)" "[]" "改前的词搜不到了（Review Focus #4）"

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

say "软删：删文件夹连同整棵子树"
# 刻意造三层（文件夹→文件夹→文档）：只删一层的实现能过「删子」的断言，但过不了递归。
# 用文件夹而不是「文档套文档」搭这棵树，是因为后者在「文档是叶子」落地后会被 400 拒掉
#（spec §4.1）；而且穿过两层文件夹才够得着叶子，对递归的要求比原来更强。
# 关键词「貔貅」只出现在最里层那篇文档上——文件夹没有正文，放不了关键词。
body="$(api POST "/api/documents" "{\"spaceId\":\"$SPACE_ID\",\"title\":\"冒烟删除根\",\"kind\":\"folder\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "建删除测试根文件夹 → 201"
DEL_ROOT="$(field "$body" documentId)"

body="$(api POST "/api/documents" "{\"spaceId\":\"$SPACE_ID\",\"parentId\":\"$DEL_ROOT\",\"title\":\"冒烟中间层\",\"kind\":\"folder\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "建中间层文件夹 → 201"
DEL_MID="$(field "$body" documentId)"

body="$(api POST "/api/documents" "{\"spaceId\":\"$SPACE_ID\",\"parentId\":\"$DEL_MID\",\"title\":\"冒烟父文档\",\"content\":\"父文档。关键词：貔貅。\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "建最里层文档 → 201"
DEL_DOC_ID="$(field "$body" documentId)"

# 先钉一条**正向基线**：只断言「删后检索为空」的话，jieba 万一把这个生僻词切成别的
# 东西（或 simple 兜底把整句当一个词元），那条负向断言会因为「本来就搜不到」而假绿。
body="$(printf '%s' '貔貅' | curl -sS --max-time 15 -G "$BASE/api/search" \
  --data-urlencode 'q@-' \
  -H "Accept: application/json" -H "Authorization: Bearer $TOKEN_B" \
  -w $'\n%{http_code}')"
STATUS="${body##*$'\n'}"
body="${body%$'\n'*}"
expect "$STATUS" "200" "删除前检索 → 200"
case "$body" in
  *"$DEL_DOC_ID"*) echo "  ✓ 删除前检索得到父文档（下面的负向断言才有意义）" ;;
  *) echo "  ✗ 删除前就检索不到 —— 负向断言会假绿" >&2; exit 1 ;;
esac

# 删之前先让别人把锁拿在手上：验证「删除不被编辑锁挡住」。
# ⚠️ 顺手清锁行这件事在 API 上观察不到（没有读锁的端点），这段断言只钉住「删得掉」；
#    锁行确实消失要另用 SQL 核对，别指望这里。
body="$(api POST "/api/documents/$DEL_DOC_ID/lock" "" "$TOKEN_E")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "E 取最里层文档的编辑锁"

body="$(api DELETE "/api/documents/$DEL_ROOT" "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "DELETE /api/documents/{id} → 200"
expect "$(field "$body" deletedCount)" "3" "deletedCount = 3（根文件夹+中间层+文档）"

body="$(api GET "/api/spaces/$SPACE_ID/documents" "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "删除后列空间文档 → 200"
case "$body" in
  *"$DEL_ROOT"*|*"$DEL_MID"*|*"$DEL_DOC_ID"*)
    echo "  ✗ 已删节点仍在空间列表里（级联没走全）" >&2; exit 1 ;;
  *) echo "  ✓ 根文件夹/中间层/文档三层都已从空间列表消失" ;;
esac

body="$(api GET "/api/documents/$DEL_DOC_ID" "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "404" "直接读已删文档 → 404"

body="$(api GET "/api/documents/$DEL_MID" "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "404" "直接读已删中间层文件夹 → 404"

# 检索是另一条读路径，README 声称「全部读路径都已过滤 deleted_at」——在这兑现
body="$(printf '%s' '貔貅' | curl -sS --max-time 15 -G "$BASE/api/search" \
  --data-urlencode 'q@-' \
  -H "Accept: application/json" -H "Authorization: Bearer $TOKEN_B" \
  -w $'\n%{http_code}')"
STATUS="${body##*$'\n'}"
body="${body%$'\n'*}"
expect "$STATUS" "200" "删除后检索 → 200"
expect "$(field "$body" hits)" "[]" "已删文档检索不到"

# slug 是部分唯一索引（WHERE deleted_at IS NULL），删后重建同名必须放行。
# 用**同名的根文件夹**来验：它与刚被删的 DEL_ROOT 落在同一个
# (space_id, parent=NULL, slug) 三元组上，是这条索引最直接的考验。
body="$(api POST "/api/documents" "{\"spaceId\":\"$SPACE_ID\",\"title\":\"冒烟删除根\",\"kind\":\"folder\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "删后重建同名根文件夹 → 201（slug 部分唯一索引生效）"
NEW_ROOT="$(field "$body" documentId)"

body="$(api POST "/api/documents" "{\"spaceId\":\"$SPACE_ID\",\"parentId\":\"$NEW_ROOT\",\"title\":\"冒烟中间层\",\"kind\":\"folder\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "同名中间层也能重建 → 201（三元组换了父但同样在测索引）"

say "目录树：建 / 移 / 改名"

body="$(api POST "/api/documents" "{\"spaceId\":\"$SPACE_ID\",\"title\":\"目录树根\",\"kind\":\"folder\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "建文件夹 → 201"
TREE_FOLDER="$(field "$body" documentId)"
expect "$(field "$body" versionNo)" "0" "文件夹没有版本（versionNo=0）"

body="$(api POST "/api/documents" "{\"spaceId\":\"$SPACE_ID\",\"parentId\":\"$TREE_FOLDER\",\"title\":\"目录树子层\",\"kind\":\"folder\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "文件夹下建子文件夹（多层）→ 201"
TREE_SUB="$(field "$body" documentId)"

body="$(api POST "/api/documents" "{\"spaceId\":\"$SPACE_ID\",\"parentId\":\"$TREE_SUB\",\"title\":\"目录树叶子\",\"content\":\"# 正文\\n\\n内容。\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "文件夹下建文档 → 201"
TREE_DOC="$(field "$body" documentId)"

# 列表要带 kind、标题取 documents.title、同级文件夹排在文档之前
body="$(api GET "/api/spaces/$SPACE_ID/documents" "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "拉目录树 → 200"
# ⚠️ 数据走 **argv** 而不是 stdin：`python - <<'EOF'` 把 stdin 占给了脚本本身，
#    再管道喂数据会拿到空串。`field()` 用的是同一条路子。
"$PY" -c '
import sys, json
docs = json.loads(sys.argv[1])
by_id = {d["id"]: d for d in docs}
folder, sub, doc = sys.argv[2], sys.argv[3], sys.argv[4]
assert by_id[folder]["kind"] == "folder", "文件夹的 kind 不是 folder"
assert by_id[doc]["kind"] == "doc", "文档的 kind 不是 doc"
assert by_id[folder]["title"] == "目录树根", "标题没有取 documents.title"
assert by_id[doc]["parentId"] == sub, "parentId 不对"
assert by_id[doc]["versionNo"] == 1, "文档的 versionNo 不是 1"
siblings = [d["kind"] for d in docs if d["parentId"] == folder]
assert siblings == sorted(siblings, key=lambda k: 0 if k == "folder" else 1), \
    "同级里文件夹没有排在文档之前"
print("  ✓ kind / 标题取 documents.title / 同级排序")
' "$body" "$TREE_FOLDER" "$TREE_SUB" "$TREE_DOC"

body="$(api PATCH "/api/documents/$TREE_DOC" "{\"parentId\":\"$TREE_FOLDER\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "移动文档 → 200"
body="$(api GET "/api/documents/$TREE_DOC" "" "$TOKEN_B")"
expect "$(field "$body" parentId)" "$TREE_FOLDER" "移动后 parentId 变了"

# 重命名**不产生新版本**——标题上移之后改名是节点元数据，不是内容变更
body="$(api PATCH "/api/documents/$TREE_DOC" '{"title":"目录树叶子（旧）"}' "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "重命名 → 200"
body="$(api GET "/api/documents/$TREE_DOC" "" "$TOKEN_B")"
expect "$(field "$body" title)" "目录树叶子（旧）" "重命名后标题变了"
expect "$(field "$body" versionNo)" "1" "重命名没有产生新版本"

say "目录树：非法操作必须被拒"

body="$(api POST "/api/documents" "{\"spaceId\":\"$SPACE_ID\",\"parentId\":\"$TREE_DOC\",\"title\":\"非法子节点\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "400" "文档下不许建子节点 → 400"

body="$(api POST "/api/documents" "{\"spaceId\":\"$SPACE_ID\",\"title\":\"非法文件夹\",\"content\":\"x\",\"kind\":\"folder\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "400" "文件夹不许带正文 → 400"

body="$(api PATCH "/api/documents/$TREE_FOLDER" "{\"parentId\":\"$TREE_SUB\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "400" "不能把节点移进自己的子树 → 400"

body="$(api PUT "/api/documents/$TREE_FOLDER" '{"title":"x","content":"y"}' "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "400" "文件夹不能保存正文 → 400"

body="$(api POST "/api/documents/$TREE_FOLDER/lock" "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "400" "文件夹不能取编辑锁 → 400"

say "目录树：文件夹不进检索"

# 文件夹没有 revision 因而没有 tsv，拿它的完整标题搜必须一条都命中不了。
# 中文走 stdin（argv 在 Windows git-bash 下会被转成 GBK，见本文件开头的说明）
body="$(printf '%s' '目录树根' | curl -sS --max-time 15 -G "$BASE/api/search" \
  --data-urlencode 'q@-' \
  -H "Accept: application/json" -H "Authorization: Bearer $TOKEN_B" \
  -w $'\n%{http_code}')"
STATUS="${body##*$'\n'}"
body="${body%$'\n'*}"
expect "$STATUS" "200" "按文件夹标题检索 → 200"
expect "$(field "$body" hits)" "[]" "文件夹不进检索结果"

say "会话有效期：滑动续期 + 绝对上限"
if [ -n "$(psql_kb 'SELECT 1')" ]; then
  body="$(api POST /api/auth/login '{"account":"smoke-admin","password":"smoke-pass-123"}')"
  STATUS="$(cat "$CODE_FILE")"
  expect "$STATUS" "200" "管理员重新登录，另取一条会话 → 200"
  TOKEN_S="$(field "$body" token)"
  [ -n "$TOKEN_S" ] || { echo "  ✗ 未拿到新会话 token" >&2; exit 1; }
  HASH_S="$(session_hash_sql "$TOKEN_S")"

  body="$(api GET /api/auth/me "" "$TOKEN_S")"
  STATUS="$(cat "$CODE_FILE")"
  expect "$STATUS" "200" "正常凭据仍然 200（滑动没弄坏正常路径）"

  # ① 快到期 → 用一次就被推到满窗口（免登录不再每 14 天破功）
  psql_kb "UPDATE sessions SET expires_at = now() + interval '1 hour' WHERE token_hash = $HASH_S" >/dev/null
  body="$(api GET /api/auth/me "" "$TOKEN_S")"
  STATUS="$(cat "$CODE_FILE")"
  expect "$STATUS" "200" "快到期时用一次 → 200"
  expect "$(psql_kb "SELECT (expires_at > now() + interval '13 days') FROM sessions WHERE token_hash = $HASH_S")" \
    "t" "窗口被续期推后（滑动生效）"

  # ② 绝对上限：created_at 推到 100 天前，expires_at 留在未来 → 仍然 401
  psql_kb "UPDATE sessions SET created_at = now() - interval '100 days' WHERE token_hash = $HASH_S" >/dev/null
  expect "$(psql_kb "SELECT (expires_at > now()) FROM sessions WHERE token_hash = $HASH_S")" \
    "t" "（前置）这条会话的 expires_at 确实还在未来"
  body="$(api GET /api/auth/me "" "$TOKEN_S")"
  STATUS="$(cat "$CODE_FILE")"
  expect "$STATUS" "401" "超过绝对上限 → 401（滑动兜不住的那一头）"

  # ③ 过期凭据照旧 401
  body="$(api POST /api/auth/login '{"account":"smoke-admin","password":"smoke-pass-123"}')"
  TOKEN_X="$(field "$body" token)"
  psql_kb "UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE token_hash = $(session_hash_sql "$TOKEN_X")" >/dev/null
  body="$(api GET /api/auth/me "" "$TOKEN_X")"
  STATUS="$(cat "$CODE_FILE")"
  expect "$STATUS" "401" "过期凭据 → 401"
else
  echo "  ⚠️ 拿不到冒烟栈的数据库句柄（非本机 -p kbsmoke 栈）——本段三条断言未执行"
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
