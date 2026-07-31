use automerge::{AutoCommit, ObjType, ReadDoc, transaction::Transactable};
use std::collections::HashMap;

#[derive(autosurgeon::Reconcile, autosurgeon::Hydrate, PartialEq, Debug, Clone)]
struct Version { hash: String, content: String }
#[derive(autosurgeon::Reconcile, autosurgeon::Hydrate, PartialEq, Debug, Clone, Default)]
struct Capsule {
    versions: HashMap<String, Version>,
    volumes: HashMap<String, HashMap<String, Vec<String>>>,  // volume -> id -> [hashes]
}

fn main() {
    let mut doc = AutoCommit::new();
    let mut cap = Capsule {
        versions: HashMap::new(),
        volumes: HashMap::new(),
    };
    cap.volumes.entry("active".into()).or_default().entry("65".into()).or_default().push("abc".into());
    cap.versions.insert("abc".into(), Version{hash:"abc".into(), content:"hi".into()});
    autosurgeon::reconcile(&mut doc, &cap).unwrap();

    // Add another version to existing id
    let mut cap2: Capsule = autosurgeon::hydrate(&doc).unwrap();
    cap2.volumes.get_mut("active").unwrap().get_mut("65").unwrap().push("def".into());
    cap2.versions.insert("def".into(), Version{hash:"def".into(), content:"hi2".into()});
    autosurgeon::reconcile(&mut doc, &cap2).unwrap();

    let cap3: Capsule = autosurgeon::hydrate(&doc).unwrap();
    println!("active:65 versions: {:?}", cap3.volumes["active"]["65"]);
    println!("versions stored: {}", cap3.versions.len());
}
