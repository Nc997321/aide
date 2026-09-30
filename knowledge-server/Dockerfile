# 多阶段构建：编译在完整的 rust 镜像里，运行只带一个二进制。
# edition 2024 需要 Rust 1.85+。⚠️ 版本要对齐「生成 Cargo.lock 的工具链」：
# 本机 rustc 1.96 解析出的依赖（syn 3 / icu 2.3 / time 0.3.55）MSRV 都高于 1.85，
# 钉旧版本会在容器里报 "requires rustc 1.xx or newer"。升本机工具链时同步升这里。
FROM rust:1.96-bookworm AS build

WORKDIR /src
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*

COPY . .
RUN cargo build --release --bin aide-knowledge

FROM debian:bookworm-slim

# 构建期注入版本号：`docker build --build-arg KB_VERSION=0.5.0`（release.sh 会带）。
# 为什么从构建期来，而不是读 crate 的 version：**镜像标签与 crate 版本是两条线**，
# 客户端要判定「服务端够不够新」只能用镜像那个号。不带参数时是 `dev`——
# 本地 `up -d --build` 出来的就是这个，客户端见 `dev` 不提示升级。
ARG KB_VERSION=dev
ENV KB_VERSION=${KB_VERSION}

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/aide-knowledge /usr/local/bin/aide-knowledge

# ⚠️ 路径必须是 /src/migrations，不能改成 /app/migrations。
#    src/db.rs 用 env!("CARGO_MANIFEST_DIR") 拼迁移目录，那是**编译期**常量，
#    在 build 阶段就等于 /src。要改这里，得先让 db.rs 支持运行时覆盖。
COPY migrations /src/migrations

WORKDIR /app
ENV KB_HOST=0.0.0.0 \
    KB_PORT=8788 \
    KB_STORAGE_DIR=/app/storage

EXPOSE 8788
VOLUME /app/storage

CMD ["aide-knowledge"]
