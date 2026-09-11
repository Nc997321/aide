//! 端口层：能力契约（`engine`）+ 领域类型（`types`）。零第三方重依赖、零平台细节。

pub mod engine;
pub mod types;

#[cfg(test)]
mod types_test;
