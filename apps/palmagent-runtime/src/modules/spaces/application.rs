use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRecord {
    pub id: String,
    pub name: String,
    pub path: String,
    pub vcs: String,
    pub default_base_ref: String,
    pub created_at: i64,
}

/// Mutations accepted by the release-matched owner after recovery commits.
/// Paths and branch names have already been resolved by the host.
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CatalogMutation {
    Register(SpaceRecord),
    RegisterIfAbsent(SpaceRecord),
    SetBaseRef { id: String, base_ref: String },
    Remove { id: String },
}
