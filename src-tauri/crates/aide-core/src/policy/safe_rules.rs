//! 信任工作区自动写入的安全只读命令白名单。
//!
//! `trust_workspace` 时把纯只读命令（grep/cat/head…）以稳定 UUID id 写入 local
//! scope（`.aide/settings.local.json`，per-project + 本机，不进 git），减少链式命令
//! （`cmd | grep x`）里管道后段每次弹 Aide 权限窗。`untrust_workspace` 对称删除
//! 自动规则，取消信任即回到原权限态。
//!
//! 规则 id 由 `auto-safe-<cmd>` 用稳定 FNV-1a 哈希派生成 UUID 形状（settings store
//! 强制规则 id 必须过 `is_uuid` 校验）——同一命令永远同一 id，untrust 时重新生成
//! 即可精确删除，无需额外状态，也不会误删用户手动规则。
//!
//! 幂等：写入前检查 local scope 是否已有同 (tool, matcher) 规则，用户手动加的或
//! 上次自动写的都跳过。安全模型不变——链式分段仍要求每段独立命中 allow，自动规则
//! 只覆盖纯只读命令，危险命令（rm/tee/xargs/sed/sort/awk/find/curl）不在清单。

use std::path::Path;

use serde_json::Value;

use crate::settings::{
    PermissionEffect, SettingsError, SettingsScope, SettingsService, StoredPermissionRule,
};

/// 纯只读安全命令清单：全无文件写入 / 命令执行能力。`cd` 是 shell 内建，只改会话
/// 工作目录，每条命令独立评估，不会给后续命令授新权限。不含 sort（`-o` 能写文件）、
/// sed/awk/tee/xargs/find/curl 等（能写文件或能执行命令）。
pub(crate) const SAFE_COMMANDS: &[&str] = &[
    "cd", "grep", "cat", "head", "tail", "wc", "uniq", "cut", "tr", "ls", "diff",
];

/// 自动规则 id 的派生输入前缀：`auto-safe-<cmd>` 哈希出稳定 UUID，untrust 时重算。
pub(crate) const AUTO_SAFE_ID_PREFIX: &str = "auto-safe-";

/// 稳定 128 位 FNV-1a 双哈希 → UUID 形状的确定性 id。同一命令永远同一 id；
/// settings store 的 `is_uuid` 校验只查 36 字符 + 固定 dash 位 + hex，此格式满足。
fn auto_safe_rule_id(cmd: &str) -> String {
    fn fnv1a64(bytes: &[u8], offset: u64, prime: u64) -> u64 {
        let mut h = offset;
        for &b in bytes {
            h ^= b as u64;
            h = h.wrapping_mul(prime);
        }
        h
    }
    let input = format!("{AUTO_SAFE_ID_PREFIX}{cmd}");
    let h1 = fnv1a64(
        input.as_bytes(),
        0xcbf2_9ce4_8422_2325,
        0x0000_0100_0000_01b3,
    );
    let h2 = fnv1a64(
        input.as_bytes(),
        0x8422_2325_cbf2_9ce3,
        0x0000_0001_0000_01b3,
    );
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        (h1 >> 32) as u32,
        ((h1 >> 16) & 0xFFFF) as u16,
        (h1 & 0xFFFF) as u16,
        ((h2 >> 48) & 0xFFFF) as u16,
        h2 & 0xFFFF_FFFF_FFFF,
    )
}

/// 全部安全命令的确定性 id 集合（untrust 删除用）。
fn auto_safe_ids() -> std::collections::HashSet<String> {
    SAFE_COMMANDS.iter().map(|c| auto_safe_rule_id(c)).collect()
}

/// 目标规则的 matcher JSON（`{"kind":"bash","mode":"prefix","value":"<cmd>"}`）。
fn prefix_matcher(cmd: &str) -> Value {
    serde_json::json!({ "kind": "bash", "mode": "prefix", "value": cmd })
}

/// 幂等写入安全命令白名单到 local scope，返回**新增条数**。已存在同 (tool, matcher)
/// 规则（用户手动加的或上次自动写的）跳过；文件不存在时由 settings store 自动创建。
pub fn ensure_safe_rules(
    service: &SettingsService,
    project: &Path,
) -> Result<usize, SettingsError> {
    let mut added = 0usize;
    service.mutate_scope_blocking(SettingsScope::Local, Some(project), |doc| {
        for cmd in SAFE_COMMANDS {
            let matcher = prefix_matcher(cmd);
            if doc
                .permissions
                .rules
                .iter()
                .any(|r| r.tool == "Bash" && r.matcher == matcher)
            {
                continue;
            }
            let next_order = doc
                .permissions
                .rules
                .iter()
                .map(|r| r.order)
                .max()
                .unwrap_or(-1)
                .saturating_add(1);
            doc.permissions.rules.push(StoredPermissionRule {
                id: auto_safe_rule_id(cmd),
                effect: PermissionEffect::Allow,
                tool: "Bash".into(),
                matcher,
                order: next_order,
            });
            added += 1;
        }
        Ok(())
    })?;
    Ok(added)
}

/// 删除 local scope 里的自动规则（id ∈ 安全命令确定性 id 集合），返回**删除条数**。
/// 用户手动规则保留。无自动规则时返回 0，不报错。
pub fn remove_safe_rules(
    service: &SettingsService,
    project: &Path,
) -> Result<usize, SettingsError> {
    let auto_ids = auto_safe_ids();
    let mut removed = 0usize;
    service.mutate_scope_blocking(SettingsScope::Local, Some(project), |doc| {
        let before = doc.permissions.rules.len();
        doc.permissions.rules.retain(|r| !auto_ids.contains(&r.id));
        removed = before - doc.permissions.rules.len();
        Ok(())
    })?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{MemorySecretStore, SettingsDocument, SettingsPaths};
    use std::sync::Arc;

    fn test_service(root: &Path) -> SettingsService {
        let paths = SettingsPaths::for_test(root.to_path_buf());
        let service = SettingsService::new(paths, Arc::new(MemorySecretStore::default()));
        service.initialize_blocking().expect("init");
        service
    }

    /// 读 local scope 的合并文档（从 effective 层取 Local 层）。
    fn local_doc(service: &SettingsService, project: &Path) -> SettingsDocument {
        service
            .effective_document_blocking(Some(project))
            .expect("effective")
            .documents
            .into_iter()
            .find(|d| d.scope == SettingsScope::Local)
            .expect("local layer")
            .document
    }

    fn rule_ids(doc: &SettingsDocument) -> Vec<String> {
        doc.permissions.rules.iter().map(|r| r.id.clone()).collect()
    }

    /// 用户手动规则的 UUID 形状 id（settings store 校验规则 id 必须过 is_uuid）。
    fn user_id(n: u64) -> String {
        format!("00000000-0000-4000-8000-{n:012x}")
    }

    /// 每个测试独立的临时根目录 + 项目目录（cargo 并行跑测试，共享目录会互相抢文件）。
    fn setup(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("ws-safe-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let project = root.join("proj");
        std::fs::create_dir_all(&project).unwrap();
        (root, project)
    }

    #[test]
    fn ensure_writes_all_safe_commands_to_local_scope() {
        let (root, project) = setup("ensure-writes");
        let service = test_service(&root);

        let added = ensure_safe_rules(&service, &project).unwrap();
        assert_eq!(added, SAFE_COMMANDS.len());

        let doc = local_doc(&service, &project);
        let ids = rule_ids(&doc);
        assert_eq!(ids.len(), SAFE_COMMANDS.len());
        for cmd in SAFE_COMMANDS {
            let id = auto_safe_rule_id(cmd);
            assert!(ids.contains(&id), "missing {id}");
            let rule = doc.permissions.rules.iter().find(|r| r.id == id).unwrap();
            assert_eq!(rule.tool, "Bash");
            assert_eq!(rule.matcher, prefix_matcher(cmd));
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_is_idempotent_and_skips_user_rules() {
        let (root, project) = setup("ensure-idempotent");
        let service = test_service(&root);

        assert_eq!(
            ensure_safe_rules(&service, &project).unwrap(),
            SAFE_COMMANDS.len()
        );
        // 二调幂等
        assert_eq!(ensure_safe_rules(&service, &project).unwrap(), 0);

        // 用户手动加一条同 (tool, matcher) 的 grep 规则，再 ensure 也不重复写
        service
            .mutate_scope_blocking(SettingsScope::Local, Some(&project), |doc| {
                doc.permissions.rules.push(StoredPermissionRule {
                    id: user_id(1),
                    effect: PermissionEffect::Allow,
                    tool: "Bash".into(),
                    matcher: prefix_matcher("grep"),
                    order: 999,
                });
                Ok(())
            })
            .unwrap();
        assert_eq!(ensure_safe_rules(&service, &project).unwrap(), 0);
        let doc = local_doc(&service, &project);
        assert!(rule_ids(&doc).contains(&user_id(1)));
        assert!(rule_ids(&doc).contains(&auto_safe_rule_id("grep")));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_only_deletes_auto_safe_rules() {
        let (root, project) = setup("remove-only");
        let service = test_service(&root);

        ensure_safe_rules(&service, &project).unwrap();
        service
            .mutate_scope_blocking(SettingsScope::Local, Some(&project), |doc| {
                doc.permissions.rules.push(StoredPermissionRule {
                    id: user_id(2),
                    effect: PermissionEffect::Allow,
                    tool: "Bash".into(),
                    matcher: prefix_matcher("diff"),
                    order: 999,
                });
                Ok(())
            })
            .unwrap();

        let removed = remove_safe_rules(&service, &project).unwrap();
        assert_eq!(removed, SAFE_COMMANDS.len());

        let doc = local_doc(&service, &project);
        assert!(rule_ids(&doc).contains(&user_id(2)));
        let auto_ids = auto_safe_ids();
        assert!(!rule_ids(&doc).iter().any(|id| auto_ids.contains(id)));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_with_no_auto_rules_returns_zero() {
        let (root, project) = setup("remove-zero");
        let service = test_service(&root);

        assert_eq!(remove_safe_rules(&service, &project).unwrap(), 0);
        std::fs::remove_dir_all(&root).ok();
    }
}
