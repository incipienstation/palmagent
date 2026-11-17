use super::domain::Session;

pub trait SessionRepository: Send {
    fn session(&mut self, token: &str) -> anyhow::Result<Option<Session>>;
}
pub trait SessionReader: Send {
    fn valid(&mut self, token: &str, now: i64, ttl_ms: i64) -> anyhow::Result<bool>;
}
pub struct SessionService {
    repository: Box<dyn SessionRepository>,
}
impl SessionService {
    pub fn new(repository: Box<dyn SessionRepository>) -> Self {
        Self { repository }
    }
}
impl SessionReader for SessionService {
    fn valid(&mut self, token: &str, now: i64, ttl_ms: i64) -> anyhow::Result<bool> {
        Ok(self
            .repository
            .session(token)?
            .is_some_and(|session| session.valid(now, ttl_ms)))
    }
}
