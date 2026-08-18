// Phase 0: prove a crates.io-only build (no midnight-node fork) replays dust
// events and produces a state that round-trips into the CLI's WASM ledger-v8.
// This is the build-confirmation seed of the real sidecar (see the plan doc).
use std::time::Instant;

use midnight_base_crypto::time::Timestamp;
use midnight_ledger::dust::{DustLocalState, DustSecretKey};
use midnight_ledger::events::Event;
use midnight_ledger::structure::INITIAL_PARAMETERS;
use midnight_serialize::{tagged_deserialize, tagged_serialize};
use midnight_storage::db::InMemoryDB;

type Db = InMemoryDB;

fn main() {
    let events_path = std::env::args().nth(1).expect("arg1: events file (hex per line)");
    let out_path = std::env::args().nth(2).expect("arg2: out file (serialized state hex)");

    let raw = std::fs::read_to_string(&events_path).expect("read events");
    let events: Vec<Event<Db>> = raw
        .lines()
        .filter(|l| !l.is_empty())
        .map(|h| tagged_deserialize(&hex::decode(h).expect("hex")[..]).expect("deserialize event"))
        .collect();
    let n = events.len();

    let sk = DustSecretKey::derive_secret_key(&[1u8; 32]);
    let mut state: DustLocalState<Db> = DustLocalState::new(INITIAL_PARAMETERS.dust);

    let t0 = Instant::now();
    for batch in events.chunks(500) {
        state = state.replay_events(&sk, batch.iter()).expect("replay");
    }
    let secs = t0.elapsed().as_secs_f64();

    let balance = state.wallet_balance(Timestamp::from_secs(1_787_000_000));
    let mut buf = Vec::new();
    tagged_serialize(&state, &mut buf).expect("serialize state");
    std::fs::write(&out_path, hex::encode(&buf)).expect("write out");

    println!(
        "crates.io-only: {} events, replay {:.2}s ({:.0}/s), balance={}, serialized={} bytes",
        n, secs, n as f64 / secs, balance, buf.len()
    );
}
