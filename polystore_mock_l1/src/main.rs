use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time;
use tracing::{info, level_filters::LevelFilter};
use tracing_subscriber::EnvFilter;

#[derive(Clone)]
struct AppState {
    state: Arc<Mutex<ChainState>>,
}

struct ChainState {
    block_height: u64,
    files: HashMap<String, FileMetadata>, // filename -> metadata
    // Mock balances for now?
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct FileMetadata {
    filename: String,
    root_hash: String,
    size: u64,
    owner: String,
}

#[derive(Deserialize)]
struct StoreRequest {
    filename: String,
    root_hash: String,
    size: u64,
    owner: String,
}

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::builder()
                .with_default_directive(LevelFilter::INFO.into())
                .from_env_lossy(),
        )
        .init();

    let chain_state = Arc::new(Mutex::new(ChainState {
        block_height: 0,
        files: HashMap::new(),
    }));

    let app_state = AppState {
        state: chain_state.clone(),
    };

    // Background block production
    let block_state = chain_state.clone();
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_secs(5)); // 5s block time
        loop {
            interval.tick().await;
            let mut state = block_state.lock().unwrap();
            state.block_height += 1;
            info!("⛏️  Mined block {}", state.block_height);
        }
    });

    let app = Router::new()
        .route("/status", get(get_status))
        .route("/store", post(store_file))
        .with_state(app_state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await.unwrap();
    info!("🚀 Mock L1 listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.unwrap();
}

async fn get_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    let state = state.state.lock().unwrap();
    Json(serde_json::json!({
        "block_height": state.block_height,
        "files_stored": state.files.len(),
    }))
}

async fn store_file(
    State(state): State<AppState>,
    Json(payload): Json<StoreRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let mut state = state.state.lock().unwrap();
    
    if state.files.contains_key(&payload.filename) {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "File already exists" })),
        );
    }

    let meta = FileMetadata {
        filename: payload.filename.clone(),
        root_hash: payload.root_hash,
        size: payload.size,
        owner: payload.owner,
    };

    info!("💾 Stored file metadata: {}", payload.filename);
    
    state.files.insert(payload.filename, meta);

    (
        StatusCode::CREATED,
        Json(serde_json::json!({ "status": "success", "height": state.block_height })),
    )
}