// Verify the evolution-graph storage: materialize (current view), lineage
// (version+intent timeline), and edges (typed relations) on a real migrated
// capsule. Also exercises a live supersede write to confirm the full cycle.
use stellario::{AutomergeStorage, Edge, EdgeKind, Storage};

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        "/home/kobayakawaami/.stellario/projects/edelweiss-core/linux-kobayakawaami-arch-linux-321a/capsule.automerge".to_string()
    });
    let bytes = std::fs::read(&path).expect("read capsule");
    let mut store = AutomergeStorage::load(&bytes).expect("load capsule");

    // 1. materialize: pick a known migrated entry. meta:03 exists in real data.
    println!("=== materialize meta:03 ===");
    match store.materialize("meta", "03") {
        Ok(Some(e)) => {
            println!("  id:     {}", e.id);
            println!("  hash:   {}", e.hash);
            println!("  author: {}", e.author);
            println!("  content[:70]: {}", e.content.chars().take(70).collect::<String>());
        }
        Ok(None) => println!("  (meta:03 not found — trying meta:05)"),
        Err(e) => println!("  error: {e}"),
    }

    // 2. lineage: the version+intent timeline of one id.
    println!("\n=== lineage meta:03 ===");
    match store.lineage("meta", "03") {
        Ok(steps) => {
            println!("  {} versions", steps.len());
            for s in &steps {
                println!("    {}  intent: {}", s.version.hash, if s.intent.is_empty() { "(none)" } else { &s.intent });
                println!("           superseded: {}", s.version.superseded);
            }
        }
        Err(e) => println!("  error: {e}"),
    }

    // 3. Live supersede write: create a new version that supersedes the current
    //    meta:03, then confirm materialize flips to the new version.
    println!("\n=== live supersede cycle ===");
    let current = store.materialize("meta", "03").expect("materialize").expect("exists");
    let supersede_edge = Edge {
        from: String::new(), // filled by write()
        to: current.hash.clone(),
        kind: EdgeKind::Supersede,
        reason: "verification: overturning for test".into(),
    };
    let (new_id, new_hash) = store
        .write(
            "meta", Some("03"),
            "## Superseded for evolution verification\nThis version overturns the prior.",
            &["type:test".to_string()],
            &[],
            "verifier",
            "testing the supersede write path",
            &[],
            &[supersede_edge],
        )
        .expect("write supersede");
    let _ = new_id;
    println!("  wrote new version hash: {}", new_hash);

    let after = store.materialize("meta", "03").expect("materialize after");
    println!("  materialized hash after supersede: {}", after.as_ref().map(|e| e.hash.as_str()).unwrap_or("(none)"));
    assert_eq!(after.as_ref().map(|e| e.hash.as_str()), Some(new_hash.as_str()), "materialize should now return the new version");
    let new_hash = new_hash.clone();

    // old version should be marked superseded
    let lineage = store.lineage("meta", "03").expect("lineage");
    let old = lineage.iter().find(|s| s.version.hash == current.hash).expect("old version in lineage");
    assert!(old.version.superseded, "old version must be marked superseded");
    println!("  ✓ old version {} marked superseded", current.hash);

    // intent recorded on the new version's parent edge
    let new_step = lineage.iter().find(|s| s.version.hash == new_hash).expect("new version in lineage");
    println!("  new version intent: {:?}", new_step.intent);

    // supersede edge should be queryable
    let edges_from_new = store.edges_from(&new_hash).expect("edges_from");
    let has_supersede = edges_from_new.iter().any(|e| e.kind == EdgeKind::Supersede);
    assert!(has_supersede, "supersede edge must be recorded");
    println!("  ✓ supersede edge queryable ({} edges from new version)", edges_from_new.len());

    println!("\n✓ evolution storage verified: materialize / lineage / write / supersede");
}
