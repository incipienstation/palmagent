use std::{collections::BTreeMap, path::PathBuf};

use serde::{Deserialize, Serialize};

pub const PROTOCOL: u32 = 1;
pub const VERSION: &str = env!("PALMAGENT_PRODUCT_VERSION");
pub const SOURCE_COMMIT: &str = env!("PALMAGENT_SOURCE_COMMIT");

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    pub protocol: u32,
    pub daemon: PathBuf,
    pub release: PathBuf,
    pub node: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub isolation: Isolation,
    pub limits: Limits,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Isolation {
    Cgroup,
    ProcessGroup,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub memory_high: u64,
    pub memory_max: u64,
    pub tasks: u64,
    pub web_tasks: u64,
    pub cpu_percent: u64,
    pub nofile: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Execution,
    Terminal,
    Web,
    Update,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Execution => "execution",
            Self::Terminal => "terminal",
            Self::Web => "web",
            Self::Update => "update",
        }
    }

    pub fn directory(self) -> &'static str {
        match self {
            Self::Execution => "executions",
            Self::Terminal => "terminals",
            Self::Web => "web",
            Self::Update => "updates",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Request {
    Status,
    Launch { kind: Kind, id: String },
    Inspect { kind: Kind, id: String },
    Terminate { kind: Kind, id: String },
    RestartWeb,
    Replace,
    StartUpdate,
    Stop,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Identity {
    pub pid: u32,
    pub start: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Starting,
    Running,
    Exited,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRecord {
    pub protocol: u32,
    pub kind: Kind,
    pub id: String,
    pub state: State,
    pub release: PathBuf,
    pub node: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub isolation: Isolation,
    pub group: Option<PathBuf>,
    pub nofile: u64,
    pub guard: Option<Identity>,
    pub child: Option<Identity>,
    pub exit_code: Option<i32>,
}

#[derive(Deserialize)]
pub struct Descriptor {
    pub protocol: u32,
    pub id: String,
    pub directory: PathBuf,
    pub release: PathBuf,
    pub node: PathBuf,
}

#[derive(Serialize)]
pub struct Reply {
    pub protocol: u32,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Reply {
    pub fn from_result(result: anyhow::Result<serde_json::Value>) -> Self {
        match result {
            Ok(result) => Self {
                protocol: PROTOCOL,
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => Self {
                protocol: PROTOCOL,
                ok: false,
                result: None,
                error: Some(error.to_string()),
            },
        }
    }
}
