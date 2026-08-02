//! cluster — design-thread identification for the layer-scale distill.
//!
//! layer is an evolution record, not a set of independent entries: entries
//! reference each other (lNNN), supersede each other, and cluster by topic.
//! Per-entry distillation would fragment threads — this module identifies
//! candidate clusters so a canonical can be written per design thread.
//!
//! Signal grading (deskcheck A1): supersede/merge edges are HARD signals;
//! shared-keyword grouping is SOFT — candidates only, human/agent confirms
//! cluster membership. Nothing here decides; it surfaces.

use std::collections::{HashMap, HashSet};

use anyhow::Result;
use regex::Regex;

use crate::storage::Storage;

/// One candidate cluster for a canonical.
#[derive(Debug)]
pub struct ClusterCandidate {
    /// A representative name (the longest-standing member's topic word).
    pub name: String,
    /// Member entries (id, title).
    pub members: Vec<(String, String)>,
    /// Hard evidence: connected by supersede/merge/moved edges.
    pub supersede_chain: bool,
    /// Shared significant keyword that grouped it (soft evidence).
    pub keyword: Option<String>,
    /// True when no member shows recent activity (Session markers / recency).
    pub stable: bool,
}

/// Extract lNNN references and supersede-style edges from content.
fn scan(content: &str) -> (Vec<String>, Vec<(String, String)>) {
    let mut refs = Vec::new();
    let mut edges: Vec<(String, String)> = Vec::new(); // (from_id_num, to_id_num)

    let re_ref = Regex::new(r"\bl(\d+)\b").unwrap();
    for cap in re_ref.captures_iter(content) {
        refs.push(cap[1].to_string());
    }

    // supersede/merge/moved edges: "supersedes l22", "moved to lXXX", "merged into lXXX", "取代 l22"
    let re_sup = Regex::new(r"(?i)(supersede[sd]?|superseded by|moved to|merged into|merged with|取代)\s+(?:the\s+)?l(\d+)").unwrap();
    // The current entry's own id is unknown here — the caller pairs edges per entry.
    for cap in re_sup.captures_iter(content) {
        edges.push((String::new(), cap[2].to_string())); // from filled by caller
    }

    (refs, edges)
}

const STOPWORDS: &[&str] = &[
    "设计", "架构", "模型", "实现", "方案", "记录", "决策", "讨论", "分析", "规划", "管线",
    "设计", "system", "model", "design", "session", "plan", "架构", "统一", "新", "完整",
];

fn significant_tokens(title: &str) -> Vec<String> {
    // Chinese: take 2-4 char runs; ASCII: 3+ char words, lowercase.
    let mut out = Vec::new();
    let ascii_re = Regex::new(r"[a-zA-Z]{3,}").unwrap();
    for w in ascii_re.find_iter(title) {
        let t = w.as_str().to_lowercase();
        if !STOPWORDS.contains(&t.as_str()) {
            out.push(t);
        }
    }
    // CJK bigrams: split into 2-char pairs, filter by stopwords.
    let cjk_re = Regex::new(r"[\u4e00-\u9fff]{2,}").unwrap();
    for m in cjk_re.find_iter(title) {
        let s = m.as_str();
        let chars: Vec<char> = s.chars().collect();
        for pair in chars.windows(2) {
            let t: String = pair.iter().collect();
            if !STOPWORDS.contains(&t.as_str()) {
                out.push(t);
            }
        }
    }
    out
}

/// Identify candidate clusters for a volume.
pub fn identify<S: Storage + ?Sized>(storage: &S, volume: &str) -> Result<Vec<ClusterCandidate>> {
    let ids = storage.list(volume)?;
    let mut entries: Vec<(String, String, String)> = Vec::new(); // (num, title, content)
    for id in &ids {
        if let Some(e) = storage.materialize(volume, id)? {
            // entry.id may be "volume:num" or bare; extract the numeric part.
            let num = e
                .id
                .rsplit(':')
                .next()
                .unwrap_or(&e.id)
                .trim_start_matches('l')
                .to_string();
            let title = e
                .content
                .lines()
                .find(|l| l.trim_start().starts_with('#'))
                .map(|l| l.trim_start_matches('#').trim().to_string())
                .unwrap_or_default();
            entries.push((num, title, e.content));
        }
    }

    // ── Hard: supersede/merge chains (union-find) ──
    let mut parent: HashMap<String, String> = HashMap::new();
    let find = |p: &mut HashMap<String, String>, x: &str| -> String {
        let mut cur = x.to_string();
        loop {
            let next = p.get(&cur).cloned();
            match next {
                Some(n) if n != cur => cur = n,
                _ => break,
            }
        }
        cur
    };
    let mut union = |p: &mut HashMap<String, String>, a: &str, b: &str| {
        let ra = find(p, a);
        let rb = find(p, b);
        if ra != rb {
            p.insert(ra, rb);
        }
    };

    let mut edge_count = 0;
    for (num, _t, content) in &entries {
        let (_, edges) = scan(content);
        for (_, to) in edges {
            union(&mut parent, num, &to);
            edge_count += 1;
        }
    }
    let _ = &mut edge_count;

    // ── Soft: significant-token grouping ──
    let mut token_members: HashMap<String, Vec<String>> = HashMap::new(); // token -> member nums
    for (num, title, _) in &entries {
        for t in significant_tokens(title) {
            token_members.entry(t).or_default().push(num.clone());
        }
    }

    // ── Assemble clusters ──
    let mut out: Vec<ClusterCandidate> = Vec::new();
    let mut covered: HashSet<String> = HashSet::new();

    // Chains first (hard evidence).
    let mut chains: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for (num, title, _) in &entries {
        let root = find(&mut parent, num);
        chains.entry(root).or_default().push((num.clone(), title.clone()));
    }
    let mut chain_roots: Vec<String> = chains.keys().cloned().collect();
    chain_roots.sort();
    for root in chain_roots {
        let mut members = chains[&root].clone();
        if members.len() < 2 {
            continue; // singletons are not chains
        }
        members.sort();
        let name = members[0].1.clone();
        for (num, _) in &members {
            covered.insert(num.clone());
        }
        out.push(ClusterCandidate {
            name,
            members,
            supersede_chain: true,
            keyword: None,
            stable: is_stable(&entries, &covered),
        });
    }

    // Keyword groups (soft) for uncovered entries.
    let mut seen_groups: HashSet<String> = HashSet::new();
    let mut groups: Vec<(String, Vec<String>)> = Vec::new(); // (token, member nums)
    for (token, nums) in &token_members {
        let un: Vec<String> = nums.iter().filter(|n| !covered.contains(*n)).cloned().collect();
        if un.len() >= 3 && !seen_groups.contains(token) {
            seen_groups.insert(token.clone());
            groups.push((token.clone(), un));
        }
    }
    groups.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    for (token, nums) in groups {
        let mut members: Vec<(String, String)> = nums
            .iter()
            .map(|n| {
                entries
                    .iter()
                    .find(|(e, _, _)| e == n)
                    .map(|(e, t, _)| (e.clone(), t.clone()))
                    .unwrap_or((n.clone(), String::new()))
            })
            .collect();
        members.sort();
        out.push(ClusterCandidate {
            name: token.clone(),
            members,
            supersede_chain: false,
            keyword: Some(token),
            stable: is_stable(&entries, &nums.iter().cloned().collect()),
        });
    }

    Ok(out)
}

fn is_stable(entries: &[(String, String, String)], member_nums: &HashSet<String>) -> bool {
    // Stability proxy: no member title carries a Session marker (recent activity).
    entries
        .iter()
        .filter(|(n, _, _)| member_nums.contains(n))
        .all(|(_, t, _)| !t.to_lowercase().contains("session"))
}

/// Format the candidate clusters for human/agent confirmation.
pub fn format_clusters(clusters: &[ClusterCandidate]) -> String {
    if clusters.is_empty() {
        return "no clusters found".into();
    }
    let mut out = String::new();
    for (i, c) in clusters.iter().enumerate() {
        let kind = if c.supersede_chain { "chain" } else { "kw" };
        let stab = if c.stable { "stable" } else { "ACTIVE" };
        out.push_str(&format!(
            "{:>2}. [{}] {} ({}) — {} members\n",
            i + 1,
            kind,
            c.name,
            stab,
            c.members.len()
        ));
        for (num, title) in &c.members {
            out.push_str(&format!("      l{num:<5} {title}\n"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::AutomergeStorage;

    fn seed() -> AutomergeStorage {
        let mut s = AutomergeStorage::new();
        // a reverb chain: l22 -> l132 (supersedes l22) -> l133 (cookbook)
        s.write("layer", Some("22"), "## Audio Pipeline — Dual Reverb Context\nsupersedes nothing\n", &[], &[], "a", "s", &[], &[]).unwrap();
        s.write("layer", Some("132"), "## Audio Reverb — Unified Profile\nsupersedes l22 §Core Insight\n", &[], &[], "a", "s", &[], &[]).unwrap();
        s.write("layer", Some("133"), "## CookBook — Reverb Profile\n", &[], &[], "a", "s", &[], &[]).unwrap();
        s
    }

    #[test]
    fn chain_detection() {
        let s = seed();
        let clusters = identify(&s, "layer").unwrap();
        let chains: Vec<_> = clusters.iter().filter(|c| c.supersede_chain).collect();
        assert_eq!(chains.len(), 1, "l22->l132 must form one chain");
        assert_eq!(chains[0].members.len(), 2, "l22 + l132 in the chain (l133 has no edge)");
        assert!(chains[0].stable, "no Session markers");
    }

    #[test]
    fn significant_tokens_skips_stopwords() {
        let toks = significant_tokens("Session 38 实现方案");
        assert!(!toks.iter().any(|t| t == "session" || t == "实现" || t == "方案"),
            "stopwords must be excluded: {toks:?}");
        let toks = significant_tokens("Audio Reverb Profile Model");
        assert!(toks.contains(&"reverb".to_string()), "{toks:?}");
    }
}
