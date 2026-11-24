use serde::Deserialize;

/// Mutations accepted by the release-matched owner after recovery commits.
/// Paths and branch names have already been resolved by the host.
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CatalogMutation {
    Register {
        id: String,
        name: String,
        path: String,
        vcs: String,
        default_base_ref: String,
        created_at: i64,
    },
    SetBaseRef {
        id: String,
        base_ref: String,
    },
    Remove {
        id: String,
    },
}
