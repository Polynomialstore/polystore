use anyhow::Result;
use futures::StreamExt;
use libp2p::{
    gossipsub, mdns, noise, swarm::NetworkBehaviour, swarm::SwarmEvent, tcp, yamux, Multiaddr, PeerId, Swarm, SwarmBuilder,
    Transport,
};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, error};

// --- Messages ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShardAnnouncement {
    pub shard_id: String,
    pub owner_peer_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskForProxy {
    pub cid: String,
    pub target_peer: String,
    pub max_price: u64,
}

// --- Network Behaviour ---

#[derive(NetworkBehaviour)]
struct NilBehaviour {
    gossipsub: gossipsub::Behaviour,
    mdns: mdns::tokio::Behaviour,
}

// --- Main Node Struct ---

pub struct NilNode {
    swarm: Swarm<NilBehaviour>,
    command_rx: mpsc::Receiver<Command>,
}

pub enum Command {
    AnnounceShard { shard_id: String },
    Dial { addr: Multiaddr },
    RequestProxy { cid: String, deputy: String },
}

impl NilNode {
    pub async fn new(
        _secret_key_seed: u64, // Ignored for now, generating random identity
        port: u16,
        command_rx: mpsc::Receiver<Command>
    ) -> Result<Self> {
        
        // 1. Swarm Builder (libp2p v0.53+)
        let mut swarm = SwarmBuilder::with_new_identity()
            .with_tokio()
            .with_tcp(
                tcp::Config::default(),
                noise::Config::new,
                yamux::Config::default,
            )?
            .with_behaviour(|key| {
                 // 2. Gossipsub
                let message_id_fn = |message: &gossipsub::Message| {
                    let mut s = DefaultHasher::new();
                    message.data.hash(&mut s);
                    gossipsub::MessageId::from(s.finish().to_string())
                };

                let gossipsub_config = gossipsub::ConfigBuilder::default()
                    .heartbeat_interval(Duration::from_secs(10))
                    .validation_mode(gossipsub::ValidationMode::Strict)
                    .message_id_fn(message_id_fn)
                    .build()
                    .map_err(|msg| std::io::Error::new(std::io::ErrorKind::Other, msg))?;

                let gossipsub = gossipsub::Behaviour::new(
                    gossipsub::MessageAuthenticity::Signed(key.clone()),
                    gossipsub_config,
                ).map_err(|msg| std::io::Error::new(std::io::ErrorKind::Other, msg))?;

                // 3. MDNS
                let mdns = mdns::tokio::Behaviour::new(
                    mdns::Config::default(), 
                    key.public().to_peer_id()
                )?;
                
                Ok(NilBehaviour { gossipsub, mdns })
            })?
            .with_swarm_config(|cfg| cfg.with_idle_connection_timeout(Duration::from_secs(60)))
            .build();

        let peer_id = *swarm.local_peer_id();
        info!("Local Peer ID: {}", peer_id);

        // Listen
        let listen_addr = format!("/ip4/0.0.0.0/tcp/{}", port).parse()?;
        swarm.listen_on(listen_addr)?;

        // Subscribe to default topics
        swarm.behaviour_mut().gossipsub.subscribe(&gossipsub::IdentTopic::new("nil-shards"))
             .map_err(|_| anyhow::anyhow!("Failed to subscribe to nil-shards"))?;
        swarm.behaviour_mut().gossipsub.subscribe(&gossipsub::IdentTopic::new("nil-proxy"))
             .map_err(|_| anyhow::anyhow!("Failed to subscribe to nil-proxy"))?;

        Ok(Self { swarm, command_rx })
    }

    pub async fn run(mut self) -> Result<()> {
        loop {
            tokio::select! {
                // Handle User Commands
                Some(cmd) = self.command_rx.recv() => {
                    match cmd {
                        Command::AnnounceShard { shard_id } => {
                            let msg = ShardAnnouncement {
                                shard_id: shard_id.clone(),
                                owner_peer_id: self.swarm.local_peer_id().to_string(),
                            };
                            let encoded = serde_json::to_vec(&msg)?;
                            let topic = gossipsub::IdentTopic::new("nil-shards");
                            
                            if let Err(e) = self.swarm.behaviour_mut().gossipsub.publish(topic, encoded) {
                                error!("Publish error: {:?}", e);
                            } else {
                                info!("📢 Announced shard: {}", shard_id);
                            }
                        }
                        Command::Dial { addr } => {
                             if let Err(e) = self.swarm.dial(addr.clone()) {
                                 error!("Dial error: {:?}", e);
                             } else {
                                 info!("📞 Dialing {}", addr);
                             }
                        }
                        Command::RequestProxy { cid, deputy } => {
                            let msg = AskForProxy {
                                cid: cid.clone(),
                                target_peer: deputy.clone(),
                                max_price: 100,
                            };
                            let encoded = serde_json::to_vec(&msg)?;
                            let topic = gossipsub::IdentTopic::new("nil-proxy");
                            
                            if let Err(e) = self.swarm.behaviour_mut().gossipsub.publish(topic, encoded) {
                                error!("Publish proxy error: {:?}", e);
                            } else {
                                info!("🕵️‍♀️ Requested proxy for {} via {}", cid, deputy);
                            }
                        }
                    }
                }

                // Handle Network Events
                event = self.swarm.select_next_some() => {
                    match event {
                        SwarmEvent::NewListenAddr { address, .. } => {
                            info!("👂 Listening on {:?}", address);
                        }
                        SwarmEvent::Behaviour(NilBehaviourEvent::Mdns(mdns::Event::Discovered(list))) => {
                            for (peer_id, _multiaddr) in list {
                                info!("👀 mDNS discovered: {:?}", peer_id);
                                self.swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                            }
                        }
                        SwarmEvent::Behaviour(NilBehaviourEvent::Mdns(mdns::Event::Expired(list))) => {
                            for (peer_id, _multiaddr) in list {
                                info!("😴 mDNS expired: {:?}", peer_id);
                                self.swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer_id);
                            }
                        }
                        SwarmEvent::Behaviour(NilBehaviourEvent::Gossipsub(gossipsub::Event::Message {
                            propagation_source: peer_id,
                            message_id: _,
                            message,
                        })) => {
                            // Try to decode as ShardAnnouncement
                            if let Ok(announcement) = serde_json::from_slice::<ShardAnnouncement>(&message.data) {
                                info!("📨 Received announcement from {}: Shard {}", peer_id, announcement.shard_id);
                            }
                            // Try to decode as AskForProxy
                            if let Ok(proxy_req) = serde_json::from_slice::<AskForProxy>(&message.data) {
                                info!("🕵️‍♀️ Received PROXY REQUEST from {}: Need CID {} via Peer {}", peer_id, proxy_req.cid, proxy_req.target_peer);
                                
                                // Logic: Am I the deputy?
                                let my_id = self.swarm.local_peer_id().to_string();
                                if proxy_req.target_peer == my_id {
                                    info!("✅ I am the deputy! Handling proxy request...");
                                    // 1. "Fetch" data from the *actual* target (not in message, usually implicitly the Deal SP)
                                    // For Phase 2, we just simulate the fetch delay.
                                    info!("   Fetching CID {} from network...", proxy_req.cid);
                                    
                                    // 2. "Verify" (Simulate KZG check)
                                    info!("   Verifying KZG proof... OK.");
                                    
                                    // 3. "Return" (Simulate sending data back)
                                    // In a real implementation, we would open a direct stream to 'peer_id' (requester)
                                    // and pipe the data. For now, we just log.
                                    info!("   Streaming data back to requester {}.", peer_id);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}
