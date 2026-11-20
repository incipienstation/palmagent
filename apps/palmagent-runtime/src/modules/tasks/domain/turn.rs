//! Terminal evidence is rebuilt from retained provider output, including replay.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct TurnEvidence {
    pub failure_message: Option<String>,
    result_error: Option<bool>,
    errored: bool,
    abnormal_exit: bool,
}

pub enum TurnEvent<'a> {
    Error(Option<&'a str>),
    Result { failed: bool },
    ProcessExit { success: bool },
    ReattachFailed,
    Output,
}

impl TurnEvidence {
    pub fn observe(&mut self, event: TurnEvent<'_>) {
        match event {
            TurnEvent::Error(message) => {
                self.errored = true;
                if let Some(message) = message {
                    self.failure_message = Some(message.to_owned());
                }
            }
            TurnEvent::Result { failed } => self.result_error = Some(failed),
            TurnEvent::ProcessExit { success } => self.abnormal_exit = !success,
            TurnEvent::ReattachFailed => self.abnormal_exit = true,
            TurnEvent::Output => {}
        }
    }

    pub fn session_mismatch(&mut self) {
        self.errored = true;
        self.abnormal_exit = true;
    }

    pub fn failed(&self, compacting: bool, steer_restart: bool) -> bool {
        compacting && self.result_error.is_none()
            || !steer_restart && (self.abnormal_exit || self.result_error.unwrap_or(self.errored))
    }
}
