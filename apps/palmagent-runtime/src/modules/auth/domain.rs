//! Session expiry matches the retained login owner; reads never extend a login.
pub struct Session {
    pub created_at: i64,
    pub expires_at: i64,
}
impl Session {
    pub fn valid(&self, now: i64, ttl_ms: i64) -> bool {
        self.expires_at > now && i128::from(self.created_at) + i128::from(ttl_ms) > i128::from(now)
    }
}
