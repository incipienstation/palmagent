#[path = "support/architecture.rs"]
mod architecture;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
fn sources(root: &Path, directory: &Path, output: &mut BTreeMap<String, String>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(root, &path, output);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            output.insert(
                path.strip_prefix(root)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .replace('\\', "/"),
                fs::read_to_string(path).unwrap(),
            );
        }
    }
}
#[test]
fn architecture_boundaries() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = BTreeMap::new();
    sources(&root, &root, &mut files);
    // Cargo owns dependency names, including renamed crates. No network or builds are
    // needed; failure to inventory dependencies must fail the check rather than skip it.
    let metadata = std::process::Command::new("cargo")
        .args([
            "metadata",
            "--no-deps",
            "--format-version",
            "1",
            "--locked",
            "--offline",
            "--manifest-path",
        ])
        .arg(root.parent().unwrap().join("Cargo.toml"))
        .output()
        .expect("read Cargo dependency metadata");
    assert!(
        metadata.status.success(),
        "{}",
        String::from_utf8_lossy(&metadata.stderr)
    );
    let metadata: serde_json::Value = serde_json::from_slice(&metadata.stdout).unwrap();
    let package = metadata["packages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|package| package["name"] == "palmagent-runtime")
        .unwrap();
    let dependencies: BTreeSet<_> = package["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|dependency| {
            dependency["rename"]
                .as_str()
                .unwrap_or(dependency["name"].as_str().unwrap())
                .replace('-', "_")
        })
        .collect();
    let failures = architecture::check(&files, &dependencies);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
fn check(files: &[(&str, &str)]) -> Vec<String> {
    architecture::check(
        &files
            .iter()
            .map(|(name, source)| (name.to_string(), source.to_string()))
            .collect(),
        &["tokio", "axum", "rusqlite", "future_io", "renamed_io"]
            .into_iter()
            .map(str::to_owned)
            .collect(),
    )
}
#[test]
fn rejects_relative_qualified_grouped_and_macro_boundary_bypasses() {
    for source in [
        "use super::adapters::outbound::Store;",
        "use crate::modules::tasks::adapters::{outbound::{self as store, Store as Alias}};",
        "fn policy() { crate::modules::tasks::adapters::outbound::write(); }",
        "fn policy() { example!(crate::modules::tasks::adapters::outbound::write()); }",
        "mod nested { use super::super::adapters::outbound::Store; }",
    ] {
        assert!(
            check(&[
                ("modules/tasks/domain.rs", source),
                ("modules/tasks/adapters/outbound/mod.rs", "")
            ])
            .iter()
            .any(|failure| failure.contains("layer violation")),
            "{source}"
        );
    }
    for source in [
        "use std::{fs as storage};",
        "extern crate tokio as runtime;",
        "use future_io::Client;",
        "fn policy() { renamed_io::open(); }",
        "fn policy() { example!(std::fs::read(\"x\")); }",
    ] {
        assert!(
            check(&[("modules/tasks/application/mod.rs", source)])
                .iter()
                .any(|failure| failure.contains("host technology")),
            "{source}"
        );
    }
}
#[test]
fn accepts_core_ports_and_feature_api_but_rejects_internal_access_and_cycles() {
    let files = [
        (
            "modules/tasks/application.rs",
            "use self::ports::Store; use crate::modules::spaces::api::Space;",
        ),
        ("modules/tasks/application/ports.rs", "pub trait Store {}"),
        ("modules/tasks/domain.rs", "pub struct Task;"),
        ("modules/tasks/api.rs", "pub use super::domain::Task;"),
        ("modules/spaces/api.rs", "pub use super::domain::Space;"),
        ("modules/spaces/domain.rs", "pub struct Space;"),
    ];
    assert!(check(&files).is_empty(), "{:?}", check(&files));
    let mut internal = files.to_vec();
    internal[0].1 = "use crate::modules::spaces::domain::Space;";
    assert!(
        check(&internal)
            .iter()
            .any(|failure| failure.contains("layer violation"))
    );
    let mut cyclic = files.to_vec();
    cyclic.push((
        "modules/spaces/application.rs",
        "use crate::modules::tasks::api::Task;",
    ));
    assert!(
        check(&cyclic)
            .iter()
            .any(|failure| failure.contains("feature dependency cycle"))
    );
    assert!(
        check(&[
            ("modules/tasks/application.rs", "use self::ports::Store;"),
            ("modules/tasks/application/ports.rs", "use super::Service;")
        ])
        .iter()
        .any(|failure| failure.contains("source dependency cycle"))
    );
}
#[test]
fn rejects_unclassified_sources_and_ownership_escape_hatches() {
    for (path, source, message) in [
        ("modules/tasks/misc.rs", "", "Unclassified"),
        ("misc/mod.rs", "", "Unclassified"),
        (
            "lib.rs",
            "pub use modules::tasks::adapters::outbound::Store;",
            "only declare modules",
        ),
        (
            "modules/tasks/application.rs",
            "use crate as backend;",
            "Whole-crate imports",
        ),
        (
            "modules/tasks/application.rs",
            "extern crate self as backend;",
            "whole-crate aliases",
        ),
        (
            "modules/tasks/mod.rs",
            "pub mod hidden { fn work() {} }",
            "only declare modules",
        ),
        (
            "modules/tasks/mod.rs",
            "pub fn hidden() {}",
            "only declare modules",
        ),
        (
            "modules/tasks/api.rs",
            "pub use super::adapters::outbound::Store;",
            "layer violation",
        ),
        (
            "modules/tasks/domain.rs",
            "#[path=\"other.rs\"] mod hidden;",
            "alternate module",
        ),
        (
            "modules/tasks/domain.rs",
            "#[cfg_attr(unix, path=\"other.rs\")] mod hidden;",
            "alternate module",
        ),
        (
            "modules/tasks/domain.rs",
            "include!(\"other.rs\");",
            "include!",
        ),
    ] {
        assert!(
            check(&[(path, source), ("modules/tasks/adapters/outbound.rs", "")])
                .iter()
                .any(|failure| failure.contains(message)),
            "{path}: {source}"
        );
    }
}
