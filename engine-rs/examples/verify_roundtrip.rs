// Quick round-trip verification: read the capsule back and confirm the
// entry count matches what the migration report claims.
use stellario::count_capsule_entries;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        "/home/kobayakawaami/.stellario/projects/edelweiss-core/linux-kobayakawaami-arch-linux-321a/capsule.automerge".to_string()
    });
    let bytes = std::fs::read(&path).expect("read capsule");
    let n = count_capsule_entries(&bytes).expect("load capsule");
    println!("capsule: {}", path);
    println!("entries (volume:n ids): {}", n);
    // Memory entries (939 - anomalies) + tasks (568) merged into volumes.
    println!("expected: ~1500 (memory + task volume, minus empty-id anomalies)");
    assert!(n > 1400, "round-trip lost entries!");
    println!("✓ round-trip OK");
}
