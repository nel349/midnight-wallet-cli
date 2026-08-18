// Native dust-sync sidecar (Phase 1).
//
// Streams `dustLedgerEvents` from the indexer, replays them natively into a
// `DustLocalState` (~5x WASM), and writes a checkpoint the CLI reads straight
// into its dust cache. Read-only w.r.t. the chain; the dust secret key is read
// from stdin and zeroized. Output (checkpoint file + final stdout line) mirrors
// the CLI's `DustDirectResult`. See tasks/dust-native-sidecar-plan.md.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use midnight_base_crypto::time::Timestamp;
use midnight_ledger::dust::{DustLocalState, DustPublicKey, DustSecretKey};
use midnight_ledger::events::{Event, EventDetails};
use midnight_ledger::structure::LedgerParameters;
use midnight_serialize::{tagged_deserialize, tagged_serialize};
use midnight_storage::db::InMemoryDB;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::header::{HeaderValue, SEC_WEBSOCKET_PROTOCOL};
use tungstenite::Message;
use zeroize::Zeroize;

type Db = InMemoryDB;

const CHUNK: usize = 500;
const CHECKPOINT_EVERY: u64 = 20_000;

struct Args {
    indexer_ws: String,
    out: String,
    resume: Option<String>,
    timeout_secs: u64,
    idle_secs: u64,
}

fn parse_args() -> Args {
    let mut a = Args { indexer_ws: String::new(), out: String::new(), resume: None, timeout_secs: 600, idle_secs: 5 };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--indexer-ws" => a.indexer_ws = it.next().expect("--indexer-ws value"),
            "--out" => a.out = it.next().expect("--out value"),
            "--resume" => a.resume = it.next(),
            "--timeout-secs" => a.timeout_secs = it.next().and_then(|v| v.parse().ok()).unwrap_or(600),
            "--idle-secs" => a.idle_secs = it.next().and_then(|v| v.parse().ok()).unwrap_or(5),
            other => die(&format!("unknown flag: {other}")),
        }
    }
    if a.indexer_ws.is_empty() || a.out.is_empty() { die("required: --indexer-ws <url> --out <file>"); }
    a
}

fn die(msg: &str) -> ! {
    eprintln!("dust-sync: {msg}");
    std::process::exit(2);
}

fn http_from_ws(ws: &str) -> String {
    let mut s = ws.to_string();
    if let Some(rest) = s.strip_prefix("wss://") { s = format!("https://{rest}"); }
    else if let Some(rest) = s.strip_prefix("ws://") { s = format!("http://{rest}"); }
    s.strip_suffix("/ws").map(|x| x.to_string()).unwrap_or(s)
}

/// Parse a hex string into a 32-byte seed. Pure (testable); does not zeroize its
/// short-lived intermediate — the stdin caller owns zeroization of the buffers.
fn parse_seed(hex_str: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(hex_str.trim()).map_err(|e| format!("seed must be hex: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("seed must be 32 bytes (64 hex chars), got {}", bytes.len()));
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&bytes);
    Ok(seed)
}

/// Read one hex line (the raw 32-byte dust seed) from stdin, zeroizing buffers.
fn read_seed_stdin() -> [u8; 32] {
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap_or_else(|e| die(&format!("read seed from stdin: {e}")));
    let seed = parse_seed(&line).unwrap_or_else(|e| { line.zeroize(); die(&e) });
    line.zeroize();
    seed
}

/// Current on-chain ledger params (block-level, so ParamChange is honoured).
fn fetch_params(http: &str) -> LedgerParameters {
    let resp: serde_json::Value = ureq::post(http)
        .send_json(serde_json::json!({ "query": "{ block { ledgerParameters } }" }))
        .unwrap_or_else(|e| die(&format!("params query: {e}")))
        .into_json()
        .unwrap_or_else(|e| die(&format!("params json: {e}")));
    let hexp = resp["data"]["block"]["ledgerParameters"].as_str()
        .unwrap_or_else(|| die("block has no ledgerParameters"));
    let bytes = hex::decode(hexp).unwrap_or_else(|e| die(&format!("params hex: {e}")));
    tagged_deserialize(&bytes[..]).unwrap_or_else(|e| die(&format!("deserialize params: {e}")))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Checkpoint {
    dust_state: String, // tagged_serialize(DustLocalState) hex
    last_applied_event_id: i64,
    owned_generation_indices: Vec<u64>,
    generation_frontier: u64,
    balance: String, // u128 as string (JSON-safe)
    available_coins: usize,
    events_applied: u64,
    partial: bool,
}

enum WsMsg { Event { id: i64, raw: String, max_id: i64 }, End }

/// Background WS reader: graphql-transport-ws handshake, forwards dust events.
fn spawn_reader(ws_url: String, start_id: i64, tx: mpsc::Sender<WsMsg>) {
    std::thread::spawn(move || {
        // The indexer requires the graphql-transport-ws subprotocol; without the
        // header it rejects the upgrade with 400 (the TS client sets it too).
        let req = match ws_url.as_str().into_client_request() {
            Ok(mut r) => { r.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_static("graphql-transport-ws")); r }
            Err(e) => { eprintln!("dust-sync: ws request: {e}"); let _ = tx.send(WsMsg::End); return; }
        };
        let (mut sock, _) = match tungstenite::connect(req) {
            Ok(x) => x,
            Err(e) => { eprintln!("dust-sync: ws connect: {e}"); let _ = tx.send(WsMsg::End); return; }
        };
        let _ = sock.send(Message::Text(r#"{"type":"connection_init"}"#.into()));
        let sub = serde_json::json!({
            "id": "1", "type": "subscribe",
            "payload": { "query": "subscription($id:Int){dustLedgerEvents(id:$id){id raw maxId}}", "variables": { "id": start_id } }
        }).to_string();
        loop {
            match sock.read() {
                Ok(Message::Text(t)) => {
                    let m: serde_json::Value = match serde_json::from_str(&t) { Ok(v) => v, Err(_) => continue };
                    match m["type"].as_str() {
                        Some("connection_ack") => { let _ = sock.send(Message::Text(sub.clone().into())); }
                        Some("next") => {
                            let e = &m["payload"]["data"]["dustLedgerEvents"];
                            if let (Some(id), Some(raw), Some(max_id)) = (e["id"].as_i64(), e["raw"].as_str(), e["maxId"].as_i64()) {
                                if tx.send(WsMsg::Event { id, raw: raw.to_string(), max_id }).is_err() { break; }
                            }
                        }
                        Some("error") => { eprintln!("dust-sync: subscription error: {}", m["payload"]); let _ = tx.send(WsMsg::End); break; }
                        Some("complete") => { let _ = tx.send(WsMsg::End); break; }
                        _ => {}
                    }
                }
                Ok(Message::Ping(p)) => { let _ = sock.send(Message::Pong(p)); }
                Ok(Message::Close(_)) | Err(_) => { let _ = tx.send(WsMsg::End); break; }
                _ => {}
            }
        }
    });
}

fn now_ts() -> Timestamp {
    Timestamp::from_secs(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
}

fn write_checkpoint(out: &str, state: &DustLocalState<Db>, last_id: i64, owned: &BTreeSet<u64>, frontier: u64, events_applied: u64, partial: bool) -> Checkpoint {
    let mut buf = Vec::new();
    tagged_serialize(state, &mut buf).unwrap_or_else(|e| die(&format!("serialize state: {e}")));
    let cp = Checkpoint {
        dust_state: hex::encode(&buf),
        last_applied_event_id: last_id,
        owned_generation_indices: owned.iter().copied().collect(),
        generation_frontier: frontier,
        balance: state.wallet_balance(now_ts()).to_string(),
        available_coins: state.utxos().count(),
        events_applied,
        partial,
    };
    let json = serde_json::to_string(&cp).expect("serialize checkpoint");
    // atomic write: tmp + rename
    let tmp = format!("{out}.tmp");
    std::fs::write(&tmp, &json).unwrap_or_else(|e| die(&format!("write checkpoint: {e}")));
    std::fs::rename(&tmp, out).unwrap_or_else(|e| die(&format!("rename checkpoint: {e}")));
    cp
}

fn main() {
    let args = parse_args();
    let http = http_from_ws(&args.indexer_ws);

    let mut seed = read_seed_stdin();
    let sk = DustSecretKey::derive_secret_key(&seed);
    let my_pk = DustPublicKey::from(sk.clone());
    seed.zeroize(); // raw seed no longer needed — don't leave it in memory

    let params = fetch_params(&http);

    // Resume from a prior checkpoint, or start fresh.
    let (mut state, mut last_id, mut owned, mut frontier, mut events_applied): (DustLocalState<Db>, i64, BTreeSet<u64>, u64, u64) =
        match args.resume.as_deref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str::<Checkpoint>(&s).ok()) {
            Some(cp) => {
                let bytes = hex::decode(&cp.dust_state).unwrap_or_else(|e| die(&format!("resume state hex: {e}")));
                let st = tagged_deserialize(&bytes[..]).unwrap_or_else(|e| die(&format!("resume deserialize: {e}")));
                (st, cp.last_applied_event_id, cp.owned_generation_indices.into_iter().collect(), cp.generation_frontier, cp.events_applied)
            }
            None => (DustLocalState::new(params.dust), -1, BTreeSet::new(), 0, 0),
        };

    let interrupted = Arc::new(AtomicBool::new(false));
    { let f = interrupted.clone(); let _ = ctrlc::set_handler(move || f.store(true, Ordering::SeqCst)); }

    let start_id = last_id + 1;
    let (tx, rx) = mpsc::channel();
    spawn_reader(args.indexer_ws.clone(), start_id, tx);

    let mut batch: Vec<Event<Db>> = Vec::with_capacity(CHUNK);
    #[allow(unused_assignments)] // -1 is a "no events seen" sentinel; overwritten on the first event
    let mut max_id: i64 = -1;
    let mut saw_event = false;
    let mut next_checkpoint: u64 = events_applied + CHECKPOINT_EVERY;
    let deadline = Instant::now() + Duration::from_secs(args.timeout_secs);
    let mut partial = false;

    let flush = |state: &mut DustLocalState<Db>, batch: &mut Vec<Event<Db>>, applied: &mut u64| {
        if batch.is_empty() { return; }
        *state = state.replay_events(&sk, batch.iter()).unwrap_or_else(|e| die(&format!("replay: {e}")));
        *applied += batch.len() as u64;
        batch.clear();
    };

    loop {
        if interrupted.load(Ordering::SeqCst) { partial = true; break; }
        if Instant::now() >= deadline { partial = true; break; }
        match rx.recv_timeout(Duration::from_secs(args.idle_secs)) {
            Ok(WsMsg::Event { id, raw, max_id: mid }) => {
                saw_event = true;
                let bytes = hex::decode(&raw).unwrap_or_else(|e| die(&format!("event hex: {e}")));
                let ev: Event<Db> = tagged_deserialize(&bytes[..]).unwrap_or_else(|e| die(&format!("deserialize event {id}: {e}")));
                if let EventDetails::DustInitialUtxo { generation, generation_index, .. } = &ev.content {
                    if *generation_index + 1 > frontier { frontier = *generation_index + 1; }
                    if generation.owner == my_pk { owned.insert(*generation_index); }
                }
                batch.push(ev);
                last_id = id;
                max_id = mid;
                if batch.len() >= CHUNK {
                    flush(&mut state, &mut batch, &mut events_applied);
                    // Checkpoint periodically (not every chunk) — the growing state
                    // can be MBs, and a per-chunk write is GBs of disk churn.
                    if events_applied >= next_checkpoint {
                        write_checkpoint(&args.out, &state, last_id, &owned, frontier, events_applied, true);
                        eprintln!("dust-sync: applied {events_applied} / {max_id}");
                        next_checkpoint += CHECKPOINT_EVERY;
                    }
                }
                if max_id >= 0 && last_id >= max_id { break; } // caught up to tip
            }
            // Idle after events means we're behind the tip (a clean catch-up breaks
            // via the tip check above), so mark partial and let the CLI resume.
            Err(RecvTimeoutError::Timeout) => { if saw_event { partial = true; break; } }
            Ok(WsMsg::End) | Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    flush(&mut state, &mut batch, &mut events_applied);
    let cp = write_checkpoint(&args.out, &state, last_id, &owned, frontier, events_applied, partial);
    // Final one-line status on stdout for the CLI to parse without re-reading the file.
    println!("{}", serde_json::to_string(&cp).expect("status json"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_from_ws_derives_endpoint() {
        assert_eq!(http_from_ws("wss://host/api/v4/graphql/ws"), "https://host/api/v4/graphql");
        assert_eq!(http_from_ws("ws://localhost:8088/api/v1/graphql/ws"), "http://localhost:8088/api/v1/graphql");
        // No /ws suffix: protocol swap only.
        assert_eq!(http_from_ws("wss://host/graphql"), "https://host/graphql");
    }

    #[test]
    fn parse_seed_accepts_valid_32_byte_hex() {
        let hex = "00".repeat(31) + "01";
        let seed = parse_seed(&format!("  {hex}\n")).expect("valid seed");
        assert_eq!(seed[31], 1);
        assert_eq!(seed[0], 0);
    }

    #[test]
    fn parse_seed_rejects_wrong_length_and_bad_hex() {
        assert!(parse_seed(&"ab".repeat(16)).is_err()); // 16 bytes, too short
        assert!(parse_seed(&"ab".repeat(33)).is_err()); // 33 bytes, too long
        assert!(parse_seed("zz".repeat(32).as_str()).is_err()); // not hex
    }

    #[test]
    fn checkpoint_json_round_trips() {
        let cp = Checkpoint {
            dust_state: "deadbeef".into(),
            last_applied_event_id: 4242,
            owned_generation_indices: vec![3, 7, 100],
            generation_frontier: 373362,
            balance: "136016950999999999".into(),
            available_coins: 1,
            events_applied: 1409471,
            partial: false,
        };
        let json = serde_json::to_string(&cp).unwrap();
        let back: Checkpoint = serde_json::from_str(&json).unwrap();
        assert_eq!(back.last_applied_event_id, 4242);
        assert_eq!(back.owned_generation_indices, vec![3, 7, 100]);
        assert_eq!(back.generation_frontier, 373362);
        assert_eq!(back.balance, "136016950999999999"); // u128 kept as string (JSON-safe)
        assert_eq!(back.available_coins, 1);
        assert!(!back.partial);
    }
}
