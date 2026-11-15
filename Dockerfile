# Update tags and digests together; Dependabot proposes reviewed base-image updates.
FROM node:24.22.3-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496 AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ src/
COPY public/ public/
COPY index.html vite.config.ts tsconfig*.json tailwind.config.js postcss.config.js ./
RUN npm run build:web

FROM rust:1.100.0-alpine3.24@sha256:de1e0058543a81ed7b046629167db587c67a94bdf37cce14eb27f0ec83baaffb AS backend
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY vendor/ vendor/
COPY crates/ crates/
COPY src-tauri/src/ src-tauri/src/
COPY src-tauri/Cargo.toml src-tauri/
COPY src-tauri/build.rs src-tauri/
COPY --from=frontend /app/dist dist/
RUN cargo build --locked -p session-web --release

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache ca-certificates
COPY --from=backend /app/target/release/session-web /usr/local/bin/
EXPOSE 3000
ENTRYPOINT ["session-web", "--host", "0.0.0.0"]
