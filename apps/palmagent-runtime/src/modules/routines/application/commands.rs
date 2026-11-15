//! Inbound application commands, independent of HTTP and queue transport.
use serde_json::Value;

pub enum Action {
    Status,
    Telemetry,
    List,
    Get(String),
    Create(Value),
    Update(String, Value),
    Remove(String),
    Run(String),
    Stop(String),
    Runs(String),
    Pending(String),
}
impl Action {
    pub fn operation(&self) -> Option<&'static str> {
        match self {
            Self::Status | Self::Telemetry | Self::Pending(_) => None,
            Self::List | Self::Get(_) | Self::Runs(_) => Some("routine.read"),
            Self::Create(_) => Some("routine.create"),
            Self::Update(_, _) => Some("routine.update"),
            Self::Remove(_) => Some("routine.remove"),
            Self::Run(_) => Some("routine.run"),
            Self::Stop(_) => Some("routine.stop"),
        }
    }
}
