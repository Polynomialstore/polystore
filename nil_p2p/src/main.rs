use anyhow::Result;
use clap::Parser;
use nil_p2p::{Command, NilNode};
use tokio::sync::mpsc;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "nil-p2p")]
struct Cli {
    #[arg(long, default_value = "0")]
    port: u16,

    #[arg(long, default_value = "0")]
    seed: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("nil_p2p=info".parse().unwrap()))
        .init();

    let cli = Cli::parse();

    let (tx, rx) = mpsc::channel(32);

    let node = NilNode::new(cli.seed, cli.port, rx).await?;
    
    // Spawn the node
    tokio::spawn(async move {
        if let Err(e) = node.run().await {
            eprintln!("Node error: {:?}", e);
        }
    });

    info!("Node started. Type 'announce <shard_id>' or 'dial <addr>'");

    // Simple REPL
    let stdin = std::io::stdin();
    let mut line = String::new();
    while stdin.read_line(&mut line).is_ok() {
        let parts: Vec<&str> = line.trim().split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }

        match parts[0] {
            "announce" => {
                if parts.len() > 1 {
                    tx.send(Command::AnnounceShard { shard_id: parts[1].to_string() }).await?;
                } else {
                    println!("Usage: announce <shard_id>");
                }
            }
            "dial" => {
                if parts.len() > 1 {
                     if let Ok(addr) = parts[1].parse() {
                         tx.send(Command::Dial { addr }).await?;
                     } else {
                         println!("Invalid multiaddr");
                     }
                }
            }
            "proxy" => {
                if parts.len() > 2 {
                    tx.send(Command::RequestProxy { cid: parts[1].to_string(), deputy: parts[2].to_string() }).await?;
                } else {
                    println!("Usage: proxy <cid> <deputy_peer_id>");
                }
            }
            "quit" | "exit" => break,
            _ => println!("Unknown command"),
        }
        line.clear();
    }

    Ok(())
}
