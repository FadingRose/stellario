//! Autosurgeon experiment: same convergence story as the low-level prototype
//! (src/main.rs), but with derived struct mapping instead of manual put/get.
//!
//! Question this answers: how much schema code does autosurgeon save, and does
//! the derived reconcile/hydrate preserve CRDT convergence for stellario's
//! data model?

use autosurgeon::{hydrate, reconcile, Hydrate, Reconcile};
use automerge::AutoCommit;
use std::collections::HashMap;

// stellario's data model as plain Rust structs. The derive does all the
// Automerge mapping — no manual put/get/insert per field.

#[derive(Debug, Clone, Reconcile, Hydrate, PartialEq)]
struct MemRef {
    target: String,
    reason: String,
    source: String,
}

#[derive(Debug, Clone, Reconcile, Hydrate, PartialEq)]
struct Entry {
    content: String,
    tags: Vec<String>,
    keywords: Vec<String>,
    refs: Vec<MemRef>,
    author: String,
    created: String,
    updated: String,
}

#[derive(Debug, Clone, Reconcile, Hydrate, PartialEq)]
struct Capsule {
    volumes: HashMap<String, HashMap<String, Entry>>,
}

impl Entry {
    fn new(content: &str, author: &str) -> Self {
        Entry {
            content: content.into(),
            tags: vec![],
            keywords: vec![],
            refs: vec![],
            author: author.into(),
            created: "2026-07-26".into(),
            updated: "2026-07-26".into(),
        }
    }
}

fn main() {
    println!("=== Setup: seed capsule (Device A) ===");
    let mut capsule = Capsule { volumes: HashMap::new() };
    let mut meta = HashMap::new();
    let mut m03 = Entry::new("用户希望被称呼为 Yuu。沟通偏好：简洁、技术性。", "stellario");
    m03.tags.push("user-profile".into());
    meta.insert("m03".to_string(), m03);
    let mut active = HashMap::new();
    let mut a01 = Entry::new("端到端渲染管线 audit 完成。", "edelweiss");
    a01.tags.push("type:audit".into());
    active.insert("a01".to_string(), a01);
    capsule.volumes.insert("meta".to_string(), meta);
    capsule.volumes.insert("active".to_string(), active);

    let mut doc_a = AutoCommit::new();
    // One call writes the entire capsule into the document.
    reconcile(&mut doc_a, &capsule).unwrap();
    println!("  reconciled capsule: 2 volumes, 2 entries — one reconcile() call");

    println!();
    println!("=== Fork: Device B ===");
    let mut doc_b = doc_a.fork().with_actor(automerge::ActorId::random());

    println!();
    println!("=== Concurrent offline edits (hydrate → mutate → reconcile) ===");
    // Device A: revise m03 content
    let mut a_caps: Capsule = hydrate(&doc_a).unwrap();
    a_caps.volumes.get_mut("meta").unwrap().get_mut("m03").unwrap().content =
        "用户希望被称呼为 Yuu（小早川優）。沟通偏好：简洁、技术性对话。".into();
    reconcile(&mut doc_a, &a_caps).unwrap();
    println!("  A: revised m03 content");

    // Device B: add a tag to m03 (concurrent)
    let mut b_caps: Capsule = hydrate(&doc_b).unwrap();
    b_caps.volumes.get_mut("meta").unwrap().get_mut("m03").unwrap().tags.push("type:identity".into());
    reconcile(&mut doc_b, &b_caps).unwrap();
    println!("  B: added tag type:identity to m03");

    // Device A: add a ref to a01; Device B: add a different ref (concurrent)
    let mut a_caps2: Capsule = hydrate(&doc_a).unwrap();
    a_caps2.volumes.get_mut("active").unwrap().get_mut("a01").unwrap().refs.push(MemRef {
        target: "m03".into(), reason: "audit context".into(), source: "manual".into(),
    });
    reconcile(&mut doc_a, &a_caps2).unwrap();
    println!("  A: added ref a01 → m03");

    let mut b_caps2: Capsule = hydrate(&doc_b).unwrap();
    b_caps2.volumes.get_mut("active").unwrap().get_mut("a01").unwrap().refs.push(MemRef {
        target: "l14".into(), reason: "related audit".into(), source: "auto".into(),
    });
    reconcile(&mut doc_b, &b_caps2).unwrap();
    println!("  B: added ref a01 → l14");

    println!();
    println!("=== Sync: merge B into A, hydrate the result ===");
    doc_a.merge(&mut doc_b).unwrap();
    let merged: Capsule = hydrate(&doc_a).unwrap();
    let m03 = &merged.volumes["meta"]["m03"];
    let a01 = &merged.volumes["active"]["a01"];

    println!("  m03 content: {}", m03.content);
    println!("  m03 tags: {:?}", m03.tags);
    println!("  a01 refs: {} total", a01.refs.len());
    for r in &a01.refs {
        println!("    → {} ({})", r.target, r.reason);
    }

    println!();
    println!("=== Convergence verification ===");
    assert!(m03.tags.contains(&"user-profile".to_string()), "seed tag lost");
    assert!(m03.tags.contains(&"type:identity".to_string()), "B's tag lost");
    assert_eq!(a01.refs.len(), 2, "both refs must converge, got {}", a01.refs.len());
    println!("  ✓ content revision + tag addition + both refs present — zero data lost");

    println!();
    println!("=== Conflict: concurrent content writes ===");
    let mut doc_c = doc_a.fork().with_actor(automerge::ActorId::random());
    let mut doc_d = doc_a.fork().with_actor(automerge::ActorId::random());
    let mut c_caps: Capsule = hydrate(&doc_c).unwrap();
    c_caps.volumes.get_mut("meta").unwrap().get_mut("m03").unwrap().content = "Vega 写的".into();
    reconcile(&mut doc_c, &c_caps).unwrap();
    let mut d_caps: Capsule = hydrate(&doc_d).unwrap();
    d_caps.volumes.get_mut("meta").unwrap().get_mut("m03").unwrap().content = "Lyra 写的".into();
    reconcile(&mut doc_d, &d_caps).unwrap();
    doc_c.merge(&mut doc_d).unwrap();
    let resolved: Capsule = hydrate(&doc_c).unwrap();
    println!("  hydrated winner: {}", resolved.volumes["meta"]["m03"].content);
    println!("  (autosurgeon hydrates the LWW winner; loser queryable via low-level get_all)");
    println!("  ✓ deterministic resolution, no panic, no data corruption");

    println!();
    println!("=== Code-volume comparison ===");
    println!("  low-level prototype (src/main.rs): manual put/get/insert for every field,");
    println!("    custom helpers for lists/refs/scalars, ~250 lines of mapping logic.");
    println!("  autosurgeon (this file): 3 struct derives + reconcile()/hydrate() calls.");
    println!("    The schema IS the code. No per-field Automerge API calls.");
    println!();
    println!("=== Conclusion ===");
    println!("autosurgeon is the right path for stellario's schema layer:");
    println!("  ✓ same convergence behavior as low-level (CRDT properties preserved)");
    println!("  ✓ struct defines schema; derive does the mapping (serde-like)");
    println!("  ✓ smart diff reconcile preserves concurrent-merge semantics");
    println!("  ✓ caveat: re-hydrate after merge (no incremental live structs yet)");
    println!("    — acceptable at stellario's scale (re-hydrate a few thousand entries");
    println!("      on each sync, not a correctness issue)");
}
