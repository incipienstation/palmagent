//! Source-level guardrail, not a replacement for Rust name resolution or macro expansion.
use std::collections::{BTreeMap, BTreeSet};
use syn::{
    UseTree,
    visit::{self, Visit},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Layer {
    Assembly,
    Composition,
    Platform,
    Kernel,
    Api,
    Domain,
    Application,
    Inbound,
    Outbound,
}
#[derive(Debug)]
struct Location<'a> {
    feature: Option<&'a str>,
    layer: Layer,
}
fn location(path: &str) -> Option<Location<'_>> {
    use Layer::*;
    let layer = match path {
        "main.rs" | "composition.rs" => Composition,
        "lib.rs" => Assembly,
        "modules/mod.rs" => Assembly,
        "platform.rs" => Platform,
        "kernel.rs" => Kernel,
        _ if path.starts_with("platform/") => Platform,
        _ if path.starts_with("kernel/") => Kernel,
        _ if path.starts_with("composition/") => Composition,
        _ => {
            let parts: Vec<_> = path.split('/').collect();
            if parts.len() < 3 || parts[0] != "modules" {
                return None;
            }
            let rest = parts[2..].join("/");
            let layer = match rest.as_str() {
                "mod.rs" | "adapters/mod.rs" => Assembly,
                "api.rs" => Api,
                "composition.rs" => Composition,
                "domain.rs" => Domain,
                "application.rs" => Application,
                "adapters/inbound.rs" => Inbound,
                "adapters/outbound.rs" => Outbound,
                _ if rest.starts_with("domain/") => Domain,
                _ if rest.starts_with("application/") => Application,
                _ if rest.starts_with("adapters/inbound/") => Inbound,
                _ if rest.starts_with("adapters/outbound/") => Outbound,
                _ => return None,
            };
            return Some(Location {
                feature: Some(parts[1]),
                layer,
            });
        }
    };
    Some(Location {
        feature: None,
        layer,
    })
}
fn module(path: &str) -> Vec<String> {
    let stem = path.trim_end_matches(".rs");
    let mut parts: Vec<_> = stem.split('/').map(str::to_owned).collect();
    if ["mod", "lib", "main"].contains(&parts.last().unwrap().as_str()) {
        parts.pop();
    }
    parts
}
fn imports(tree: &UseTree, mut prefix: Vec<String>, output: &mut Vec<Vec<String>>) {
    match tree {
        UseTree::Path(path) => {
            prefix.push(path.ident.to_string());
            imports(&path.tree, prefix, output);
        }
        UseTree::Name(name) => {
            if name.ident != "self" {
                prefix.push(name.ident.to_string());
            }
            output.push(prefix);
        }
        UseTree::Rename(name) => {
            if name.ident != "self" {
                prefix.push(name.ident.to_string());
            }
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
struct Reference {
    import: bool,
    scope: Vec<String>,
    path: Vec<String>,
}
struct Dependencies {
    scope: Vec<String>,
    paths: Vec<Reference>,
    unsupported: Vec<&'static str>,
}
impl Dependencies {
    fn push(&mut self, path: Vec<String>) {
        self.paths.push(Reference {
            import: false,
            scope: self.scope.clone(),
            path,
        });
    }
}
impl<'ast> Visit<'ast> for Dependencies {
    fn visit_item_mod(&mut self, item: &'ast syn::ItemMod) {
        for attribute in &item.attrs {
            self.visit_attribute(attribute);
        }
        if let Some((_, items)) = &item.content {
            self.scope.push(item.ident.to_string());
            for item in items {
                self.visit_item(item);
            }
            self.scope.pop();
        }
    }
    fn visit_item_use(&mut self, item: &'ast syn::ItemUse) {
        let mut paths = vec![];
        imports(&item.tree, vec![], &mut paths);
        for path in paths {
            self.paths.push(Reference {
                import: true,
                scope: self.scope.clone(),
                path,
            });
        }
        for attribute in &item.attrs {
            self.visit_attribute(attribute);
        }
    }
    fn visit_item_extern_crate(&mut self, item: &'ast syn::ItemExternCrate) {
        if item.ident == "self" {
            self.unsupported
                .push("whole-crate aliases bypass feature APIs");
        }
        self.push(vec![item.ident.to_string()]);
    }
    fn visit_path(&mut self, path: &'ast syn::Path) {
        self.push(path.segments.iter().map(|s| s.ident.to_string()).collect());
        visit::visit_path(self, path);
    }
    fn visit_attribute(&mut self, attribute: &'ast syn::Attribute) {
        // cfg_attr can hide a #[path] too. Reject alternate module placement entirely.
        if attribute.path().is_ident("path")
            || (attribute.path().is_ident("cfg_attr") && has_alternate_module_path(attribute))
        {
            self.unsupported
                .push("alternate module paths bypass ownership");
        }
        visit::visit_attribute(self, attribute);
    }
    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        if mac
            .path
            .segments
            .last()
            .is_some_and(|s| s.ident == "include")
        {
            self.unsupported.push("include! bypasses source ownership");
        }
        // syn deliberately does not parse macro input. Inspect explicit paths there as well.
        self.visit_path(&mac.path);
        token_paths(mac.tokens.clone(), &mut |path| self.push(path));
    }
}
fn has_alternate_module_path(attribute: &syn::Attribute) -> bool {
    // Parse cfg_attr's comma-separated arguments, including nested cfg_attr.
    fn contains(meta: &syn::Meta) -> bool {
        if meta.path().is_ident("path") {
            return true;
        }
        if let syn::Meta::List(list) = meta {
            use syn::parse::Parser;
            if let Ok(items) =
                syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated
                    .parse2(list.tokens.clone())
            {
                return items.iter().any(contains);
            }
        }
        false
    }
    contains(&attribute.meta)
}
fn token_paths(tokens: proc_macro2::TokenStream, add: &mut impl FnMut(Vec<String>)) {
    use proc_macro2::TokenTree;
    let tokens: Vec<_> = tokens.into_iter().collect();
    let mut i = 0;
    while i < tokens.len() {
        if let TokenTree::Group(group) = &tokens[i] {
            token_paths(group.stream(), add);
        }
        if let TokenTree::Ident(ident) = &tokens[i] {
            let mut path = vec![ident.to_string()];
            while i + 3 < tokens.len()
                && matches!(&tokens[i + 1], TokenTree::Punct(p) if p.as_char() == ':')
                && matches!(&tokens[i + 2], TokenTree::Punct(p) if p.as_char() == ':')
                && matches!(&tokens[i + 3], TokenTree::Ident(_))
            {
                i += 3;
                if let TokenTree::Ident(ident) = &tokens[i] {
                    path.push(ident.to_string());
                }
            }
            if path.len() > 1 {
                add(path);
            }
        }
        i += 1;
    }
}
fn resolve(reference: &Reference, names: &BTreeMap<Vec<String>, String>) -> Option<String> {
    if reference.path.len() == 1 && !reference.import {
        return None;
    }
    let mut scope = reference.scope.clone();
    let mut path = reference.path.as_slice();
    match path.first()?.as_str() {
        "crate" | "palmagent_runtime" => {
            scope.clear();
            path = &path[1..];
        }
        "self" => {
            path = &path[1..];
        }
        "super" => {
            while path.first().is_some_and(|p| p == "super") {
                scope.pop()?;
                path = &path[1..];
            }
        }
        _ => {
            // Bare local module names and aliases have a lexical scope; external crate names
            // never accidentally become a same-named module in another feature.
            while !scope.is_empty()
                && !names
                    .keys()
                    .any(|name| name.starts_with(&[scope.clone(), vec![path[0].clone()]].concat()))
            {
                scope.pop();
            }
        }
    }
    scope.extend_from_slice(path);
    while !scope.is_empty() {
        if let Some(name) = names.get(&scope) {
            return Some(name.clone());
        }
        scope.pop();
    }
    None
}
fn allowed(from: &Location<'_>, to: &Location<'_>) -> bool {
    use Layer::*;
    if from.layer == Composition
        && (from.feature.is_none() || from.feature == to.feature || to.feature.is_none())
    {
        return true;
    }
    if from.feature != to.feature && to.feature.is_some() {
        return to.layer == Api
            && matches!(from.layer, Application | Inbound | Outbound | Composition);
    }
    match from.layer {
        Domain | Kernel => matches!(to.layer, Domain | Kernel),
        Application => matches!(to.layer, Domain | Application | Kernel),
        Api => matches!(to.layer, Domain | Application | Kernel),
        Inbound => matches!(
            to.layer,
            Domain | Application | Api | Inbound | Platform | Kernel
        ),
        Outbound => matches!(
            to.layer,
            Domain | Application | Api | Outbound | Platform | Kernel
        ),
        Platform => matches!(to.layer, Platform | Kernel),
        Assembly => false,
        Composition => true,
    }
}
fn cycle(graph: &BTreeMap<String, BTreeSet<String>>) -> Option<String> {
    fn walk(
        node: &str,
        graph: &BTreeMap<String, BTreeSet<String>>,
        active: &mut BTreeSet<String>,
        done: &mut BTreeSet<String>,
    ) -> Option<String> {
        if done.contains(node) {
            return None;
        }
        if !active.insert(node.to_owned()) {
            return Some(node.to_owned());
        }
        for next in graph.get(node).into_iter().flatten() {
            if let Some(cycle) = walk(next, graph, active, done) {
                return Some(cycle);
            }
        }
        active.remove(node);
        done.insert(node.to_owned());
        None
    }
    let mut done = BTreeSet::new();
    for node in graph.keys() {
        if let Some(cycle) = walk(node, graph, &mut BTreeSet::new(), &mut done) {
            return Some(cycle);
        }
    }
    None
}
pub fn check(
    sources: &BTreeMap<String, String>,
    external_crates: &BTreeSet<String>,
) -> Vec<String> {
    use Layer::*;
    let names = sources
        .keys()
        .filter(|name| name.as_str() != "main.rs")
        .map(|name| (module(name), name.clone()))
        .collect();
    let mut failures = vec![];
    let mut graph = BTreeMap::<String, BTreeSet<String>>::new();
    let mut features = BTreeMap::<String, BTreeSet<String>>::new();
    for (name, source) in sources {
        let Some(from) = location(name) else {
            failures.push(format!("Unclassified native source: {name}"));
            continue;
        };
        let syntax = match syn::parse_file(source) {
            Ok(syntax) => syntax,
            Err(error) => {
                failures.push(format!("{name}: {error}"));
                continue;
            }
        };
        if from.layer == Assembly
            && syntax
                .items
                .iter()
                .any(|item| !matches!(item, syn::Item::Mod(module) if module.content.is_none()))
        {
            failures.push(format!("Module assembly may only declare modules: {name}"));
        }
        if from.layer == Api
            && syntax
                .items
                .iter()
                .any(|item| !matches!(item, syn::Item::Use(_)))
        {
            failures.push(format!(
                "Feature API may only re-export core contracts: {name}"
            ));
        }
        let mut dependencies = Dependencies {
            scope: module(name),
            paths: vec![],
            unsupported: vec![],
        };
        dependencies.visit_file(&syntax);
        for unsupported in dependencies.unsupported {
            failures.push(format!("{name}: {unsupported}"));
        }
        for reference in dependencies.paths {
            let path = &reference.path;
            if path.is_empty() {
                continue;
            }
            if reference.import
                && path.len() == 1
                && ["crate", "palmagent_runtime"].contains(&path[0].as_str())
            {
                failures.push(format!("Whole-crate imports bypass feature APIs: {name}"));
            }
            if matches!(from.layer, Domain | Application | Kernel | Api) {
                // New direct Cargo dependencies require an explicit core allowance, even
                // when the checker has never seen that technology before.
                let host = external_crates.contains(&path[0])
                    && !["anyhow", "serde", "serde_json"].contains(&path[0].as_str())
                    || path[0] == "std"
                        && path.get(1).is_none_or(|part| {
                            ["fs", "io", "net", "process", "thread", "env", "time", "os"]
                                .contains(&part.as_str())
                        });
                if host {
                    failures.push(format!(
                        "Core imports host technology: {name}: {}",
                        path.join("::")
                    ));
                }
            }
            let Some(target) = resolve(&reference, &names) else {
                continue;
            };
            if target == *name {
                continue;
            }
            let Some(to) = location(&target) else {
                continue;
            };
            if !allowed(&from, &to) {
                failures.push(format!(
                    "Native layer violation: {name} -> {target} ({})",
                    path.join("::")
                ));
            }
            graph
                .entry(name.clone())
                .or_default()
                .insert(target.clone());
            if let (Some(a), Some(b)) = (from.feature, to.feature)
                && a != b
            {
                features
                    .entry(a.to_owned())
                    .or_default()
                    .insert(b.to_owned());
            }
        }
    }
    if let Some(node) = cycle(&graph) {
        failures.push(format!("Native source dependency cycle at {node}"));
    }
    if let Some(node) = cycle(&features) {
        failures.push(format!("Native feature dependency cycle at {node}"));
    }
    failures.sort();
    failures.dedup();
    failures
}
