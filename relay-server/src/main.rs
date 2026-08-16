use aide_relay::state::{RelayState, SharedState};
use aide_relay::run;
use std::sync::{Arc, Mutex};

#[tokio::main]
async fn main() {
    let addr = std::env::var("RELAY_ADDR").unwrap_or_else(|_| "0.0.0.0:8787".to_string());
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind relay addr");
    eprintln!("aide-relay listening on {addr}");
    let state: SharedState = Arc::new(Mutex::new(RelayState::default()));
    run(listener, state).await;
}
