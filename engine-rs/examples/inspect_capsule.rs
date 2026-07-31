// Inspect the migrated capsule: dump the actual map keys + a sample entry.
use automerge::{AutoCommit, ReadDoc, Value};

fn scalar_str(v: &automerge::ScalarValue) -> String {
    match v {
        automerge::ScalarValue::Str(s) => s.to_string(),
        other => format!("{:?}", other),
    }
}

fn main() {
    let bytes = std::fs::read(
        "/home/kobayakawaami/.stellario/projects/edelweiss-core/linux-kobayakawaami-arch-linux-321a/capsule.automerge",
    ).unwrap();
    let doc = AutoCommit::load(&bytes).unwrap();

    let (_, volumes) = doc.get(automerge::ROOT, "volumes").unwrap().unwrap();

    println!("=== volume names ===");
    let vols: Vec<String> = doc.keys(&volumes).collect();
    println!("{:?}", vols);

    println!("\n=== meta volume: first 5 keys ===");
    let (_, meta) = doc.get(&volumes, "meta").unwrap().unwrap();
    let meta_keys: Vec<String> = doc.keys(&meta).collect();
    for k in meta_keys.iter().take(5) { println!("  {}", k); }

    println!("\n=== task volume: first 5 keys ===");
    let (_, task_vol) = doc.get(&volumes, "task").unwrap().unwrap();
    let task_keys: Vec<String> = doc.keys(&task_vol).collect();
    for k in task_keys.iter().take(5) { println!("  {}", k); }
    println!("  ... total task keys: {}", task_keys.len());

    // Show one task entry fully
    if let Some(k) = task_keys.first() {
        println!("\n=== full entry: {} ===", k);
        let (_, t) = doc.get(&task_vol, k).unwrap().unwrap();
        for field in ["id","volume","content","author","created","updated"] {
            if let Some((Value::Scalar(s), _)) = doc.get(&t, field).unwrap() {
                let v = scalar_str(&s);
                println!("  {}: {}", field, v.chars().take(70).collect::<String>());
            }
        }
        // tags
        if let Some((_, tags_obj)) = doc.get(&t, "tags").unwrap() {
            let tags: Vec<String> = (0..doc.length(&tags_obj))
                .filter_map(|i| match doc.get(&tags_obj, i).unwrap() {
                    Some((Value::Scalar(s), _)) => Some(scalar_str(&s)),
                    _ => None,
                }).collect();
            println!("  tags: {:?}", tags);
        }
        // refs
        if let Some((_, refs_obj)) = doc.get(&t, "refs").unwrap() {
            println!("  refs count: {}", doc.length(&refs_obj));
        }
    }
}
