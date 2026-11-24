//! Joining with a phone's yes (CONTRACT, Devices): while Set up shows, the Windows or Android app listens on an iroh
//! endpoint of its own. Its QR code carries this endpoint's key, its home relay and a secret; a paired phone scans it
//! and asks its hub to join, and the hub connects here and hands over a pairing link with a proof made with that
//! secret. Only the hub the phone belongs to has the secret, so a link that checks out comes from that hub, and the
//! connection's own key must be the one the link names (the key this device then pins).
//!
//! n0's default relays and no lookup service: the hub reaches this endpoint through the relay the QR code names.
//! Only the join protocol is answered here; requests to the hub go through link.rs as before.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use iroh::endpoint::{presets, Incoming, VarInt};
use iroh::{Endpoint, RelayMode};
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::{Mutex, Semaphore};
use tokio::task::AbortHandle;

const ALPN: &[u8] = b"aeneas/join/1";
const PLATFORMS: [&str; 4] = ["mac", "ipad", "windows", "android"];
/// A code replaced a moment ago still checks out this long: the phone that scanned it may still be asking its hub
/// (the person reads the question, then the hub takes up to 20 seconds to connect).
const GRACE: Duration = Duration::from_secs(120);
/// Each step of a join (the handshake, the stream, the hub's message) gets this long.
const STEP: Duration = Duration::from_secs(20);
/// Joins checked at once; any more are turned away, so a flood of connections cannot pile up work.
const AT_ONCE: usize = 4;

/// The listener while Set up shows, at most one.
#[derive(Default)]
pub struct Joins {
    current: Mutex<Option<Listener>>,
    sessions: AtomicU64,
}

struct Listener {
    ep: Endpoint,
    shared: Arc<Shared>,
    accept: AbortHandle,
}

struct Shared {
    node: String,
    name: StdMutex<String>,
    platform: StdMutex<String>,
    secrets: StdMutex<Secrets>,
    taken: AtomicBool,
    events: StdMutex<Sink>,
    session: AtomicU64,
}

/// Where the pairing link goes: the page's channel, or a test.
type Sink = Arc<dyn Fn(JoinEvent) + Send + Sync>;

struct Secrets {
    now: [u8; 32],
    before: Option<([u8; 32], Instant)>,
}

/// What the page shows as a QR code. `session` names this start or renewal, so a stop sent by a screen that already
/// went away does not stop the listener a newer screen started.
#[derive(Serialize)]
pub struct JoinOffer {
    session: u64,
    node: String,
    relay: String,
    secret: String,
    link: String,
}

/// What the page hears: the pairing link, once a join checked out.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum JoinEvent {
    Joined { link: String },
}

fn new_secret() -> Result<[u8; 32], String> {
    let mut s = [0u8; 32];
    SystemRandom::new().fill(&mut s).map_err(|_| "This device could not make a code.".to_string())?;
    Ok(s)
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// As encodeURIComponent, minus the few marks it leaves: the Apple apps read the link with URLComponents, which takes
/// a `+` as a plus, so a space must be `%20`.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub(crate) fn join_link(node: &str, relay: &str, secret: &str, name: &str, platform: &str) -> String {
    format!(
        "everythingapp://join?node={}&relay={}&s={}&name={}&platform={}",
        enc(node),
        enc(relay),
        enc(secret),
        enc(name),
        enc(platform)
    )
}

fn check_name(name: &str, platform: &str) -> Result<(String, String), String> {
    let name: String = name.trim().chars().filter(|c| !c.is_control()).take(64).collect();
    if name.is_empty() {
        return Err("Give this device a name first.".into());
    }
    if !PLATFORMS.contains(&platform) {
        return Err("This kind of device cannot join this way.".into());
    }
    Ok((name, platform.to_string()))
}

impl Shared {
    /// The secret now, and the one before it while it is still fresh.
    fn valid_secrets(&self) -> Vec<[u8; 32]> {
        let s = self.secrets.lock().unwrap();
        let mut out = vec![s.now];
        if let Some((old, at)) = s.before {
            if at.elapsed() < GRACE {
                out.push(old);
            }
        }
        out
    }

    fn renew(&self) -> Result<(), String> {
        let fresh = new_secret()?;
        let mut s = self.secrets.lock().unwrap();
        s.before = Some((s.now, Instant::now()));
        s.now = fresh;
        Ok(())
    }

    fn offer(&self, ep: &Endpoint) -> Result<JoinOffer, String> {
        // The home relay can change with the network, so each new code names the one in use now.
        let relay = ep
            .addr()
            .relay_urls()
            .next()
            .map(|u| u.to_string())
            .ok_or_else(|| "This device has lost its Direct link relay. Check its internet connection.".to_string())?;
        let secret = b64url(&self.secrets.lock().unwrap().now);
        let name = self.name.lock().unwrap().clone();
        let platform = self.platform.lock().unwrap().clone();
        Ok(JoinOffer {
            session: self.session.load(Ordering::SeqCst),
            link: join_link(&self.node, &relay, &secret, &name, &platform),
            node: self.node.clone(),
            relay,
            secret,
        })
    }
}

#[derive(Deserialize)]
struct HubOffer {
    v: u32,
    link: String,
    proof: String,
}

/// The hub key a pairing link names (`link=direct&node=`), when it is a Direct link pairing link with a code.
fn link_hub_key(link: &str) -> Option<String> {
    // Read as the page reads a pasted link (Setup.tsx, pastedLink), which stops at a space or a quote.
    if !link.chars().all(|c| c.is_ascii_graphic() && !"\"'<>".contains(c)) {
        return None;
    }
    let query = link.strip_prefix("everythingapp://setup?")?;
    let (mut direct, mut node, mut code) = (false, None, false);
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "link" => direct = v == "direct",
            "node" if v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()) => node = Some(v.to_ascii_lowercase()),
            "code" => code = !v.is_empty(),
            _ => {}
        }
    }
    if direct && code { node } else { None }
}

/// Whether a hub's join checks out (CONTRACT, Devices): its message is `{ v: 1, link, proof }`, the link is a Direct
/// link pairing link naming the key the connection came from, and the proof is HMAC-SHA256 with one of the valid
/// secrets over `aeneas-join/1\n<hub key>\n<this device's key>\n<link>`, checked in constant time. The link on a
/// match; otherwise the plain sentence the hub is answered with.
pub(crate) fn check_join(raw: &[u8], remote: &str, own: &str, secrets: &[[u8; 32]]) -> Result<String, String> {
    let m: HubOffer = serde_json::from_slice(raw).map_err(|_| "That was not a join this device can read.".to_string())?;
    if m.v != 1 {
        return Err("This hub sends a newer kind of join. Update Aeneas on this device.".into());
    }
    let hub = link_hub_key(&m.link).ok_or_else(|| "The hub sent a pairing link without Direct link.".to_string())?;
    let remote = remote.to_ascii_lowercase();
    if hub != remote {
        return Err("The pairing link names another hub than the one that sent it.".into());
    }
    let proof = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(m.proof.trim())
        .map_err(|_| "The hub's proof could not be read.".to_string())?;
    let message = format!("aeneas-join/1\n{}\n{}\n{}", remote, own.to_ascii_lowercase(), m.link);
    for s in secrets {
        let key = hmac::Key::new(hmac::HMAC_SHA256, s);
        if hmac::verify(&key, message.as_bytes(), &proof).is_ok() {
            return Ok(m.link);
        }
    }
    Err("The hub's proof does not match the code on this device. Scan the code on its screen again.".into())
}

async fn serve(ep: Endpoint, shared: Arc<Shared>) {
    let slots = Arc::new(Semaphore::new(AT_ONCE));
    while let Some(incoming) = ep.accept().await {
        if shared.taken.load(Ordering::SeqCst) {
            incoming.refuse();
            continue;
        }
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            incoming.refuse();
            continue;
        };
        let shared = shared.clone();
        tokio::spawn(async move {
            handle(incoming, shared).await;
            drop(permit);
        });
    }
}

async fn handle(incoming: Incoming, shared: Arc<Shared>) {
    let Ok(accepting) = incoming.accept() else { return };
    let Ok(Ok(conn)) = tokio::time::timeout(STEP, accepting).await else { return };
    let Ok(Ok((mut send, mut recv))) = tokio::time::timeout(STEP, conn.accept_bi()).await else {
        conn.close(VarInt::from_u32(1), b"no join");
        return;
    };
    let verdict = match tokio::time::timeout(STEP, recv.read_to_end(8 * 1024)).await {
        Ok(Ok(raw)) => check_join(&raw, &conn.remote_id().to_string(), &shared.node, &shared.valid_secrets()),
        _ => Err("The hub's message did not arrive whole.".to_string()),
    };
    // Only the first join that checks out is taken.
    let verdict = match verdict {
        Ok(link) if shared.taken.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() => Ok(link),
        Ok(_) => Err("This device has already joined a hub.".to_string()),
        Err(e) => Err(e),
    };
    let answer = match &verdict {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    let _ = send.write_all(answer.to_string().as_bytes()).await;
    let _ = send.finish();
    // Until the hub has read the answer (or gives up): closing earlier could cut it off.
    let _ = tokio::time::timeout(Duration::from_secs(10), send.stopped()).await;
    match verdict {
        Ok(link) => {
            let events = shared.events.lock().unwrap().clone();
            events(JoinEvent::Joined { link });
        }
        Err(_) => conn.close(VarInt::from_u32(1), b"refused"),
    }
}

async fn stop_listener(l: Listener) {
    l.accept.abort();
    let _ = tokio::time::timeout(Duration::from_secs(3), l.ep.close()).await;
}

impl Joins {
    /// Starts listening (or keeps the running endpoint) with a new secret; `events` hears the pairing link once a
    /// join checks out. The endpoint waits for its home relay first, since the QR code must name it.
    async fn start(&self, name: &str, platform: &str, events: Sink) -> Result<JoinOffer, String> {
        let (name, platform) = check_name(name, platform)?;
        let session = self.sessions.fetch_add(1, Ordering::SeqCst) + 1;
        let mut current = self.current.lock().await;
        if let Some(l) = current.as_ref() {
            // A join already taken, or an endpoint that closed, makes way for a fresh one.
            if !l.shared.taken.load(Ordering::SeqCst) && !l.ep.is_closed() {
                *l.shared.events.lock().unwrap() = events;
                *l.shared.name.lock().unwrap() = name;
                *l.shared.platform.lock().unwrap() = platform;
                l.shared.session.store(session, Ordering::SeqCst);
                l.shared.renew()?;
                return l.shared.offer(&l.ep);
            }
        }
        if let Some(old) = current.take() {
            stop_listener(old).await;
        }
        let ep = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Default)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .map_err(|e| format!("Direct link could not start on this device ({e})."))?;
        if tokio::time::timeout(STEP, ep.online()).await.is_err() {
            ep.close().await;
            return Err("This device could not reach a Direct link relay within 20 seconds. Check its internet connection, then try again.".into());
        }
        let shared = Arc::new(Shared {
            node: ep.id().to_string(),
            name: StdMutex::new(name),
            platform: StdMutex::new(platform),
            secrets: StdMutex::new(Secrets { now: new_secret()?, before: None }),
            taken: AtomicBool::new(false),
            events: StdMutex::new(events),
            session: AtomicU64::new(session),
        });
        let offer = shared.offer(&ep)?;
        let accept = tokio::spawn(serve(ep.clone(), shared.clone())).abort_handle();
        *current = Some(Listener { ep, shared, accept });
        Ok(offer)
    }

    async fn renew(&self) -> Result<JoinOffer, String> {
        let current = self.current.lock().await;
        let l = current.as_ref().filter(|l| !l.shared.taken.load(Ordering::SeqCst) && !l.ep.is_closed());
        let Some(l) = l else { return Err("This device is not waiting for a join.".into()) };
        let session = self.sessions.fetch_add(1, Ordering::SeqCst) + 1;
        l.shared.session.store(session, Ordering::SeqCst);
        l.shared.renew()?;
        l.shared.offer(&l.ep)
    }

    async fn stop(&self, session: Option<u64>) {
        let mut current = self.current.lock().await;
        let newest = current.as_ref().map(|l| l.shared.session.load(Ordering::SeqCst));
        if session.is_some() && session != newest {
            return;
        }
        if let Some(l) = current.take() {
            stop_listener(l).await;
        }
    }
}

/// Starts waiting for a join (or keeps waiting with a new secret), and sends the pairing link to `on_join`.
#[tauri::command]
pub async fn join_start(
    joins: tauri::State<'_, Arc<Joins>>,
    name: String,
    platform: String,
    on_join: Channel<JoinEvent>,
) -> Result<JoinOffer, String> {
    joins.start(&name, &platform, Arc::new(move |ev| { let _ = on_join.send(ev); })).await
}

/// A new secret on the running endpoint (every 5 minutes while Set up shows). Fails when nothing is listening, or
/// the join was already taken; the page then starts again.
#[tauri::command]
pub async fn join_renew(joins: tauri::State<'_, Arc<Joins>>) -> Result<JoinOffer, String> {
    joins.renew().await
}

/// Stops listening, when `session` is still the newest start or renewal (or is left out).
#[tauri::command]
pub async fn join_stop(joins: tauri::State<'_, Arc<Joins>>, session: Option<u64>) -> Result<(), String> {
    joins.stop(session).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The shared test vector (the hub's tests use the same one).
    const SECRET_B64: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const PROOF: &str = "pmOb6wyZdAoeMeQrFEWiughYPHWeACKZ3207YsF76Gs";

    fn secret() -> [u8; 32] {
        std::array::from_fn(|i| i as u8)
    }

    fn link() -> String {
        format!(
            "everythingapp://setup?hid=0123456789ABCDEFGHJKMNPQRS&code=ABCD-EFGH&name=Test%20Mac&link=direct&node={}&relay=https%3A%2F%2Feuc1-1.relay.n0.iroh.link.",
            "a".repeat(64)
        )
    }

    fn message(link: &str, proof: &str) -> Vec<u8> {
        serde_json::json!({ "v": 1, "link": link, "proof": proof }).to_string().into_bytes()
    }

    #[test]
    fn the_secret_is_written_as_the_hub_reads_it() {
        assert_eq!(b64url(&secret()), SECRET_B64);
        assert_eq!(SECRET_B64.len(), 43);
    }

    #[test]
    fn a_join_with_the_shared_vector_checks_out() {
        let got = check_join(&message(&link(), PROOF), &"a".repeat(64), &"b".repeat(64), &[secret()]);
        assert_eq!(got, Ok(link()));
        // Keys as the hub writes them are lowercase, but an uppercase one is the same key.
        assert!(check_join(&message(&link(), PROOF), &"A".repeat(64), &"B".repeat(64), &[secret()]).is_ok());
    }

    #[test]
    fn the_code_before_still_checks_out() {
        let other = [7u8; 32];
        assert!(check_join(&message(&link(), PROOF), &"a".repeat(64), &"b".repeat(64), &[other, secret()]).is_ok());
    }

    #[test]
    fn a_wrong_proof_is_refused() {
        let mut bad = PROOF.to_string();
        bad.replace_range(0..1, "q");
        assert!(check_join(&message(&link(), &bad), &"a".repeat(64), &"b".repeat(64), &[secret()]).is_err());
        // The right proof for another device, or with another secret.
        assert!(check_join(&message(&link(), PROOF), &"a".repeat(64), &"c".repeat(64), &[secret()]).is_err());
        assert!(check_join(&message(&link(), PROOF), &"a".repeat(64), &"b".repeat(64), &[[9u8; 32]]).is_err());
        assert!(check_join(&message(&link(), "not base64!"), &"a".repeat(64), &"b".repeat(64), &[secret()]).is_err());
    }

    #[test]
    fn a_connection_from_another_key_is_refused() {
        let got = check_join(&message(&link(), PROOF), &"c".repeat(64), &"b".repeat(64), &[secret()]);
        assert_eq!(got, Err("The pairing link names another hub than the one that sent it.".to_string()));
    }

    #[test]
    fn only_a_direct_link_pairing_link_with_a_code_is_taken() {
        let node = "a".repeat(64);
        assert_eq!(link_hub_key(&link()), Some(node.clone()));
        assert_eq!(link_hub_key(&link().replace("link=direct", "link=tailscale")), None);
        assert_eq!(link_hub_key(&link().replace("code=ABCD-EFGH", "code=")), None);
        assert_eq!(link_hub_key(&link().replace("everythingapp://setup?", "https://evil.example/?")), None);
        assert_eq!(link_hub_key(&format!("{} ", link())), None);
        assert_eq!(link_hub_key(&link().replace(&node, "abc")), None);
        assert!(check_join(b"{\"v\":2,\"link\":\"x\",\"proof\":\"y\"}", &node, &"b".repeat(64), &[secret()]).is_err());
        assert!(check_join(b"not json", &node, &"b".repeat(64), &[secret()]).is_err());
    }

    #[test]
    fn the_join_link_reads_as_the_contract_says() {
        let l = join_link(&"b".repeat(64), "https://euc1-1.relay.n0.iroh.link./", SECRET_B64, "Jamie's PC", "windows");
        assert_eq!(
            l,
            format!(
                "everythingapp://join?node={}&relay=https%3A%2F%2Feuc1-1.relay.n0.iroh.link.%2F&s={SECRET_B64}&name=Jamie%27s%20PC&platform=windows",
                "b".repeat(64)
            )
        );
        assert!(check_name("  ", "windows").is_err());
        assert!(check_name("PC", "linux").is_err());
        assert_eq!(check_name(" PC\n", "android"), Ok(("PC".to_string(), "android".to_string())));
    }
}

/// Both sides over n0's relays, the hub's played here (needs the internet): cargo test join -- --ignored.
#[cfg(test)]
mod live {
    use super::*;
    use iroh::{EndpointAddr, EndpointId, RelayUrl};
    use std::str::FromStr;

    async fn hub_sends(hub: &Endpoint, offer: &JoinOffer, link: &str, secret: &[u8]) -> serde_json::Value {
        let message = format!("aeneas-join/1\n{}\n{}\n{}", hub.id(), offer.node, link);
        let proof = b64url(hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, secret), message.as_bytes()).as_ref());
        let addr = EndpointAddr::new(EndpointId::from_str(&offer.node).unwrap()).with_relay_url(RelayUrl::from_str(&offer.relay).unwrap());
        let conn = tokio::time::timeout(STEP, hub.connect(addr, ALPN)).await.expect("connect in time").expect("connect");
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        send.write_all(serde_json::json!({ "v": 1, "link": link, "proof": proof }).to_string().as_bytes()).await.unwrap();
        send.finish().unwrap();
        let answer = tokio::time::timeout(STEP, recv.read_to_end(4096)).await.expect("answer in time").expect("answer");
        conn.close(VarInt::from_u32(0), b"done");
        serde_json::from_slice(&answer).unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn a_hub_joins_over_the_relay() {
        let joins = Joins::default();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let sink: Sink = Arc::new(move |JoinEvent::Joined { link }| { let _ = tx.send(link); });
        let offer = joins.start("Test PC", "windows", sink).await.expect("start");
        assert!(offer.link.starts_with(&format!("everythingapp://join?node={}&relay=https%3A%2F%2F", offer.node)), "{}", offer.link);

        let hub = Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Default).bind().await.unwrap();
        hub.online().await;
        let link = format!("everythingapp://setup?code=ABCD-EFGH&name=Test%20PC&link=direct&node={}&relay=https%3A%2F%2Frelay.example", hub.id());
        let secret = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&offer.secret).unwrap();

        // A wrong secret is refused and the device keeps waiting.
        let refused = hub_sends(&hub, &offer, &link, &[1u8; 32]).await;
        assert_eq!(refused["ok"], false, "{refused}");
        assert!(rx.try_recv().is_err());

        // The code before a renewal still checks out.
        let renewed = joins.renew().await.expect("renew");
        assert_ne!(renewed.secret, offer.secret);
        let ok = hub_sends(&hub, &offer, &link, &secret).await;
        assert_eq!(ok, serde_json::json!({ "ok": true }));
        let got = tokio::time::timeout(Duration::from_secs(15), rx.recv()).await.expect("link in time").unwrap();
        assert_eq!(got, link);

        // Only the first join is taken.
        assert!(joins.renew().await.is_err());
        joins.stop(Some(renewed.session)).await;
        assert!(joins.current.lock().await.is_none());
        hub.close().await;
    }
}
