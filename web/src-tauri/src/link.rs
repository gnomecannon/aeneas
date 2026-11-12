//! Direct link (iroh, https://iroh.computer, open source from n0) for the Windows and Android apps: requests to a hub
//! saved as `iroh://<hub key>` go over an encrypted iroh connection to that key, through the relay its pairing QR code
//! named when no direct path exists (hub/src/link.ts). Each request is one stream, written as HTTP/1.0; the answer comes
//! back to the page in pieces over a Tauri channel, so the live updates stream as they do over HTTPS. No local port is
//! opened: nothing else on the device can use the connection.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use iroh::endpoint::{presets, Connection};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

const ALPN: &[u8] = b"aeneas/link/1";

#[derive(Default)]
pub struct Links {
    endpoints: Mutex<HashMap<String, Endpoint>>,
    conns: Mutex<HashMap<String, Connection>>,
    running: std::sync::Mutex<HashMap<u64, AbortHandle>>,
}

/// What the page hears about one request, in order: the head, the body in pieces, then the end (or an error).
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LinkEvent {
    Head { status: u16, headers: Vec<(String, String)> },
    Data { b64: String },
    End,
    Error { message: String },
}

#[derive(Serialize)]
pub struct LinkState {
    pub connected: bool,
    pub direct: bool,
    pub rtt_ms: Option<u64>,
}

impl Links {
    async fn endpoint(&self, relay: &str) -> Result<Endpoint, String> {
        let mut eps = self.endpoints.lock().await;
        if let Some(ep) = eps.get(relay) {
            return Ok(ep.clone());
        }
        let url = RelayUrl::from_str(relay).map_err(|_| "the hub's relay address is not valid".to_string())?;
        // Nothing published to any lookup service: the hub is found through the relay its QR code named.
        let ep = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Custom(RelayMap::from(url)))
            .bind()
            .await
            .map_err(|e| format!("Direct link could not start ({e})"))?;
        eps.insert(relay.to_string(), ep.clone());
        Ok(ep)
    }

    async fn connection(&self, node: &str, relay: &str, fresh: bool) -> Result<Connection, String> {
        if !fresh {
            if let Some(c) = self.conns.lock().await.get(node) {
                if c.close_reason().is_none() {
                    return Ok(c.clone());
                }
            }
        }
        let id = EndpointId::from_str(node).map_err(|_| "the hub key is not valid".to_string())?;
        let url = RelayUrl::from_str(relay).map_err(|_| "the hub's relay address is not valid".to_string())?;
        let ep = self.endpoint(relay).await?;
        let addr = EndpointAddr::new(id).with_relay_url(url);
        let conn = tokio::time::timeout(Duration::from_secs(20), ep.connect(addr, ALPN))
            .await
            .map_err(|_| "the hub did not answer over Direct link within 20 seconds".to_string())?
            .map_err(|e| format!("could not reach the hub over Direct link ({e})"))?;
        self.conns.lock().await.insert(node.to_string(), conn.clone());
        Ok(conn)
    }

    pub async fn state(&self, node: &str) -> LinkState {
        let conns = self.conns.lock().await;
        let Some(c) = conns.get(node).filter(|c| c.close_reason().is_none()) else {
            return LinkState { connected: false, direct: false, rtt_ms: None };
        };
        let paths = c.paths();
        let selected = paths.iter().find(|p| p.is_selected());
        LinkState {
            connected: true,
            direct: selected.as_ref().map(|p| p.is_ip()).unwrap_or(false),
            rtt_ms: selected.map(|p| p.rtt().as_millis() as u64),
        }
    }
}

/// The request as the hub's HTTP server reads it: HTTP/1.0, so the answer ends with the stream.
fn request_head(method: &str, path: &str, headers: &[(String, String)], body_len: usize) -> Vec<u8> {
    let mut h = format!("{method} {path} HTTP/1.0\r\nHost: hub\r\nAccept-Encoding: identity\r\nContent-Length: {body_len}\r\n");
    for (k, v) in headers {
        let lk = k.to_ascii_lowercase();
        if lk == "host" || lk == "content-length" || lk == "accept-encoding" || lk == "connection" { continue; }
        if k.contains(['\r', '\n']) || v.contains(['\r', '\n']) { continue; }
        h.push_str(&format!("{k}: {v}\r\n"));
    }
    h.push_str("\r\n");
    h.into_bytes()
}

fn parse_head(raw: &[u8]) -> Result<(u16, Vec<(String, String)>), String> {
    let text = std::str::from_utf8(raw).map_err(|_| "the hub's answer was not readable".to_string())?;
    let mut lines = text.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| "the hub's answer was not readable".to_string())?;
    let headers = lines
        .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
        .collect();
    Ok((status, headers))
}

/// Chunked bodies (the hub chunks even for HTTP/1.0 when it streams): the data without the chunk framing.
#[derive(Default)]
struct Chunks { buf: Vec<u8>, left: usize, crlf: bool, done: bool }

impl Chunks {
    fn feed(&mut self, input: &[u8]) -> Vec<u8> {
        self.buf.extend_from_slice(input);
        let mut out = Vec::new();
        loop {
            if self.done { self.buf.clear(); return out; }
            if self.left > 0 {
                let n = self.left.min(self.buf.len());
                out.extend_from_slice(&self.buf[..n]);
                self.buf.drain(..n);
                self.left -= n;
                if self.left > 0 { return out; }
                self.crlf = true;
            }
            // The CRLF after a chunk's data.
            if self.crlf {
                if self.buf.len() < 2 { return out; }
                self.buf.drain(..2);
                self.crlf = false;
            }
            let Some(end) = self.buf.windows(2).position(|w| w == b"\r\n") else { return out };
            let line = String::from_utf8_lossy(&self.buf[..end]).to_string();
            let size = usize::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
            self.buf.drain(..end + 2);
            if size == 0 { self.done = true; continue; }
            self.left = size;
        }
    }
}

async fn run(
    links: &Links,
    node: &str,
    relay: &str,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    events: &Channel<LinkEvent>,
) -> Result<(), String> {
    // A connection kept from before may have gone quiet (the hub restarted, the network changed): a second try
    // makes a new one.
    let (mut send, mut recv) = match links.connection(node, relay, false).await?.open_bi().await {
        Ok(s) => s,
        Err(_) => links.connection(node, relay, true).await?.open_bi().await.map_err(|e| format!("could not reach the hub over Direct link ({e})"))?,
    };
    send.write_all(&request_head(method, path, headers, body.len())).await.map_err(|e| e.to_string())?;
    if !body.is_empty() { send.write_all(body).await.map_err(|e| e.to_string())?; }
    send.finish().map_err(|e| e.to_string())?;

    let mut head = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    let (status, hdrs, rest) = loop {
        let n = recv.read(&mut buf).await.map_err(|e| e.to_string())?.ok_or("the hub closed the stream before answering")?;
        head.extend_from_slice(&buf[..n]);
        if let Some(end) = head.windows(4).position(|w| w == b"\r\n\r\n") {
            let (s, h) = parse_head(&head[..end])?;
            break (s, h, head[end + 4..].to_vec());
        }
        if head.len() > 64 * 1024 { return Err("the hub's answer had no end to its head".into()); }
    };
    let chunked = hdrs.iter().any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.to_ascii_lowercase().contains("chunked"));
    let kept: Vec<(String, String)> = hdrs
        .into_iter()
        .filter(|(k, _)| !k.eq_ignore_ascii_case("transfer-encoding") && !k.eq_ignore_ascii_case("connection") && !(chunked && k.eq_ignore_ascii_case("content-length")))
        .collect();
    events.send(LinkEvent::Head { status, headers: kept }).map_err(|e| e.to_string())?;
    let mut chunks = Chunks::default();
    let mut emit = |data: &[u8]| -> Result<(), String> {
        let out = if chunked { chunks.feed(data) } else { data.to_vec() };
        if !out.is_empty() {
            events.send(LinkEvent::Data { b64: base64::engine::general_purpose::STANDARD.encode(out) }).map_err(|e| e.to_string())?;
        }
        Ok(())
    };
    emit(&rest)?;
    while let Some(n) = recv.read(&mut buf).await.map_err(|e| e.to_string())? {
        emit(&buf[..n])?;
    }
    events.send(LinkEvent::End).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn link_fetch(
    links: tauri::State<'_, Arc<Links>>,
    id: u64,
    node: String,
    relay: String,
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    on_event: Channel<LinkEvent>,
) -> Result<(), String> {
    let body = match body {
        Some(b) => base64::engine::general_purpose::STANDARD.decode(b).map_err(|_| "bad request body".to_string())?,
        None => Vec::new(),
    };
    let links = links.inner().clone();
    let events = on_event.clone();
    let task = tokio::spawn({
        let links = links.clone();
        async move {
            if let Err(message) = run(&links, &node, &relay, &method, &path, &headers, &body, &events).await {
                let _ = events.send(LinkEvent::Error { message });
            }
        }
    });
    links.running.lock().unwrap().insert(id, task.abort_handle());
    let _ = task.await;
    links.running.lock().unwrap().remove(&id);
    Ok(())
}

/// The page stopped waiting (it closed the live stream, or left the screen): the stream is dropped, which resets it.
#[tauri::command]
pub fn link_cancel(links: tauri::State<'_, Arc<Links>>, id: u64) {
    if let Some(h) = links.running.lock().unwrap().remove(&id) { h.abort(); }
}

#[tauri::command]
pub async fn link_state(links: tauri::State<'_, Arc<Links>>, node: String) -> Result<LinkState, String> {
    Ok(links.state(&node).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_come_out_whole_however_they_are_cut() {
        let wire = b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        for cut in 1..wire.len() {
            let mut c = Chunks::default();
            let mut out = c.feed(&wire[..cut]);
            out.extend(c.feed(&wire[cut..]));
            assert_eq!(out, b"hello world", "cut at {cut}");
        }
    }

    #[test]
    fn the_head_drops_what_the_link_sets_itself() {
        let h = String::from_utf8(request_head("POST", "/sync/push", &[("Authorization".into(), "Bearer k".into()), ("Host".into(), "x".into()), ("Bad\r\nInjected".into(), "1".into())], 3)).unwrap();
        assert!(h.starts_with("POST /sync/push HTTP/1.0\r\nHost: hub\r\n"));
        assert!(h.contains("Authorization: Bearer k\r\n"));
        assert!(!h.contains("Host: x"));
        assert!(!h.contains("Injected"));
        assert!(h.ends_with("\r\n\r\n"));
    }

    #[test]
    fn the_answer_head_is_read() {
        let (s, h) = parse_head(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked").unwrap();
        assert_eq!(s, 200);
        assert_eq!(h[0], ("Content-Type".into(), "text/event-stream".into()));
    }
}

/// Against a running hub: EA_LINK_TEST_NODE and EA_LINK_TEST_RELAY from its pairing link (cargo test -- --ignored).
#[cfg(test)]
mod live {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn health_over_the_direct_link() {
        let node = std::env::var("EA_LINK_TEST_NODE").expect("EA_LINK_TEST_NODE");
        let relay = std::env::var("EA_LINK_TEST_RELAY").expect("EA_LINK_TEST_RELAY");
        let links = Links::default();
        for _ in 0..2 {
            let (mut send, mut recv) = links.connection(&node, &relay, false).await.unwrap().open_bi().await.unwrap();
            send.write_all(&request_head("GET", "/health", &[], 0)).await.unwrap();
            send.finish().unwrap();
            let all = recv.read_to_end(1 << 20).await.unwrap();
            let text = String::from_utf8_lossy(&all);
            assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        }
        let st = links.state(&node).await;
        assert!(st.connected);
        println!("direct={} rtt={:?}", st.direct, st.rtt_ms);
    }
}
