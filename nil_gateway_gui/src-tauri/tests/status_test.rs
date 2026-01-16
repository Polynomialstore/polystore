use nil_gateway_gui_lib::api::{GatewayClient, GatewayStatusResponse};
use nil_gateway_gui_lib::sidecar::SidecarManager;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

fn spawn_status_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");

    thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let body = serde_json::to_string(&GatewayStatusResponse {
                version: "dev".to_string(),
                git_sha: "abc123".to_string(),
                build_time: "2026-01-16".to_string(),
                mode: "standalone".to_string(),
                listening_addr: addr.to_string(),
                provider_base: None,
                p2p_addrs: None,
                capabilities: [("upload".to_string(), true)].into_iter().collect(),
                deps: [("lcd_reachable".to_string(), false)].into_iter().collect(),
                extra: None,
            })
            .expect("json");
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
    let base_url = spawn_status_server();
    let client = GatewayClient::new(base_url);
    let status = client.status().await.expect("status");
    assert_eq!(status.mode, "standalone");
    assert!(status.capabilities.get("upload").copied().unwrap_or(false));
}

#[test]
fn sidecar_manager_base_url_can_be_set_for_tests() {
    let manager = SidecarManager::new();
    manager.set_base_url_for_tests("http://127.0.0.1:1234".to_string());
    let url = manager.base_url().expect("base_url");
    assert_eq!(url, "http://127.0.0.1:1234");
}
