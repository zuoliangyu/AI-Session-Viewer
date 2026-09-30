use clap::Parser;

#[derive(Parser, Debug, Clone)]
#[command(name = "session-web", about = "AI Session Viewer Web Server")]
pub struct Config {
    /// Host to bind to. Defaults to loopback; pass 0.0.0.0 (with --token) to
    /// expose the server on the network.
    #[arg(long, default_value = "127.0.0.1", env = "ASV_HOST")]
    pub host: String,

    /// Port to listen on
    #[arg(long, default_value_t = 3000, env = "ASV_PORT")]
    pub port: u16,

    /// Bearer token for authentication. Required when binding to a
    /// non-loopback address unless --allow-no-auth is set.
    #[arg(long, env = "ASV_TOKEN")]
    pub token: Option<String>,

    /// Allow binding to a non-loopback address without a token (unsafe:
    /// anyone who can reach the port can drive the local CLIs).
    #[arg(long, env = "ASV_ALLOW_NO_AUTH")]
    pub allow_no_auth: bool,

    /// Extra browser origins allowed to open WebSockets, comma separated
    /// (e.g. a reverse-proxy domain). Same-origin, loopback and the desktop
    /// app are always allowed.
    #[arg(long, env = "ASV_ALLOWED_ORIGINS", value_delimiter = ',')]
    pub allowed_origins: Vec<String>,

    /// Let chat clients request `--dangerously-skip-permissions`.
    #[arg(long, env = "ASV_ALLOW_SKIP_PERMISSIONS")]
    pub allow_skip_permissions: bool,

    /// Let chat clients supply their own API key / base URL for the CLI.
    #[arg(long, env = "ASV_ALLOW_CLIENT_CREDENTIALS")]
    pub allow_client_credentials: bool,
}
