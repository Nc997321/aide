import { invoke } from "@tauri-apps/api/core";
import type {
    CommitEntry,
    CommitDetail,
    BranchInfo,
    GitStatus,
} from "../types";

export const gitApi = {
    async log(limit?: number, branch?: string): Promise<CommitEntry[]> {
        return invoke("git_log", { limit, branch });
    },

    async show(hash: string): Promise<CommitDetail> {
        return invoke("git_show", { hash });
    },

    async diffContent(path: string, staged?: boolean, commitHash?: string): Promise<string> {
        return invoke("git_diff_content", { path, staged, commitHash });
    },

    async branches(): Promise<BranchInfo[]> {
        return invoke("git_branches");
    },

    async checkout(branch: string): Promise<void> {
        return invoke("git_checkout", { branch });
    },

    async status(): Promise<GitStatus> {
        return invoke("git_status");
    },

    async commit(message: string): Promise<string> {
        return invoke("git_commit", { message });
    },

    async stageFile(path: string): Promise<void> {
        return invoke("git_stage_file", { path });
    },

    async unstageFile(path: string): Promise<void> {
        return invoke("git_unstage_file", { path });
    },

    async stageAll(): Promise<void> {
        return invoke("git_stage_all");
    },

    async revertFile(path: string): Promise<void> {
        return invoke("git_revert_file", { path });
    },
};
