use polystore_gateway_gui_lib::bridge::BridgeManager;
use serde_json::json;

#[tokio::test]
async fn bridge_sign_flow_returns_signature() {
    let manager = BridgeManager::new();
    let payload = json!({
        "domain": { "name": "NilStore" },
        "message": { "creator": "0x0000000000000000000000000000000000000000" },
        "primaryType": "CreateDeal",
        "types": { "CreateDeal": [] }
    });

    let start = manager.start(payload).await.expect("start");
    let payload_response = reqwest::get(format!("{}/payload", start.url))
        .await
        .expect("payload response")
        .json::<serde_json::Value>()
        .await
        .expect("payload json");
    assert_eq!(
        payload_response
            .get("primaryType")
            .and_then(|val| val.as_str()),
        Some("CreateDeal")
    );

    let signature = "0xdeadbeef";
    let client = reqwest::Client::new();
    client
        .post(format!("{}/callback", start.url))
        .json(&json!({ "signature": signature }))
        .send()
        .await
        .expect("callback post");

    let signed = manager
        .wait(start.request_id)
        .await
        .expect("wait signature");
    assert_eq!(signed, signature);
}
