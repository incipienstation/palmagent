//! Parse Rust syntax so grouped imports, aliases, re-exports and qualified paths share the same rules.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use syn::{
    UseTree,
    visit::{self, Visit},
};

fn files(directory: &Path, output: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files(&path, output);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            output.push(path);
        }
    }
}
fn imports(tree: &UseTree, prefix: Vec<String>, output: &mut Vec<Vec<String>>) {
    match tree {
        UseTree::Path(path) => {
            let mut prefix = prefix;
            prefix.push(path.ident.to_string());
            imports(&path.tree, prefix, output);
        }
        UseTree::Name(name) => {
            let mut prefix = prefix;
            prefix.push(name.ident.to_string());
            output.push(prefix);
        }
        UseTree::Rename(name) => {
            let mut prefix = prefix;
            prefix.push(name.ident.to_string());
            output.push(prefix);
        }
        UseTree::Glob(_) => output.push(prefix),
        UseTree::Group(group) => {
            for tree in &group.items {
                imports(tree, prefix.clone(), output);
            }
        }
    }
}
struct Dependencies {
    paths: Vec<Vec<String>>,
    alternate_module_path: bool,
}
impl<'ast> Visit<'ast> for Dependencies {
    fn visit_item_use(&mut self, item: &'ast syn::ItemUse) {
        imports(&item.tree, vec![], &mut self.paths);
    }
    fn visit_path(&mut self, path: &'ast syn::Path) {
        self.paths
            .push(path.segments.iter().map(|s| s.ident.to_string()).collect());
        visit::visit_path(self, path);
    }
    fn visit_attribute(&mut self, attribute: &'ast syn::Attribute) {
        if attribute.path().is_ident("path") {
            self.alternate_module_path = true;
        }
        visit::visit_attribute(self, attribute);
    }
}
fn resolve(from: &str, path: &[String]) -> Option<String> {
    if path.len() == 1 && path[0] == "self" {
        return None;
    }
    let mut parts: Vec<_> = from
        .trim_end_matches(".rs")
        .split('/')
        .map(str::to_owned)
        .collect();
    parts.pop();
    let mut path = path;
    match path.first()?.as_str() {
        "crate" | "palmagent_runtime" => {
            parts.clear();
            path = &path[1..];
        }
        "super" => {
            while path.first().is_some_and(|part| part == "super") {
                parts.pop();
                path = &path[1..];
            }
        }
        "self" => {
            path = &path[1..];
        }
        _ => return None,
    }
    parts.extend_from_slice(path);
    Some(parts.join("/"))
}
fn layer(path: &str) -> &'static str {
    if ["main.rs", "lib.rs", "composition.rs"].contains(&path) {
        "composition"
    } else if path == "platform.rs" || path.starts_with("platform/") {
        "platform"
    } else if path.ends_with("/mod.rs") {
        "assembly"
    } else if path == "modules/routines/domain.rs" || path.starts_with("modules/routines/domain/") {
        "domain"
    } else if path == "modules/routines/application.rs"
        || path.starts_with("modules/routines/application/")
    {
        "application"
    } else if path.starts_with("modules/routines/adapters/inbound/") {
        "inbound"
    } else if path.starts_with("modules/routines/adapters/outbound/") {
        "outbound"
    } else {
        panic!("Unclassified native source: {path}")
    }
}
fn cyclic(
    node: &str,
    graph: &BTreeMap<String, BTreeSet<String>>,
    active: &mut BTreeSet<String>,
    done: &mut BTreeSet<String>,
) {
    if done.contains(node) {
        return;
    }
    assert!(
        active.insert(node.to_owned()),
        "Native dependency cycle at {node}"
    );
    for next in graph.get(node).into_iter().flatten() {
        cyclic(next, graph, active, done);
    }
    active.remove(node);
    done.insert(node.to_owned());
}

#[test]
fn architecture_boundaries() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sources = Vec::new();
    files(&root, &mut sources);
    let names: BTreeSet<_> = sources
        .iter()
        .map(|path| {
            path.strip_prefix(&root)
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    let mut graph = BTreeMap::<String, BTreeSet<String>>::new();
    for file in sources {
        let name = file.strip_prefix(&root).unwrap().to_str().unwrap();
        let from = layer(name);
        let syntax = syn::parse_file(&fs::read_to_string(&file).unwrap()).unwrap();
        let mut dependencies = Dependencies {
            paths: vec![],
            alternate_module_path: false,
        };
        dependencies.visit_file(&syntax);
        assert!(
            !dependencies.alternate_module_path,
            "Alternate module paths bypass ownership: {name}"
        );
        for path in dependencies.paths {
            if ["domain", "application"].contains(&from) {
                let host = ["tokio", "axum", "rusqlite", "libc"].contains(&path[0].as_str())
                    || path[0] == "std"
                        && path.get(1).is_some_and(|p| {
                            ["fs", "io", "net", "process", "thread", "env", "time"]
                                .contains(&p.as_str())
                        });
                assert!(
                    !host,
                    "Core imports host technology: {name}: {}",
                    path.join("::")
                );
            }
            let Some(mut resolved) = resolve(name, &path) else {
                continue;
            };
            let target = loop {
                if names.contains(&format!("{resolved}.rs")) {
                    break Some(format!("{resolved}.rs"));
                }
                if names.contains(&format!("{resolved}/mod.rs")) {
                    break Some(format!("{resolved}/mod.rs"));
                }
                let Some((parent, _)) = resolved.rsplit_once('/') else {
                    break None;
                };
                resolved = parent.to_owned();
            };
            let Some(target) = target else {
                continue;
            };
            if target == name {
                continue;
            }
            let to = layer(&target);
            let permitted = match from {
                "domain" => to == "domain",
                "application" => ["domain", "application"].contains(&to),
                "inbound" => ["domain", "application", "inbound", "platform"].contains(&to),
                "outbound" => ["domain", "application", "outbound", "platform"].contains(&to),
                "platform" => to == "platform",
                "assembly" => false,
                _ => true,
            };
            assert!(permitted, "Native layer violation: {name} -> {target}");
            graph.entry(name.to_owned()).or_default().insert(target);
        }
    }
    let mut done = BTreeSet::new();
    for node in graph.keys() {
        cyclic(node, &graph, &mut BTreeSet::new(), &mut done);
    }
}
