use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use serde_json::Value;
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, Clone, serde::Serialize)]
pub struct BridgeStartResponse {
    pub request_id: String,
    pub url: String,
}

struct BridgeSession {
    signature_rx: Option<oneshot::Receiver<String>>,
}

#[derive(Default)]
pub struct BridgeManager {
    sessions: Mutex<HashMap<String, BridgeSession>>,
    counter: AtomicU64,
}

impl BridgeManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(1),
        }
    }

    pub async fn start(&self, payload: Value) -> Result<BridgeStartResponse, String> {
        let (sig_tx, sig_rx) = oneshot::channel();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|err| format!("bridge bind failed: {err}"))?;
        let addr = listener
            .local_addr()
            .map_err(|err| format!("bridge addr failed: {err}"))?;

        let request_id = format!("bridge-{}", self.counter.fetch_add(1, Ordering::SeqCst));
        let payload = Arc::new(payload);
        let sig_tx = Arc::new(Mutex::new(Some(sig_tx)));
        let shutdown_tx = Arc::new(Mutex::new(Some(shutdown_tx)));
        let payload_clone = payload.clone();
        let sig_tx_clone = sig_tx.clone();
        let shutdown_clone = shutdown_tx.clone();

        let make_svc = make_service_fn(move |_| {
            let payload = payload_clone.clone();
            let sig_tx = sig_tx_clone.clone();
            let shutdown_tx = shutdown_clone.clone();
            async move {
                Ok::<_, Infallible>(service_fn(move |req| {
                    handle_bridge_request(req, payload.clone(), sig_tx.clone(), shutdown_tx.clone())
                }))
            }
        });

        let server = Server::from_tcp(listener)
            .map_err(|err| format!("bridge server failed: {err}"))?
            .serve(make_svc)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });

        tokio::spawn(async move {
            let _ = server.await;
        });

        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            request_id.clone(),
            BridgeSession {
                signature_rx: Some(sig_rx),
            },
        );

        Ok(BridgeStartResponse {
            request_id,
            url: format!("http://{addr}"),
        })
    }

    pub async fn wait(&self, request_id: String) -> Result<String, String> {
        let rx = {
            let mut sessions = self.sessions.lock().await;
            let session = sessions
                .get_mut(&request_id)
                .ok_or_else(|| "bridge request not found".to_string())?;
            session
                .signature_rx
                .take()
                .ok_or_else(|| "bridge request already consumed".to_string())?
        };

        let result = tokio::time::timeout(Duration::from_secs(180), rx)
            .await
            .map_err(|_| "bridge signature timed out".to_string())?
            .map_err(|_| "bridge signature channel closed".to_string())?;

        let mut sessions = self.sessions.lock().await;
        sessions.remove(&request_id);
        Ok(result)
    }
}

async fn handle_bridge_request(
    req: Request<Body>,
    payload: Arc<Value>,
    sig_tx: Arc<Mutex<Option<oneshot::Sender<String>>>>,
    shutdown_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
) -> Result<Response<Body>, Infallible> {
    match (req.method(), req.uri().path()) {
        (&Method::GET, "/") => Ok(Response::new(Body::from(bridge_html()))),
        (&Method::GET, "/payload") => {
            let body = serde_json::to_vec(&*payload).unwrap_or_default();
            Ok(Response::builder()
                .header("Content-Type", "application/json")
                .status(StatusCode::OK)
                .body(Body::from(body))
                .unwrap())
        }
        (&Method::POST, "/callback") => {
            let body_bytes = hyper::body::to_bytes(req.into_body())
                .await
                .unwrap_or_default();
            let signature = serde_json::from_slice::<Value>(&body_bytes)
                .ok()
                .and_then(|val| {
                    val.get("signature")
                        .and_then(|sig| sig.as_str())
                        .map(|sig| sig.to_string())
                });
            let response = match signature {
                Some(signature) => {
                    let mut guard = sig_tx.lock().await;
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(signature);
                    }
                    let mut guard = shutdown_tx.lock().await;
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(());
                    }
                    Response::new(Body::from("{\"status\":\"ok\"}"))
                }
                None => Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Body::from("{\"error\":\"missing signature\"}"))
                    .unwrap(),
            };
            Ok(response)
        }
        _ => Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .unwrap()),
    }
}

fn bridge_html() -> &'static str {
    r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>NilGateway Signature Bridge</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 32px; }
      .card { max-width: 520px; padding: 24px; border: 1px solid #ddd; border-radius: 12px; }
      .status { margin-top: 12px; font-size: 14px; color: #555; }
      button { padding: 10px 16px; border-radius: 8px; border: none; background: #111827; color: #fff; cursor: pointer; }
      button:disabled { opacity: 0.6; cursor: not-allowed; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>NilGateway Authorization</h1>
      <p>Use MetaMask to sign the PolyStore intent.</p>
      <button id="sign">Sign with MetaMask</button>
      <div class="status" id="status">Waiting for wallet...</div>
    </div>
    <script>
      const statusEl = document.getElementById("status");
      const signButton = document.getElementById("sign");
      const setStatus = (text) => { statusEl.textContent = text; };

      async function signTypedData() {
        if (!window.ethereum) {
          setStatus("MetaMask not detected. Install the extension first.");
          signButton.disabled = true;
          return;
        }
        try {
          setStatus("Loading payload...");
          const payload = await fetch("/payload").then((res) => res.json());
          const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
          const account = accounts[0];
          setStatus("Requesting signature...");
          const signature = await window.ethereum.request({
            method: "eth_signTypedData_v4",
            params: [account, JSON.stringify(payload)],
          });
          setStatus("Sending signature back to app...");
          await fetch("/callback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ signature, address: account }),
          });
          setStatus("Done. You can close this tab.");
          signButton.disabled = true;
        } catch (err) {
          setStatus(`Signature failed: ${err?.message || err}`);
        }
      }

      signButton.addEventListener("click", signTypedData);
    </script>
  </body>
</html>
"#
}
