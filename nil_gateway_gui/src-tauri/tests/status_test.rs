use nil_gateway_gui_lib::api::{GatewayClient, GatewayStatusResponse};
use nil_gateway_gui_lib::sidecar::SidecarManager;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

fn sample_status(listening_addr: String) -> GatewayStatusResponse {
    GatewayStatusResponse {
        version: "dev".to_string(),
        git_sha: "abc123".to_string(),
        build_time: "2026-01-16".to_string(),
        persona: Some("user-gateway".to_string()),
        mode: "standalone".to_string(),
        allowed_route_families: Some(vec!["gateway".to_string()]),
        listening_addr,
        managed: Some(false),
        provider_base: None,
        p2p_addrs: None,
        capabilities: [("upload".to_string(), true)].into_iter().collect(),
        deps: [("lcd_reachable".to_string(), false)].into_iter().collect(),
        extra: None,
    }
}

fn spawn_status_server(payload: GatewayStatusResponse) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");

    thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let body = serde_json::to_string(&payload).expect("json");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });

    format!("http://{}", addr)
}

#[tokio::test]
async fn gateway_client_status_ok() {
    let listening_addr = "127.0.0.1:8080".to_string();
    let base_url = spawn_status_server(sample_status(listening_addr));
    let client = GatewayClient::new(base_url);
    let status = client.status().await.expect("status");
    assert_eq!(status.mode, "standalone");
    assert!(status.capabilities.get("upload").copied().unwrap_or(false));
}

#[tokio::test]
async fn gateway_client_status_rejects_provider_daemon_persona() {
    let mut payload = sample_status("127.0.0.1:8080".to_string());
    payload.persona = Some("provider-daemon".to_string());
    payload.allowed_route_families = Some(vec!["sp".to_string(), "sp/retrieval".to_string()]);
    let base_url = spawn_status_server(payload);
    let client = GatewayClient::new(base_url);
    let err = client
        .status()
        .await
        .expect_err("provider-daemon status should be rejected");
    assert!(err.contains("provider-daemon"));
}

#[tokio::test]
async fn gateway_client_status_rejects_missing_gateway_routes() {
    let mut payload = sample_status("127.0.0.1:8080".to_string());
    payload.allowed_route_families = Some(vec!["sp".to_string(), "sp/retrieval".to_string()]);
    let base_url = spawn_status_server(payload);
    let client = GatewayClient::new(base_url);
    let err = client
        .status()
        .await
        .expect_err("status without gateway route family should be rejected");
    assert!(err.contains("does not expose gateway route family"));
}

#[test]
fn sidecar_manager_base_url_can_be_set_for_tests() {
    let manager = SidecarManager::new();
    manager.set_base_url_for_tests("http://127.0.0.1:1234".to_string());
    let url = manager.base_url().expect("base_url");
    assert_eq!(url, "http://127.0.0.1:1234");
}

#[test]
fn sidecar_manager_normalizes_base_url() {
    let manager = SidecarManager::new();
    manager
        .set_base_url("127.0.0.1:8080".to_string())
        .expect("set base url");
    let url = manager.base_url().expect("base_url");
    assert_eq!(url, "http://127.0.0.1:8080");
}

#[test]
fn sidecar_manager_rejects_untrusted_base_url() {
    let manager = SidecarManager::new();
    let err = manager
        .set_base_url("http://127.0.0.1:8081".to_string())
        .expect_err("non-8080 endpoint must be rejected");
    assert!(err.contains("untrusted gateway endpoint"));
}
